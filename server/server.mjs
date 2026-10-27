/**
 * 大肥鱼工具箱 · 本地服务
 * ------------------------------------------------------------
 * 零依赖（只用 Node 内置模块）。职责：
 *   1. 托管 web/ 静态界面
 *   2. 一键启动 / 停止 大肥鱼（SnowLuma + AstrBot）
 *   3. 一键启动 / 停止 MCSManager（daemon + web）
 *   4. MCS 免密登录：后端替你登录，把 session cookie 转发给浏览器
 *      （cookie 不区分端口，所以浏览器拿着它访问 23333 就是已登录）
 *
 * 只监听 127.0.0.1，不对外。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { Downloader } from './downloader.mjs';
import { MIRRORS, MIRROR_BY_ID, GROUPS } from './components.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(APP_ROOT, 'web');
const LOG_DIR = path.join(APP_ROOT, 'logs');
const CFG_FILE = path.join(__dirname, 'config.json');

// 便携布局：组件都装在 <安装根>/components/ 下，下载缓存和日志放 <安装根>/data/
const COMPONENTS_ROOT = path.join(APP_ROOT, 'components');
const PORTABLE_DATA = path.join(APP_ROOT, 'data');
const DOWNLOAD_ROOT = path.join(PORTABLE_DATA, 'downloads');
// 绿色版自带的 Node 运行时（打包时一起带上，朋友电脑不用装 Node）
const RUNTIME_NODE = path.join(APP_ROOT, 'runtime', 'node.exe');

// 工具箱自己的版本号（"关于"页和更新检查都读它）
const TOOLBOX_VERSION = '1.2.2';

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PORTABLE_DATA, { recursive: true });

// 桌面启动器靠这个文件判断「跑着的进程是不是旧代码」：
// 服务每次起来都刷一次修改时间，启动器拿它和 server/server.mjs 比，
// 代码更新了就自动换掉旧进程，省得每次改完后端都要手动结束进程。
const BOOT_STAMP = path.join(PORTABLE_DATA, 'boot.stamp');

// ---------------------------------------------------------------- 配置

const DEFAULT_CFG = {
  port: 8788,
  // 留空 = 走便携布局（<安装根>/components）。填了绝对路径则优先用旧的固定布局。
  paths: { dafeiyu: '', mcs: '', node: '' },
  appearance: { theme: 'light', accent: 'blue' },
  download: { mirror: 'auto' },
  mcsAccount: { username: '', password: '' },
};

function readCfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    return {
      ...DEFAULT_CFG,
      ...raw,
      paths: { ...DEFAULT_CFG.paths, ...(raw.paths || {}) },
      appearance: { ...DEFAULT_CFG.appearance, ...(raw.appearance || {}) },
      download: { ...DEFAULT_CFG.download, ...(raw.download || {}) },
      mcsAccount: { ...DEFAULT_CFG.mcsAccount, ...(raw.mcsAccount || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CFG));
  }
}

function writeCfg(cfg) {
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

if (!fs.existsSync(CFG_FILE)) {
  // 绿色版第一次跑：从模板复制一份干净配置（不含任何人的账号）
  const example = path.join(__dirname, 'config.example.json');
  if (fs.existsSync(example)) {
    try { fs.copyFileSync(example, CFG_FILE); } catch { /* 下面还有兜底 */ }
  }
  if (!fs.existsSync(CFG_FILE)) writeCfg(DEFAULT_CFG);
}

// ---------------------------------------------------------------- 布局解析
/**
 * 同一个工具要能跑在两种环境里：
 *   ① 便携布局（推荐，发给别人的绿色包）：组件都解压在
 *      <安装根>/components/{snowluma,astrbot,mcsmanager}
 *   ② 旧布局（组件装在别处）：路径写在 server/config.json 的 paths 里，
 *      例如各组件分别放在自己喜欢的位置，data 也可以单独指定。
 * 所以路径一律"探测"而不是"假设"：先找便携位置，再退回配置里写的老路径。
 */

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** AstrBot 可能直接是程序目录，也可能套了一层 AstrBot_4.29.x_windows_amd64_portable */
function astrBotPackOf(base) {
  if (!base || !fs.existsSync(base)) return null;
  if (fs.existsSync(path.join(base, 'AstrBot.exe'))) return base;
  try {
    const sub = fs.readdirSync(base).find(
      (n) => n.startsWith('AstrBot_') && fs.statSync(path.join(base, n)).isDirectory()
    );
    if (sub) return path.join(base, sub);
  } catch { /* ignore */ }
  return null;
}

function resolveLayout() {
  const cfg = readCfg();
  const P = cfg.paths || {};
  const legacyFish = P.dafeiyu || '';
  const legacyMcs = P.mcs || '';

  const snowlumaDir = firstExisting([
    path.join(COMPONENTS_ROOT, 'snowluma'),
    legacyFish ? path.join(legacyFish, 'snowluma') : '',
  ]);

  const astrbotBase = firstExisting([
    path.join(COMPONENTS_ROOT, 'astrbot'),
    legacyFish ? path.join(legacyFish, 'AstrBot') : '',
  ]);
  const astrbotDir = astrBotPackOf(astrbotBase);

  const mcsDir = firstExisting([
    path.join(COMPONENTS_ROOT, 'mcsmanager'),
    legacyMcs,
  ]);

  // 数据目录优先沿用老的（里面存着 SnowLuma 密码、AstrBot 配置，不能换）
  const dataRoot =
    firstExisting([legacyFish ? path.join(legacyFish, 'data') : '', PORTABLE_DATA]) || PORTABLE_DATA;

  return { snowlumaDir, astrbotBase, astrbotDir, mcsDir, dataRoot, componentsRoot: COMPONENTS_ROOT };
}

/** 拿一个可用的 node.exe：绿色版自带的优先，其次 SnowLuma 内置的，再退配置和自身 */
function nodeExe() {
  const cfg = readCfg();
  const L = resolveLayout();
  if (fs.existsSync(RUNTIME_NODE)) return RUNTIME_NODE;
  if (L.snowlumaDir) {
    const p = path.join(L.snowlumaDir, 'node.exe');
    if (fs.existsSync(p)) return p;
  }
  if (cfg.paths.node && fs.existsSync(cfg.paths.node)) return cfg.paths.node;
  return process.execPath;
}

const downloader = new Downloader({
  componentsRoot: COMPONENTS_ROOT,
  downloadRoot: DOWNLOAD_ROOT,
  getMirror: () => readCfg().download.mirror || 'auto',
  // 让下载器知道"这台机器上组件到底在哪"：便携布局 or 旧布局都认
  locate: (item) => {
    const L = resolveLayout();
    if (item.id === 'snowluma') return L.snowlumaDir;
    if (item.id === 'astrbot') return L.astrbotDir;
    if (item.id === 'mcsmanager') return L.mcsDir;
    return path.join(COMPONENTS_ROOT, item.dir);
  },
});

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function waitPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await portOpen(port)) return true;
    await sleep(600);
  }
  return false;
}

/** 启动一个脱离父进程的后台子进程，输出写日志文件 */
function spawnDetached(exe, args, cwd, logName, extraEnv) {
  if (!fs.existsSync(exe)) throw new Error('找不到程序：' + exe);
  // logName 允许绝对路径（沿用大肥鱼原来的日志文件，避免出现两套日志）
  const logFile = path.isAbsolute(logName) ? logName : path.join(LOG_DIR, logName);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toLocaleString('zh-CN')} 启动 ${path.basename(exe)} ${args.join(' ')} =====\n`);
  try {
    const child = spawn(exe, args, {
      cwd,
      // ⚠️ 这里刻意不设 detached / windowsHide，两者在 Windows 上都是「新进程不继承控制台」
      // （DETACHED_PROCESS / CREATE_NO_WINDOW）。而组件启动后会调 where.exe（MCS 探测 Java）、
      // reg.exe（SnowLuma 查 QQ 注册信息）—— 这些是控制台程序，找不到可继承的控制台，
      // Windows 就会给它分配一个新窗口再销毁，用户看到的就是「闪黑框」。
      // 改为继承父进程的控制台：vbs 用 SW_HIDE 起服务，那个控制台本身是隐藏的，
      // 于是孙进程也继承同一个隐藏控制台，不再新建窗口。
      // 子进程输出仍然重定向到日志文件，不受影响。
      detached: false,
      windowsHide: false,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...(extraEnv || {}) },
    });
    child.unref();
    return child.pid;
  } finally {
    try { fs.closeSync(fd); } catch { /* 子进程已持有副本 */ }
  }
}

function psFile(script, cwd) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { cwd: cwd || APP_ROOT, windowsHide: true, timeout: 60000 },
      () => resolve()
    );
  });
}

function taskkill(pid) {
  return new Promise((resolve) => {
    // 加 timeout：万一有进程赖着不退，taskkill 自己也可能长时间不返回，
    // 那样界面就会一直停在「正在关闭」。15 秒后强制放弃，让后面的步骤继续走。
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve());
  });
}

/**
 * 绝不能杀掉自己或自己的父进程。
 * 杀了自己 = 接口永远返回不了、页面卡在「正在关闭」；杀了父进程 = 把工具箱窗口关掉。
 */
function isSelf(pid) {
  return pid === process.pid || (process.ppid && pid === process.ppid);
}

/** 查出监听某端口的进程 PID（只认指定进程名的，避免误杀） */
function listenerPid(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const m = line.trim().split(/\s+/);
        if (m.length < 5) continue;
        const local = m[1];
        if (local.endsWith(':' + port)) return resolve(Number(m[m.length - 1]) || null);
      }
      resolve(null);
    });
  });
}

/**
 * 一次 netstat 查出多个端口各自的监听 PID（Map<端口, PID>）。
 * 原来每个端口单跑一次 netstat，实测一次 600ms，四个端口就是 2.4 秒纯等待 ——
 * 这是「停止服务很慢」的主要原因之一。
 */
function listenerPids(ports) {
  return new Promise((resolve) => {
    const want = new Set(ports.map((p) => String(p)));
    const out = new Map();
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err && !stdout) return resolve(out);
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const m = line.trim().split(/\s+/);
        if (m.length < 5) continue;
        const local = m[1];
        const i = local.lastIndexOf(':');
        if (i < 0) continue;
        const port = Number(local.slice(i + 1));
        if (!want.has(String(port)) || out.has(port)) continue;
        const pid = Number(m[m.length - 1]) || 0;
        if (pid > 4) out.set(port, pid);
      }
      resolve(out);
    });
  });
}

// ---------------------------------------------------------------- 任务（进度）

class Task {
  constructor() { this.reset(); }
  reset() {
    this.running = false;
    this.kind = null;
    this.steps = [];
    this.current = -1;
    this.error = null;
    this.startedAt = 0;
    this.finishedAt = 0;
  }
  begin(kind, labels) {
    this.reset();
    this.running = true;
    this.kind = kind;
    this.startedAt = Date.now();
    this.steps = labels.map((label) => ({ label, status: 'pending', note: '' }));
  }
  async step(i, fn) {
    this.current = i;
    this.steps[i].status = 'active';
    try {
      const note = await fn();
      this.steps[i].status = 'done';
      this.steps[i].note = note == null ? '' : String(note);
    } catch (e) {
      this.steps[i].status = 'fail';
      this.steps[i].note = e.message || String(e);
      throw e;
    }
  }
  end(err) {
    this.running = false;
    this.current = -1;
    this.finishedAt = Date.now();
    this.error = err ? err.message || String(err) : null;
    if (err) {
      for (const s of this.steps) if (s.status === 'pending') s.status = 'skipped';
    }
  }
  toJSON() {
    return {
      running: this.running,
      kind: this.kind,
      steps: this.steps,
      current: this.current,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
}

const task = new Task();

// ---------------------------------------------------------------- 大肥鱼

const FISH_PORTS = { snowluma: 5099, astrbot: 6185, channel: 3001, onebot: 6199 };

async function startDaFeiYu() {
  const L = resolveLayout();
  const D = L.dataRoot;

  task.begin('dafeiyu', [
    '启动 QQ 连接器 SnowLuma',
    '登录 SnowLuma 并加载 QQ 进程',
    '启动 AstrBot 大脑',
    '等待消息通道建立',
  ]);

  try {
    await task.step(0, async () => {
      if (!L.snowlumaDir) throw new Error('还没装 SnowLuma，去「设置 → 组件管理」里下载');
      const exe = path.join(L.snowlumaDir, 'node.exe');
      if (!fs.existsSync(exe)) throw new Error('SnowLuma 里找不到 node.exe，重装一下试试');

      // 先把「工具箱保存的密码」和「SnowLuma 实际生效的密码」对齐，再决定要不要动进程
      const auth = prepareSnowLumaAuth(L, D);

      if (await portOpen(FISH_PORTS.snowluma)) {
        if (!auth.needRestart) return '已在运行，跳过';
        // 密码没对齐：必须带新的 bootstrap 变量重起一遍，
        // 否则反代注入的自动登录会一直拿旧密码去撞，撞满 5 次锁 15 分钟
        const pid = await listenerPid(FISH_PORTS.snowluma);
        if (pid && pid > 4 && !isSelf(pid)) await taskkill(pid);
        for (let i = 0; i < 40; i++) {
          if (!(await portOpen(FISH_PORTS.snowluma))) break;
          await sleep(250);
        }
      }

      spawnDetached(exe, ['index.mjs'], L.snowlumaDir, path.join(D, 'snowluma.log'), auth.env);
      if (!(await waitPort(FISH_PORTS.snowluma, 60000))) throw new Error('SnowLuma 端口 5099 未就绪，看运行日志');
      return auth.note || '端口 5099 已监听';
    });

    await task.step(1, async () => {
      // 不依赖固定 QQ 号：直接问 SnowLuma 现在有哪些 QQ 进程，挑一个能用的加载
      const base = 'http://127.0.0.1:5099';
      const pwFile = path.join(D, 'snowluma-pw.txt');
      if (!fs.existsSync(pwFile)) throw new Error('缺少 SnowLuma 密码文件 data/snowluma-pw.txt');
      const pw = fs.readFileSync(pwFile, 'utf8').trim();

      const lr = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const lj = await lr.json().catch(() => ({}));
      if (!lj.success || !lj.token) throw new Error('SnowLuma 登录失败（密码文件可能过期了）');
      const H = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };

      const getList = async () => {
        const r = await fetch(base + '/api/processes', { headers: H });
        const j = await r.json().catch(() => ({}));
        return Array.isArray(j.list) ? j.list : [];
      };

      let list = await getList();
      if (!list.length) {
        throw new Error('SnowLuma 里还没有 QQ 进程，先在 SnowLuma 面板里添加并启动 QQ');
      }

      const name = (p) => (p.account && p.account.nickname) || (p.account && p.account.uin) || p.pid;
      const online = list.find((p) => p.connected && p.loggedIn);
      if (online) return '已经在线：' + name(online);

      const target = list.find((p) => p.status === 'available') || list[0];
      const res = await fetch(`${base}/api/processes/${target.pid}/load`, { method: 'POST', headers: H, body: '{}' });
      const ri = await res.json().catch(() => ({}));
      if (!res.ok || ri.success === false) throw new Error('加载 QQ 进程失败：' + (ri.message || res.status));

      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        const now = (await getList()).find((p) => p.pid === target.pid);
        if (!now) continue;
        if (now.connected && now.loggedIn) return '已上线：' + name(now);
        if (now.status === 'error') throw new Error('QQ 进程加载出错：' + (now.error || '未知原因'));
      }
      return 'QQ 仍在加载，稍后会自动连上';
    });

    await task.step(2, async () => {
      // 顺手把免密补丁对齐一次（幂等，已是最新就什么都不做）。
      // 补丁里除了自动登录，还带着「截获你在面板里登录/改密时的明文」那段 ——
      // AstrBot 升级换掉 webui 目录后补丁会丢，丢了就会退回「改了密码这里不更新」。
      try { patchAstrBot(); } catch { /* 没装或没写权限都不该挡住启动 */ }
      if (await portOpen(FISH_PORTS.astrbot)) {
        // 已经在跑也补一次：万一 data/astrbot-pw.txt 被误删，还能从历史日志里救回来
        harvestAstrBotPassword(0);
        return '已在运行，跳过';
      }
      const packDir = L.astrbotDir;
      if (!packDir) throw new Error('还没装 AstrBot，去「设置 → 组件管理」里下载');

      const logFile = path.join(D, 'astrbot.log');
      const rootDir = astrBotRootDir();

      // 记下启动前的日志长度：初始密码只在首次启动打印一次，
      // 之后只在「这个位置之后」找，日志再大也不会看漏。
      let logStart = 0;
      try { logStart = fs.statSync(logFile).size; } catch { /* 还没有日志，从 0 开始 */ }

      // 老的结构：内置 python 直接跑后端；新的 Electron 包：直接起 exe
      // ASTRBOT_LAUNCHER=1 是 AstrBot 官方给「桌面启动器」准备的开关：
      // 不设时插件页响应会带 X-Frame-Options: SAMEORIGIN + CSP frame-ancestors 'self'，
      // 面板被嵌在 8788 页面里时，祖先链上有 8788 这个异源，浏览器就会
      // ERR_BLOCKED_BY_RESPONSE 把插件页拦下来（点「天使之魂」显示一片空白/错误页）。
      // 设上之后这两个头不再下发，插件页才能在工具箱内嵌窗口里正常显示。
      const astrbotEnv = { ASTRBOT_ROOT: rootDir, ASTRBOT_LAUNCHER: '1' };
      const py = path.join(packDir, 'backend', 'python', 'python.exe');
      if (fs.existsSync(py)) {
        spawnDetached(
          py,
          ['launch_backend.py', '--webui-dir', path.join(packDir, 'webui')],
          path.join(packDir, 'backend'),
          logFile,
          astrbotEnv
        );
      } else {
        const exe = path.join(packDir, 'AstrBot.exe');
        if (!fs.existsSync(exe)) throw new Error('AstrBot 目录结构不认识，没找到可执行程序');
        spawnDetached(exe, [], packDir, logFile, astrbotEnv);
      }
      if (!(await waitPort(FISH_PORTS.astrbot, 120000))) throw new Error('AstrBot 端口 6185 未就绪，看运行日志');

      // 首次启动会打一行「➜  Initial password: xxx」，稍等一下把它捞进
      // data/astrbot-pw.txt —— 不捞的话设置页是空的，用户只能自己翻日志。
      let got = '';
      for (let i = 0; i < 24; i++) {
        got = harvestAstrBotPassword(logStart);
        if (got) break;
        await sleep(250);
      }
      return got ? '端口 6185 已监听，账号密码已记到设置页' : '端口 6185 已监听';
    });

    await task.step(3, async () => {
      if (await portOpen(FISH_PORTS.channel)) return '消息通道已连接';
      const ok = await waitPort(FISH_PORTS.channel, 30000);
      return ok ? '消息通道已连接' : '通道端口 3001 暂未出现（QQ 进程可能还在加载）';
    });

    task.end(null);
  } catch (e) {
    task.end(e);
  }
  return task.toJSON();
}

async function stopDaFeiYu() {
  const cfg = readCfg();
  // 老布局带一个官方清理脚本，优先用它；便携布局没有脚本，按端口找进程杀。
  //
  // 关键判断：只有「配置里的路径指向别的目录」才算老布局。
  // 便携版的 config.json 里 dafeiyu 往往就填着工具箱自己的目录（有些人是从老布局迁移过来的），
  // 那份 stop-all.ps1 会按命令行扫到工具箱自己的 node 进程并 Stop-Process 掉，
  // 表现为「点停止后界面永远卡在正在关闭大肥鱼」—— 后端已经死了，页面等不到结果。
  const legacyRoot = cfg.paths.dafeiyu ? path.resolve(cfg.paths.dafeiyu) : '';
  const script = legacyRoot && legacyRoot !== path.resolve(APP_ROOT)
    ? path.join(legacyRoot, 'scripts', 'stop-all.ps1')
    : '';
  task.begin('dafeiyu-stop', ['停止 AstrBot 与 SnowLuma 全部进程']);
  try {
    await task.step(0, async () => {
      if (script && fs.existsSync(script)) {
        await psFile(script, legacyRoot);
        return '已清理';
      }
      // 一次 netstat 拿齐四个端口，别再一个端口跑一遍
      const map = await listenerPids([FISH_PORTS.astrbot, FISH_PORTS.snowluma, FISH_PORTS.channel, FISH_PORTS.onebot]);
      const pids = [...new Set(map.values())].filter((id) => id > 4 && !isSelf(id));
      if (!pids.length) return '本来就没在运行';
      // 并发杀，之前是一个一个等着，进程多的时候就是几秒的串行等待
      await Promise.all(pids.map((id) => taskkill(id)));
      return '已停止 ' + pids.length + ' 个进程';
    });
    task.end(null);
  } catch (e) {
    task.end(e);
  }
  return task.toJSON();
}

// ---------------------------------------------------------------- MCS

const MCS_PORTS = { web: 23333, daemon: 24444 };

async function startMcs() {
  const L = resolveLayout();
  if (!L.mcsDir) {
    task.begin('mcs', ['检查安装状态']);
    task.end(new Error('还没装 MCSManager，去「设置 → 组件管理」里下载'));
    return task.toJSON();
  }
  const M = L.mcsDir;
  const webExe = path.join(M, 'web', 'node_app.exe');
  const daemonExe = path.join(M, 'daemon', 'node_app.exe');

  task.begin('mcs', ['启动守护进程 daemon', '启动控制面板 web']);
  try {
    await task.step(0, async () => {
      if (await portOpen(MCS_PORTS.daemon)) return '已在运行，跳过';
      spawnDetached(daemonExe, ['--enable-source-maps', '--max-old-space-size=8192', 'app.js'], path.join(M, 'daemon'), 'mcs-daemon.log');
      if (!(await waitPort(MCS_PORTS.daemon, 45000))) throw new Error('守护进程端口 24444 未就绪，看 logs/mcs-daemon.log');
      return '端口 24444 已监听';
    });

    await task.step(1, async () => {
      if (await portOpen(MCS_PORTS.web)) return '已在运行，跳过';
      spawnDetached(webExe, ['--enable-source-maps', '--max-old-space-size=8192', 'app.js'], path.join(M, 'web'), 'mcs-web.log');
      if (!(await waitPort(MCS_PORTS.web, 45000))) throw new Error('面板端口 23333 未就绪，看 logs/mcs-web.log');
      return '端口 23333 已监听';
    });

    task.end(null);
  } catch (e) {
    task.end(e);
  }
  return task.toJSON();
}

async function stopMcs() {
  task.begin('mcs-stop', ['停止面板与守护进程']);
  try {
    await task.step(0, async () => {
      const map = await listenerPids([MCS_PORTS.web, MCS_PORTS.daemon]);
      const pids = [...new Set(map.values())].filter((id) => id > 4 && !isSelf(id));
      if (!pids.length) return '本来就没在运行';
      await Promise.all(pids.map((id) => taskkill(id)));
      mcs.session.invalidate();
      return '已停止 ' + pids.length + ' 个进程';
    });
    task.end(null);
  } catch (e) {
    task.end(e);
  }
  return task.toJSON();
}

// MCS 会话（后端自己用，用来查实例列表）
const mcs = {
  session: {
    cookie: '',
    at: 0,
    /** 上一次「尝试」登录的时间（不管成败），用来做节流 */
    loginAt: 0,
    invalidate() { this.cookie = ''; this.at = 0; },
  },
  /** 实例数缓存：这类数据不需要每次 status 都查 MCS */
  stats: { at: 0, instances: null, running: null },
  /** 用账号密码登录，返回 Set-Cookie 数组 */
  async login() {
    // 节流：5 秒内不再尝试登录。
    // 起因：Set-Cookie 没取到时 cookie 会存成空串，而 api() 原先用 !cookie 判断，
    // 于是前端每 1.2 秒轮询 /api/status → 这里每 1.2 秒登录一次 MCS，
    // 上千次登录直接把 MCS 面板和守护进程拖垮了（2026-10-26 实测）。
    const now = Date.now();
    if (this.session.loginAt && now - this.session.loginAt < 5000) {
      return { ok: false, message: '登录尝试过于频繁，请稍后再试' };
    }
    this.session.loginAt = now;

    const cfg = readCfg();
    const { username, password } = cfg.mcsAccount;
    if (!username || !password) return { ok: false, needSetup: true, message: '还没设置 MCS 账号密码' };
    if (!(await portOpen(MCS_PORTS.web))) return { ok: false, message: 'MCS 面板没在运行' };
    try {
      const r = await fetch(`http://127.0.0.1:${MCS_PORTS.web}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      let body = null;
      try { body = await r.json(); } catch { /* ignore */ }
      const ok = r.ok && body && body.status === 200;
      if (!ok) {
        const msg = (body && (body.data || body.message)) || '登录失败';
        return { ok: false, message: typeof msg === 'string' ? msg : '登录失败' };
      }
      this.session.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      this.session.at = Date.now();
      return { ok: true, setCookies, username };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },
  /** 后端内部调用 MCS 接口 */
  async api(pathname) {
    // 用时间戳判断会话，不要用 !cookie ——
    // cookie 可能是空串（Set-Cookie 没取到），那样每次调用都会重新登录
    if (!this.session.at || Date.now() - this.session.at > 10 * 60 * 1000) {
      const r = await this.login();
      if (!r.ok) throw new Error(r.message || '登录失败');
    }
    const r = await fetch(`http://127.0.0.1:${MCS_PORTS.web}${pathname}`, {
      headers: { Cookie: this.session.cookie },
    });
    if (r.status === 403) { this.session.invalidate(); throw new Error('会话失效'); }
    return r.json();
  },
};

/** 从 MCS 用户文件里读出用户名，省得用户自己填 */
function readMcsUsername() {
  const L = resolveLayout();
  if (!L.mcsDir) return '';
  const dir = path.join(L.mcsDir, 'web', 'data', 'User');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.userName) return j.userName;
    }
  } catch { /* ignore */ }
  return '';
}

// ---------------------------------------------------------------- 状态

async function collectStatus() {
  const [snow, astr, chan, mweb, mdaemon] = await Promise.all([
    portOpen(FISH_PORTS.snowluma),
    portOpen(FISH_PORTS.astrbot),
    portOpen(FISH_PORTS.channel),
    portOpen(MCS_PORTS.web),
    portOpen(MCS_PORTS.daemon),
  ]);

  const cfg = readCfg();
  const comps = downloader.detect();
  const comp = Object.fromEntries(comps.map((c) => [c.id, c]));
  const status = {
    fish: {
      snowluma: snow,
      astrbot: astr,
      channel: chan,
      any: snow || astr,
      // 缺组件时前端要显示「去下载」而不是「启动」
      installed: !!(comp.snowluma && comp.snowluma.installed) && !!(comp.astrbot && comp.astrbot.installed),
    },
    mcs: {
      web: mweb,
      daemon: mdaemon,
      instances: null,
      runningInstances: null,
      installed: !!(comp.mcsmanager && comp.mcsmanager.installed),
    },
    components: comps,
    groups: GROUPS,
    appearance: cfg.appearance,
    account: { username: cfg.mcsAccount.username || readMcsUsername(), hasPassword: !!cfg.mcsAccount.password },
    task: task.toJSON(),
    time: Date.now(),
  };

  if (mweb) {
    // 实例数这类数据没必要每次 status 都往 MCS 打一次请求（前端 1.2 秒轮询一次）。
    // 缓存 15 秒，失败也等 15 秒再试，避免把 MCS 打爆。
    if (Date.now() - mcs.stats.at > 15000) {
      mcs.stats.at = Date.now();
      try {
        const list = await mcs.api('/api/instance');
        const arr = Array.isArray(list && list.data) ? list.data : [];
        mcs.stats.instances = arr.length;
        mcs.stats.running = arr.filter((x) => x && x.status === 1).length;
      } catch {
        mcs.stats.instances = null;
        mcs.stats.running = null;
      }
    }
    status.mcs.instances = mcs.stats.instances;
    status.mcs.runningInstances = mcs.stats.running;
  } else {
    // 面板没跑就把缓存清掉，下次起来重新查
    mcs.stats.at = 0;
    mcs.stats.instances = null;
    mcs.stats.running = null;
  }
  return status;
}

// ---------------------------------------------------------------- 日志

const LOG_KEYS = new Set(['astrbot', 'snowluma', 'mcs-web', 'mcs-daemon']);

function logFileOf(key) {
  const L = resolveLayout();
  switch (key) {
    case 'astrbot': return path.join(L.dataRoot, 'astrbot.log');
    case 'snowluma': return path.join(L.dataRoot, 'snowluma.log');
    case 'mcs-web': return path.join(LOG_DIR, 'mcs-web.log');
    case 'mcs-daemon': return path.join(LOG_DIR, 'mcs-daemon.log');
    default: return null;
  }
}

function tailLog(key, lines = 200) {
  if (!LOG_KEYS.has(key)) return '';
  const p = logFileOf(key);
  if (!p || !fs.existsSync(p)) return '';
  const text = fs.readFileSync(p).toString('utf8');
  return text.split(/\r?\n/).slice(-Math.max(1, Math.min(lines, 2000))).join('\n');
}

// ---------------------------------------------------------------- AstrBot 免密补丁
/**
 * AstrBot 的登录态在浏览器 localStorage 里，按 origin 隔离（6185 vs 8788 互不相通），
 * 网页没法跨源写入。所以在 AstrBot 自己的 index.html 里插一小段脚本：
 * 页面加载时同步向工具箱要一个 JWT，写进 localStorage，前端就认为已登录。
 * AstrBot 升级会换掉 webui 目录，补丁随之失效 —— 重新点一次「重打补丁」即可。
 */
const PATCH_MARK = 'TBX-AUTOLOGIN';

const PATCH_JS = `
<script>/* ${PATCH_MARK} 大肥鱼工具箱 · AstrBot 免密补丁。删掉这一段即可恢复原样。 */
(function(){
  var TBX = 'http://127.0.0.1:__TBX_PORT__';
  var raw = window.fetch ? window.fetch.bind(window) : null;

  // ---- 1) 把「你自己在面板里登录 / 改密」的明文密码送回工具箱 ----
  // AstrBot 磁盘上只存 pbkdf2 哈希，明文只在这两个请求的 body 里出现过一次：
  //   POST /api/auth/login         { username, password }
  //   POST /api/auth/account/edit  { password, new_password, confirm_password, new_username }
  // 不在这里截住，工具箱记的就永远是旧密码 —— 也就是「我改了密码，这里怎么还是旧的」。
  if (raw && !window.__tbxHook){
    window.__tbxHook = 1;
    window.fetch = function(input, init){
      var hit = null, url = '';
      try {
        url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (init && typeof init.body === 'string' && url.indexOf('/api/auth/') >= 0){
          var b = JSON.parse(init.body);
          if (url.indexOf('/api/auth/login') >= 0 && b && b.password){
            hit = { u: b.username, p: b.password };
          } else if (url.indexOf('/api/auth/account/edit') >= 0 && b && b.new_password){
            hit = { u: b.new_username, p: b.new_password };
          }
        }
      } catch(e){}
      var pr = raw(input, init);
      if (hit && pr && pr.then){
        pr.then(function(r){
          try{
            // clone 一份读结果、不动原响应；只有真成功才记 —— 旧密码填错时不能把好的覆盖掉
            r.clone().json().then(function(j){
              var bad = (j && j.status === 'error') || (j && j.data && j.data.status === 'error');
              if (bad || !hit.p) return;
              raw(TBX + '/api/astrbot/credential', {
                method: 'POST',
                body: JSON.stringify({ username: hit.u || '', password: hit.p })
              }).catch(function(){});
            }).catch(function(){});
          }catch(e){}
        }).catch(function(){});
      }
      return pr;
    };
  }

  // ---- 2) 自动登录 ----
  try{
    // AstrBot 4.29.x 起把登录态放进了 HttpOnly 的 cookie（astrbot_dashboard_jwt），
    // JS 既读不到也写不了，所以老办法「往 localStorage 塞 token」在 4.29 上已经彻底失效。
    // 改为让页面自己发一次同源登录请求：浏览器收到 Set-Cookie 会自己存下，
    // 全程不碰 cookie 内容，刷新后就是已登录状态。
    var KEY = 'tbx_auth_at';
    var last = Number(localStorage.getItem(KEY) || 0);
    if (Date.now() - last < 3600 * 1000) return;   // 一小时内不重复登录，躲开 auth_rate_limit
    var x = new XMLHttpRequest();
    x.open('GET', TBX + '/api/astrbot/token', false);
    x.send(null);
    var d = JSON.parse(x.responseText || '{}');
    if (!d || !d.ok || !d.password) return;
    raw('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: d.username || 'astrbot', password: d.password })
    }).then(function(r){ return r.json(); }).then(function(j){
      if (j && j.status === 'ok'){
        localStorage.setItem(KEY, String(Date.now()));
        location.reload();
      }
    }).catch(function(){});
  }catch(e){}
})();
</script>`;

function astrBotWebuiFile() {
  const L = resolveLayout();
  if (!L.astrbotDir) throw new Error('还没装 AstrBot');
  const f = path.join(L.astrbotDir, 'webui', 'index.html');
  if (!fs.existsSync(f)) throw new Error('找不到 webui/index.html');
  return f;
}

function patchAstrBot() {
  const file = astrBotWebuiFile();
  const port = readCfg().port;
  let html = fs.readFileSync(file, 'utf8');

  // 判断「已经是最新补丁」要带上这几个新标记：
  // 老补丁里也有同一个 token 接口地址，只看地址会误判成已最新、永远不升级。
  const already = html.includes(PATCH_MARK)
    && html.includes('127.0.0.1:' + port + '/api/astrbot/token')
    && html.includes('tbx_auth_at')
    && html.includes('__tbxHook')
    && html.includes('/api/astrbot/credential');
  if (already) return { ok: true, changed: false, file };

  const bak = file + '.tbx-bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);

  // 先摘掉旧补丁（端口改了要重写），再插新的
  html = html.replace(/<script>\/\* TBX-AUTOLOGIN[\s\S]*?<\/script>\n?/g, '');
  const js = PATCH_JS.replace(/__TBX_PORT__/g, String(port));
  if (html.includes('</head>')) html = html.replace('</head>', js + '\n</head>');
  else html = js + '\n' + html;

  fs.writeFileSync(file, html, 'utf8');
  return { ok: true, changed: true, file, backup: bak };
}

/** 用 AstrBot 的密码换一个 JWT */
async function astrBotToken() {
  const L = resolveLayout();
  const pwFile = path.join(L.dataRoot, 'astrbot-pw.txt');
  if (!fs.existsSync(pwFile)) throw new Error('缺少 data/astrbot-pw.txt');
  const pw = fs.readFileSync(pwFile, 'utf8').trim();
  if (!pw) throw new Error('astrbot-pw.txt 是空的');
  if (!(await portOpen(FISH_PORTS.astrbot))) throw new Error('AstrBot 没在运行');

  const attempts = [
    { url: 'http://127.0.0.1:6185/api/auth/login', body: { username: 'astrbot', password: pw } },
    { url: 'http://127.0.0.1:6185/api/v1/auth/login', body: { username: 'astrbot', password: pw } },
  ];
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a.body),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const token = (j && j.data && j.data.token) || (j && j.token);
      if (token) return { ok: true, token, username: (j.data && j.data.username) || 'astrbot' };
    } catch { /* 试下一个 */ }
  }
  throw new Error('AstrBot 登录失败，密码文件可能过期了');
}

/**
 * 读 data/astrbot-pw.txt。
 * 免密补丁需要把密码交给 AstrBot 页面自己 POST 一次登录（4.29.x 的 cookie 是 HttpOnly，
 * 工具箱没法替它写登录态），所以这个值要经 /api/astrbot/token 传给 6185 那个页面。
 * 该接口的 CORS 只放行 http://127.0.0.1:6185，别的源读不到。
 */
function readAstrBotPassword() {
  try {
    return fs.readFileSync(path.join(resolveLayout().dataRoot, 'astrbot-pw.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 写 data/astrbot-pw.txt（用户在面板里改密 / 重新登录后由页面内补丁回传） */
function saveAstrBotPassword(pw) {
  const s = String(pw || '').trim();
  if (!s) return false;
  try {
    fs.writeFileSync(path.join(resolveLayout().dataRoot, 'astrbot-pw.txt'), s + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 AstrBot 首次启动时打印的初始密码从日志里抄下来。
 *
 * 为什么必须做这件事：AstrBot 磁盘上只有 pbkdf2 哈希，
 * 初始密码只在首次启动时往 stdout 打印一次（`➜  Initial password: xxx`），
 * 而我们把它的 stdout 重定向到了 data/astrbot.log —— 这是**唯一**能拿到明文的地方。
 * 不自动抄，用户就只能自己去翻日志，等于进不去面板。
 *
 * @param {number} fromOffset 这次启动前日志的长度。只看新增部分最准，日志再大也不怕。
 */
function harvestAstrBotPassword(fromOffset = 0) {
  const D = resolveLayout().dataRoot;
  const pwFile = path.join(D, 'astrbot-pw.txt');

  // 已经有记录就不动它：可能是补丁回传的、也可能是用户手填的，都比日志里的旧值可信
  let cur = '';
  try { cur = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 没有 */ }
  if (cur) return cur;

  const logFile = path.join(D, 'astrbot.log');
  const RE = /Initial password:\s*(\S+)/;

  const readFrom = (offset, maxBytes) => {
    try {
      const st = fs.statSync(logFile);
      const start = Math.max(0, Math.min(offset, st.size));
      const end = Math.min(st.size, start + maxBytes);
      if (end <= start) return '';
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, end - start, start);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch {
      return '';
    }
  };

  // 先看这次启动新增的部分（最准）
  let m = readFrom(fromOffset, 4 << 20).match(RE);
  // 兜底再全文件扫一遍（限 8MB；pw 文件被误删、日志还在的情况靠这条救回来）
  if (!m) m = readFrom(0, 8 << 20).match(RE);
  if (!m) return '';

  const pw = m[1];
  saveAstrBotPassword(pw);
  return pw;
}

/** AstrBot 的数据根目录（与启动时用的是同一套判断，避免两处跑偏） */
function astrBotRootDir() {
  const L = resolveLayout();
  return L.astrbotBase && fs.existsSync(path.join(L.astrbotBase, 'root'))
    ? path.join(L.astrbotBase, 'root')
    : path.join(L.dataRoot, 'astrbot-root');
}

/**
 * 读 AstrBot 的登录用户名。
 * 优先用 data/astrbot-user.txt —— 那是用户在工具箱设置页里手填的，
 * 按「自动登录以面板为准」的原则，手填的要压过 AstrBot 自己 cmd_config.json 里的。
 * 没手填过才回落到 cmd_config.json 的 dashboard.username（该文件带 BOM，须先剥掉）。
 */
function readAstrBotUsername() {
  try {
    const manual = fs.readFileSync(path.join(resolveLayout().dataRoot, 'astrbot-user.txt'), 'utf8').trim();
    if (manual) return manual;
  } catch { /* 没填过，往下读 AstrBot 自己的 */ }
  try {
    const f = path.join(astrBotRootDir(), 'data', 'cmd_config.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const u = j && j.dashboard && j.dashboard.username;
    return typeof u === 'string' ? u.trim() : '';
  } catch {
    return '';
  }
}

/** 写 data/astrbot-user.txt（用户在设置页里手填的用户名优先用它） */
function saveAstrBotUsername(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  try {
    fs.writeFileSync(path.join(resolveLayout().dataRoot, 'astrbot-user.txt'), s + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, obj, code = 200, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(WEB_ROOT, '.' + rel);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(WEB_ROOT, 'index.html'), (e2, d2) => {
        if (e2) res.writeHead(404).end('not found');
        else {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(d2);
        }
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1 << 20) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- SnowLuma 反向代理
/**
 * SnowLuma 的 WebUI 返回 X-Frame-Options: DENY + CSP frame-ancestors，
 * 浏览器会直接拒绝把它放进 iframe —— 这是作者有意的防点击劫持设计，前端绕不过去。
 *
 * 解法：本地另开一个端口做反向代理，转发时把这两个头去掉。
 * iframe 指向反代端口，那么它的所有请求（含 /assets/* 这类绝对路径、以及 WebSocket）
 * 都会回到反代再转给 5099，路径天然对齐，不需要重写 HTML 里的任何资源地址。
 */
const SNOW_PROXY_PORT = 5100;

// ---------------------------------------------------------------- SnowLuma 认证对齐
/**
 * SnowLuma 从 2.2.0 起换了 WebUI 密码机制，跟我们原来的假设不一样了：
 *
 *   · 首次启动随机生成一个 16 位 hex 密码，明文**只打印到 stdout 一次**，不落盘；
 *   · config/webui.json 里只留 scrypt 的 hash + salt，推不回明文；
 *   · 只要 mustChangePassword 还是 true，每次重启都会再换一个新的；
 *   · 未改密前，除 7 个白名单接口外全部 403 —— /api/processes 就在外面，
 *     所以「启动大肥鱼」第 2 步会直接失败。
 *
 * 所以不能「等它生成完再去日志里捞密码」：那样密码每次启动都在变，
 * 下面 snowAutoLoginTag() 注入的自动登录脚本会拿旧密码反复提交，
 * 撞满 5 次就把这个 IP 锁 15 分钟（用户看到的就是「登录尝试过多，请 N 秒后重试」）。
 *
 * 改用官方留的口子 SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD：
 * 带上它启动，SnowLuma 直接拿这个值当密码，并把 mustChangePassword 置为 false，
 * 顺带也就绕过了那道 403。但这段逻辑只在 webui.json 不存在或损坏时才走，
 * 文件还在就会优先「重新随机」，所以需要重置时得把旧文件挪到备份名。
 *
 * 判定原则：mustChangePassword 为 false，说明用户自己在面板里改过密码 ——
 * 那是他的密码，一律不碰、也不重启，免得把人家的设置冲掉。
 */
const SNOW_PW_FILE = 'snowluma-pw.txt';
const SNOW_DEFAULT_PW_PREFIX = 'dafeiyu-snowluma';

/** 生成一个够用的密码：SnowLuma 的 bootstrap 只校验长度 ≥ 8，不强求复杂度 */
function newSnowPassword() {
  return SNOW_DEFAULT_PW_PREFIX + '-' + crypto.randomBytes(6).toString('hex');
}

/**
 * 让「工具箱保存的密码」和「SnowLuma 实际生效的密码」保持一致。
 * @returns {{env: object, needRestart: boolean, note: string, pw: string}}
 */
function prepareSnowLumaAuth(L, D) {
  const pwFile = path.join(D, SNOW_PW_FILE);
  let pw = '';
  try { pw = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* 下面补一个 */ }
  if (pw.length < 8) {
    pw = newSnowPassword();
    fs.writeFileSync(pwFile, pw + '\n', 'utf8');
  }

  const env = {
    SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: pw,
    // 无人值守场景：替用户同意协议，否则面板会被 EULA / 隐私政策那道门挡住
    SNOWLUMA_ACCEPT_EULA: '1',
    SNOWLUMA_ACCEPT_PRIVACY: '1',
  };

  const cfgFile = path.join(L.snowlumaDir, 'config', 'webui.json');
  let needRestart = false;
  let note = '';

  if (!fs.existsSync(cfgFile)) {
    needRestart = true;
    note = '首次运行，已用工具箱保存的密码初始化';
  } else {
    let mustChange = null;
    try {
      const st = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      mustChange = st && typeof st === 'object' ? st.mustChangePassword : null;
    } catch {
      mustChange = 'broken';
    }

    if (mustChange === true || mustChange === 'broken') {
      // 从没改过密码：那份随机密码没人知道，挪走让 SnowLuma 重新按我们的密码 seed
      const bak = cfgFile + '.tbx-bak';
      try { fs.rmSync(bak, { force: true }); } catch { /* 删不掉就覆盖 */ }
      try {
        fs.renameSync(cfgFile, bak);
      } catch {
        try { fs.rmSync(cfgFile, { force: true }); } catch { /* 真动不了就让它自己随机 */ }
      }
      needRestart = true;
      note = mustChange === 'broken'
        ? '配置文件损坏，已让 SnowLuma 重建'
        : '已把访问密码重置为工具箱保存的值';
    }
  }

  return { env, needRestart, note, pw };
}

/** 读当前保存的 SnowLuma 密码（设置页展示用）。没有就返回空串。 */
function readSnowPassword() {
  try {
    return fs.readFileSync(path.join(resolveLayout().dataRoot, SNOW_PW_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把新密码写回 data/snowluma-pw.txt。
 * 由反代在「用户在 SnowLuma 面板里改密码成功」时调用，这样设置页显示的值永远是最新的。
 */
function saveSnowPassword(pw) {
  const s = String(pw || '').trim();
  if (s.length < 8) return false;
  try {
    fs.writeFileSync(path.join(resolveLayout().dataRoot, SNOW_PW_FILE), s + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * SnowLuma 的登录 token 只存在页面内存里（初版 WebView2 的注释也印证了这点），
 * 所以 iframe 每次加载都会停在登录页。这里往它返回的 HTML 里注入一小段脚本：
 * 自动找到密码框、填值、提交。密码从 <dataRoot>/snowluma-pw.txt 读，不出本机。
 */
function snowAutoLoginTag() {
  let pw = '';
  try {
    pw = fs.readFileSync(path.join(resolveLayout().dataRoot, 'snowluma-pw.txt'), 'utf8').trim();
  } catch { return ''; }
  if (!pw) return '';
  const lit = JSON.stringify(pw); // 安全转义引号和反斜杠
  return `<script>/* 大肥鱼工具箱 · SnowLuma 自动登录。删掉这一段即可恢复手动输密码。 */
(function(){
  if (location.port !== '${SNOW_PROXY_PORT}') return;
  var pw = ${lit};
  var tries = 0;
  var timer = setInterval(function(){
    if (++tries > 150) { clearInterval(timer); return; }
    var el = document.querySelector('input[placeholder="当前访问密码"]')
          || document.querySelector('input[placeholder*="密码"]')
          || document.querySelector('input[type="password"]');
    if (!el || el.value) return;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, pw);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(function(){
      var form = el.closest('form');
      if (form) { if (form.requestSubmit) { form.requestSubmit(); } else { form.submit(); } return; }
      var btns = Array.from(document.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        if (/登录|进入|确认|解锁/.test(btns[i].textContent || '')) { btns[i].click(); return; }
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, 250);
    clearInterval(timer);
  }, 400);
})();</script>`;
}

function startSnowProxy() {
  const proxy = http.createServer((req, res) => {
    // 用户在 SnowLuma 面板里改密码时，请求必然经过这个反代。
    // 拦下来把新密码同步到本地文件 —— 这是「设置页显示的值能跟着变」的唯一可靠来源：
    // SnowLuma 只存 scrypt 的 hash + salt，事后推不回明文。
    const isPwdChange = req.method === 'POST'
      && String(req.url || '').startsWith('/api/auth/change-password');
    let capturedPw = '';

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: FISH_PORTS.snowluma,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${FISH_PORTS.snowluma}`,
          // 让上游别压缩，这样下面能直接往 HTML 里插字符串
          'accept-encoding': 'identity',
        },
      },
      (ur) => {
        // 改密响应是 JSON，先收全再判断：只有真的 success 才落盘。
        // 光看请求体不够 —— 旧密码填错、新密码强度不足都会失败，那种情况不能覆盖。
        if (isPwdChange) {
          const rc = [];
          ur.on('data', (c) => rc.push(c));
          ur.on('end', () => {
            const body = Buffer.concat(rc);
            let ok = false;
            try { ok = JSON.parse(body.toString('utf8')).success === true; } catch { /* 非 JSON 就只透传 */ }
            if (ok && capturedPw) saveSnowPassword(capturedPw);
            const h = { ...ur.headers };
            delete h['transfer-encoding'];
            h['content-length'] = String(body.length);
            res.writeHead(ur.statusCode || 200, h);
            res.end(body);
          });
          return;
        }

        const headers = { ...ur.headers };
        // 关键两刀：去掉 DENY 与 frame-ancestors，否则浏览器不渲染
        delete headers['x-frame-options'];
        if (headers['content-security-policy']) {
          headers['content-security-policy'] = String(headers['content-security-policy'])
            .replace(/frame-ancestors[^;]*;?/gi, '');
        }

        const isHtml = String(headers['content-type'] || '').includes('text/html');
        if (!isHtml) {
          // 非 HTML（js/css/图片）原样流式转发，别占内存
          res.writeHead(ur.statusCode || 502, headers);
          ur.pipe(res);
          return;
        }

        // HTML 要改内容，先整段收完再发
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let buf = Buffer.concat(chunks);
          // 万一上游无视 identity 还是压了，先解开
          const enc = String(headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch { /* 解不开就按原样发 */ }

          let html = buf.toString('utf8');
          const tag = snowAutoLoginTag();
          if (tag) {
            html = html.includes('</head>')
              ? html.replace('</head>', tag + '</head>')
              : tag + html;
          }
          const out = Buffer.from(html, 'utf8');
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = String(out.length);
          res.writeHead(ur.statusCode || 200, headers);
          res.end(out);
        });
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('SnowLuma 没在运行');
    });
    if (isPwdChange) {
      // 要读请求体才拿得到 newPassword，所以这条路径不能直接 pipe
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          const j = JSON.parse(raw.toString('utf8'));
          if (j && typeof j.newPassword === 'string') capturedPw = j.newPassword;
        } catch { /* 解析不了就原样转发，交给它自己处理 */ }
        // 原请求头可能是 chunked（没有 length），直接设 content-length 会两个头打架
        upstream.removeHeader('transfer-encoding');
        upstream.setHeader('content-length', String(raw.length));
        upstream.end(raw);
      });
      return;
    }

    req.pipe(upstream);
  });

  // WebSocket 握手走 upgrade 事件，不能当普通请求转发，得用裸 socket 双向透传
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(FISH_PORTS.snowluma, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  proxy.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.log(`SnowLuma 反代端口 ${SNOW_PROXY_PORT} 被占用`);
    else console.error('SnowLuma 反代出错：' + e.message);
  });

  proxy.listen(SNOW_PROXY_PORT, '127.0.0.1', () => {
    console.log(`SnowLuma 反代已就绪 -> http://127.0.0.1:${SNOW_PROXY_PORT}/`);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // ---------- API ----------
    if (p === '/api/ping') {
      // 纯文本回自己的 PID，桌面启动器要用它来结束旧进程（VBS 解析 JSON 太费劲）
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(String(process.pid));
    }

    if (p === '/api/status') {
      return sendJson(res, await collectStatus());
    }

    if (p === '/api/task') {
      return sendJson(res, task.toJSON());
    }

    if (p === '/api/fish/start' && req.method === 'POST') {
      if (task.running) return sendJson(res, { ok: false, message: '有任务正在进行中' }, 409);
      startDaFeiYu(); // 异步跑，前端轮询 task
      return sendJson(res, { ok: true, started: true });
    }

    if (p === '/api/fish/stop' && req.method === 'POST') {
      if (task.running) return sendJson(res, { ok: false, message: '有任务正在进行中' }, 409);
      stopDaFeiYu();
      return sendJson(res, { ok: true, started: true });
    }

    if (p === '/api/snow/open' && req.method === 'POST') {
      // SnowLuma 的 WebUI 送了 X-Frame-Options: DENY + CSP frame-ancestors，
      // 作者明确禁止被 iframe 嵌入（防点击劫持），所以没法像 AstrBot 那样内嵌。
      // 折中：用 Edge 的 --app 模式开独立窗口 —— 无地址栏、无标签页，形态跟工具箱自己一致。
      if (!(await portOpen(FISH_PORTS.snowluma))) {
        return sendJson(res, { ok: false, message: 'SnowLuma 还没启动，先点「启动大肥鱼」' }, 400);
      }
      const edge = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(APP_ROOT, 'runtime', 'msedge', 'msedge.exe'),
      ].find((x) => fs.existsSync(x));
      if (!edge) return sendJson(res, { ok: false, message: '没找到 Edge，只能手动开浏览器访问 127.0.0.1:5099' }, 400);

      // 独立 profile：跟工具箱主窗口的分开，免得两边抢同一份窗口状态
      const snowProfile = path.join(PORTABLE_DATA, 'ui-profile-snow');
      const args = [
        '--app=http://127.0.0.1:5099/',
        '--user-data-dir=' + snowProfile,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--disable-features=msEdgeSidebarV2,msEdgeSplitScreen,msFeedback',
        '--disable-sync',
      ];
      // 首次（还没 profile）给个合适尺寸，之后 Edge 自己记住用户拉过的窗口大小
      if (!fs.existsSync(snowProfile)) args.push('--window-size=1180,840');

      try {
        const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        return sendJson(res, { ok: false, message: e.message || '打开失败' }, 500);
      }
      return sendJson(res, { ok: true });
    }

    if (p === '/api/mcs/start' && req.method === 'POST') {
      if (task.running) return sendJson(res, { ok: false, message: '有任务正在进行中' }, 409);
      startMcs();
      return sendJson(res, { ok: true, started: true });
    }

    if (p === '/api/mcs/stop' && req.method === 'POST') {
      if (task.running) return sendJson(res, { ok: false, message: '有任务正在进行中' }, 409);
      stopMcs();
      return sendJson(res, { ok: true, started: true });
    }

    if (p === '/api/mcs/login' && req.method === 'POST') {
      const r = await mcs.login();
      if (!r.ok) return sendJson(res, r, r.needSetup ? 428 : 400);
      // 关键一步：把 MCS 的 session cookie 原样转发给浏览器。
      // cookie 不区分端口，浏览器拿着它去访问 127.0.0.1:23333 就是已登录状态。
      return sendJson(res, { ok: true, username: r.username }, 200, { 'Set-Cookie': r.setCookies });
    }

    if (p === '/api/mcs/account' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readCfg();
      cfg.mcsAccount.username = String(body.username || readMcsUsername() || '').trim();
      if (typeof body.password === 'string' && body.password.length) cfg.mcsAccount.password = body.password;
      writeCfg(cfg);
      mcs.session.invalidate();
      return sendJson(res, { ok: true, username: cfg.mcsAccount.username });
    }

    // AstrBot 页面（6185）会跨源来拿 token，所以这里要放 CORS
    if (p === '/api/astrbot/token' && req.method === 'GET') {
      const origin = req.headers.origin || '';
      const cors = /^http:\/\/(127\.0\.0\.1|localhost):6185$/.test(origin)
        ? { 'Access-Control-Allow-Origin': origin }
        : {};
      let payload;
      try {
        payload = await astrBotToken();
        // 4.29.x 的登录态是 HttpOnly cookie，页面必须自己再 POST 一次登录，
        // 所以把密码一并交给它（这个接口的 CORS 已限定 6185 来源）
        payload.password = readAstrBotPassword();
      } catch (e) {
        payload = { ok: false, message: e.message };
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...cors,
      });
      res.end(JSON.stringify(payload));
      return;
    }

    if (p === '/api/astrbot/patch' && req.method === 'POST') {
      try {
        return sendJson(res, patchAstrBot());
      } catch (e) {
        return sendJson(res, { ok: false, message: e.message }, 500);
      }
    }

    // AstrBot 页面里的补丁把「用户自己在面板里登录 / 改密」时的明文密码送回这里。
    // AstrBot 磁盘上只有 pbkdf2 哈希，明文只在那两个请求的 body 里出现过一次，
    // 不在这里截住就永远拿不到了（这正是「改了密码这里还是旧的」的根因）。
    // CORS 同样只放行 6185，别的网页写不进来。
    if (p === '/api/astrbot/credential' && req.method === 'POST') {
      const origin = req.headers.origin || '';
      const fromPanel = /^http:\/\/(127\.0\.0\.1|localhost):6185$/.test(origin);
      const head = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(fromPanel ? { 'Access-Control-Allow-Origin': origin } : {}),
      };
      if (!fromPanel) {
        res.writeHead(403, head);
        res.end(JSON.stringify({ ok: false, message: '来源不被允许' }));
        return;
      }
      const body = await readBody(req);
      const pw = typeof body.password === 'string' ? body.password : '';
      const ok = saveAstrBotPassword(pw);
      res.writeHead(200, head);
      res.end(JSON.stringify({
        ok,
        // 回一句最新的读值，方便前端/日志核对
        username: readAstrBotUsername(),
        saved: ok ? pw.length : 0,
      }));
      return;
    }

    // 设置页要展示 / 保存各组件访问密码。值都来自本机文件，不出本机。
    //   snowluma → data/snowluma-pw.txt（启动时 seed 用，反代在改密后也会自动回写）
    //   astrbot  → data/astrbot-pw.txt（首启生成；面板里登录/改密时由页面补丁回传；也可手填）
    //   mcs      → server/config.json 的 mcsAccount（用户自己填的，明文存）
    if (p === '/api/credentials' && req.method === 'GET') {
      const cfg = readCfg();
      const mcs = cfg.mcsAccount || {};
      // 还是空的就顺手再从日志里找一次：启动时可能密码打得太晚没抓到，
      // 用户一打开设置页这里补上，总比让他自己去翻日志强。
      if (!readAstrBotPassword()) {
        try { harvestAstrBotPassword(0); } catch { /* 捞不到就算了 */ }
      }
      return sendJson(res, {
        ok: true,
        snowluma: readSnowPassword(),
        astrbot: readAstrBotPassword(),
        astrbotUser: readAstrBotUsername(),
        mcs: mcs.password || '',
        mcsUser: mcs.username || '',
      });
    }

    // 手填保存。原则：**自动登录一律用这里存的值**，所以面板里改完要立刻生效，
    // 不能留一份「面板显示新密码、自动登录还在用旧的」的分裂状态。
    // 字段为空 = 不修改（留空就是不改，避免误清空）。
    if (p === '/api/credentials' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = {};
      const cfg = readCfg();
      let mcsTouched = false;

      if (typeof body.snowluma === 'string' && body.snowluma.trim()) {
        saved.snowluma = saveSnowPassword(body.snowluma.trim()) ? 'ok' : 'too-short';
      }
      if (typeof body.astrbot === 'string' && body.astrbot.trim()) {
        saved.astrbot = saveAstrBotPassword(body.astrbot.trim()) ? 'ok' : 'fail';
      }
      if (typeof body.astrbotUser === 'string' && body.astrbotUser.trim()) {
        saved.astrbotUser = saveAstrBotUsername(body.astrbotUser.trim()) ? 'ok' : 'fail';
      }
      if (typeof body.mcsUser === 'string') {
        // 用户名允许清空（有些人的 MCS 就是没设用户名）
        cfg.mcsAccount.username = body.mcsUser.trim();
        mcsTouched = true;
      }
      if (typeof body.mcsPass === 'string' && body.mcsPass.length) {
        cfg.mcsAccount.password = body.mcsPass;
        mcsTouched = true;
      }
      if (mcsTouched) {
        writeCfg(cfg);
        mcs.session.invalidate();   // 换了密码，旧的登录态作废
        saved.mcs = 'ok';
      }

      return sendJson(res, {
        ok: true,
        saved,
        // 回读最新值，前端直接拿来刷新，不用再请求一次
        snowluma: readSnowPassword(),
        astrbot: readAstrBotPassword(),
        astrbotUser: readAstrBotUsername(),
        mcs: cfg.mcsAccount.password || '',
        mcsUser: cfg.mcsAccount.username || '',
      });
    }

    if (p === '/api/log') {
      const key = String(url.searchParams.get('key') || 'astrbot');
      return sendJson(res, { text: tailLog(key, Number(url.searchParams.get('lines')) || 200) });
    }

    // ---------- 组件管理 / 下载中心 ----------

    if (p === '/api/components') {
      return sendJson(res, {
        components: downloader.detect(),
        groups: GROUPS,
        progress: downloader.progress(),
        mirrors: MIRRORS,
        mirror: readCfg().download.mirror,
        version: TOOLBOX_VERSION,
      });
    }

    // 检查更新：只读，问问 GitHub 有没有新版
    if (p === '/api/components/check') {
      try {
        return sendJson(res, { ok: true, items: await downloader.checkUpdates() });
      } catch (e) {
        return sendJson(res, { ok: false, message: e.message }, 500);
      }
    }

    if (p === '/api/components/install' && req.method === 'POST') {
      const body = await readBody(req);
      const r = downloader.start(String(body.id || ''));
      return sendJson(res, r, r.ok ? 200 : 400);
    }

    if (p === '/api/components/update' && req.method === 'POST') {
      const body = await readBody(req);
      const r = downloader.start(String(body.id || ''), { force: true });
      return sendJson(res, r, r.ok ? 200 : 400);
    }

    if (p === '/api/components/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const r = downloader.cancel(String(body.id || ''));
      return sendJson(res, r, r.ok ? 200 : 400);
    }

    if (p === '/api/components/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const r = downloader.remove(String(body.id || ''));
      return sendJson(res, r, r.ok ? 200 : 400);
    }

    if (p === '/api/appearance' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readCfg();
      if (body.theme && ['light', 'dark', 'auto'].includes(body.theme)) cfg.appearance.theme = body.theme;
      if (body.accent && /^[a-z]{3,12}$/.test(body.accent)) cfg.appearance.accent = body.accent;
      writeCfg(cfg);
      return sendJson(res, { ok: true, appearance: cfg.appearance });
    }

    if (p === '/api/download/mirror' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.mirror || 'auto');
      if (!MIRROR_BY_ID.has(id)) return sendJson(res, { ok: false, message: '没有这个下载源' }, 400);
      const cfg = readCfg();
      cfg.download.mirror = id;
      writeCfg(cfg);
      return sendJson(res, { ok: true, mirror: id });
    }

    if (p === '/api/config') {
      const cfg = readCfg();
      const L = resolveLayout();
      return sendJson(res, {
        port: cfg.port,
        version: TOOLBOX_VERSION,
        paths: cfg.paths,
        appearance: cfg.appearance,
        download: cfg.download,
        mirrors: MIRRORS,
        layout: {
          snowluma: L.snowlumaDir || '',
          astrbot: L.astrbotDir || '',
          mcs: L.mcsDir || '',
          data: L.dataRoot,
          components: COMPONENTS_ROOT,
          portable: fs.existsSync(COMPONENTS_ROOT),
        },
      });
    }

    if (p === '/api/quit' && req.method === 'POST') {
      sendJson(res, { ok: true });
      // 只关工具箱自己；已经拉起来的 AstrBot / MCS 不受影响
      setTimeout(() => process.exit(0), 200);
      return;
    }

    // ---------- 静态 ----------
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

    res.writeHead(405).end('method not allowed');
  } catch (e) {
    sendJson(res, { ok: false, message: e.message || String(e) }, 500);
  }
});

const cfg = readCfg();
server.listen(cfg.port, '127.0.0.1', () => {
  // 记下本次启动时间，启动器据此判断代码有没有比进程新
  try { fs.writeFileSync(BOOT_STAMP, String(Date.now())); } catch { /* 写不了就算了 */ }
  const url = `http://127.0.0.1:${cfg.port}/`;
  console.log('大肥鱼工具箱已启动 -> ' + url);
  startSnowProxy();
  if (process.argv.includes('--open')) {
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${cfg.port}/`;
    console.log('工具箱已经在运行了 -> ' + url);
    if (process.argv.includes('--open')) {
      execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    }
  } else {
    console.error('启动失败：' + e.message);
  }
  process.exit(1);
});
