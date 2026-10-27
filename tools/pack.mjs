/**
 * 打包绿色版
 * ------------------------------------------------------------
 * 产出（默认）：dist/DaFeiYuToolbox-v<版本>/  +  同名 .zip
 *
 * 包结构（exe 放在根目录，双击即用）：
 *   DaFeiYuToolbox.exe            ← 启动这个（原生壳，无标题栏灰条/无浏览器）
 *   DaFeiYuToolbox.exe.config
 *   Microsoft.Web.WebView2.Core.dll
 *   Microsoft.Web.WebView2.WinForms.dll
 *   WebView2Loader.dll
 *   server/  web/  docs/
 *   runtime/node.exe              ← 自带 Node，解压即用
 *   components/                   ← 空目录 + 说明，组件首次运行后下载到这里
 *
 * 包里不放：
 *   · components/ 里已下载的组件（几百 MB）
 *   · data/       运行缓存、窗口几何、WebView2 缓存
 *   · server/config.json  含 MCS 账号密码，绝对不能外发
 *   · shell/ 源码（.cs / build.bat）—— 只取编译产物，免得包里一堆源码
 *   · 启动大肥鱼.vbs —— 已由原生壳 exe 取代；vbs 还会被杀软误报（实测被火绒删过）
 *
 * 用法：
 *   node tools/pack.mjs                                  输出到 dist/
 *   node tools/pack.mjs --out="D:\Apps\DaFeiYuToolbox"        直接输出到指定目录
 *   node tools/pack.mjs --no-node                        不带 Node（省 ~90MB）
 *   node tools/pack.mjs --no-zip                         只出目录不压缩
 *   node tools/pack.mjs --with-config                    打包后把 server/config.json 复制进
 *                                                        运行目录（自己用：复用现有组件与
 *                                                        密码文件）。注意：zip 里始终不含它。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const VERSION = '1.2.3';
const FOLDER = `DaFeiYuToolbox-v${VERSION}`;

const args = process.argv.slice(2);
const withNode = !args.includes('--no-node');
const noZip = args.includes('--no-zip');
const withConfig = args.includes('--with-config');
const nodeArg = args.find((a) => a.startsWith('--node='));
// 默认取「当前运行打包脚本的这个 node」，这样任何人 clone 下来都能直接打包，
// 不用去改本机绝对路径。要指定别的运行时用 --node=<完整路径>。
const NODE_SRC = nodeArg ? nodeArg.slice(7) : process.execPath;
const outArg = args.find((a) => a.startsWith('--out='));

// 目标目录：--out 指定则直接用（可运行目录），否则 dist/FOLDER
const OUT_DIR = outArg ? path.resolve(outArg.slice(6).replace(/^"|"$/g, '')) : path.join(DIST, FOLDER);
// 压缩包放目标目录的同级
const ZIP_DIR = path.dirname(OUT_DIR);
const ZIP_PATH = path.join(ZIP_DIR, FOLDER + '.zip');

// 整个目录原样复制进包的
const COPY_DIRS = ['server', 'web', 'docs'];
// 单文件复制进包（包内同名）
const COPY_FILES = ['说明.md', 'README.md'];
// 运行时会调用的辅助脚本。只带 stop-all.ps1 —— 它按端口 + 命令行关键词找进程，
// 不依赖任何绝对路径，所以放进运行目录后仍然有效（点「关闭」时服务端会调它）。
// 早期调试用的两个启动脚本（直连 5099 / 拉起 AstrBot）依赖固定的旧目录布局，
// 那套布局已废弃，脚本也已移出仓库，不进包。
const COPY_SCRIPTS = ['scripts/stop-all.ps1'];
// 原生壳产物：源 → 包内根目录（exe 必须在根目录，双击即用；
// 壳内部按「同级有 server/server.mjs」判断根目录，所以放根目录是对的）
const SHELL_FILES = [
  ['shell/DaFeiYuToolbox.exe', 'DaFeiYuToolbox.exe'],
  ['shell/DaFeiYuToolbox.exe.config', 'DaFeiYuToolbox.exe.config'],
  ['shell/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'],
  ['shell/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'],
  ['shell/WebView2Loader.dll', 'WebView2Loader.dll'],
];

// server 目录里这份是私人配置，必须排除
const EXCLUDE_FILES = new Set(['config.json']);

function log(msg) {
  process.stdout.write(msg + '\n');
}

function copyDir(src, dest, relBase = '') {
  fs.mkdirSync(dest, { recursive: true });
  const isServerDir = path.basename(src) === 'server';
  for (const name of fs.readdirSync(src)) {
    if (isServerDir && EXCLUDE_FILES.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDir(s, d, relBase ? relBase + '/' + name : name);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
}

function run(cmd, argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { cwd, windowsHide: true, maxBuffer: 8 << 20 }, (err, _o, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });
}

function human(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function dirSize(p) {
  let total = 0;
  for (const name of fs.readdirSync(p)) {
    const f = path.join(p, name);
    const st = fs.statSync(f);
    total += st.isDirectory() ? dirSize(f) : st.size;
  }
  return total;
}

// ---------------------------------------------------------------- 主流程

log(`\n大肥鱼工具箱 打包 v${VERSION}`);
log('─'.repeat(52));

log('[1/6] 清理目标');
// ⚠️ --out 指向的通常就是自己正在用的运行目录，里面除了程序本体还有三样东西不能丢：
//    components/          已下载的组件（SnowLuma / AstrBot / MCS，动辄几个 GB）
//    data/                下载缓存、日志、密码文件、窗口几何、WebView2 缓存
//    server/config.json   自己的 MCS 账号与路径配置
// 所以这里按「保留模式」清理：只删程序本体，上面三样原地留着。
// 否则一次打包就把装好的组件全删了 —— 2026-10-27 组件进 components/ 后差点踩这个雷。
//
// 注：源码现已迁到 D:\开发源码\DaFeiYuToolbox\（不在运行目录里），
// 本脚本的 ROOT 就是那里。KEEP_TOP 里保留 '_src' 只是防御性兜底：
// 万一以后又把源码临时放进运行目录，也不会被清理掉。
const KEEP_TOP = ['components', 'data', '_src'];
const cfgPathAtOut = path.join(OUT_DIR, 'server', 'config.json');
const liveMode = fs.existsSync(path.join(OUT_DIR, 'components'))
  || fs.existsSync(path.join(OUT_DIR, 'data'));
let cfgBackup = null;

fs.mkdirSync(OUT_DIR, { recursive: true });
if (cfgPathAtOut && fs.existsSync(cfgPathAtOut)) {
  try { cfgBackup = fs.readFileSync(cfgPathAtOut); } catch { /* ignore */ }
}

if (liveMode) {
  log('      → 保留模式（目标目录里有 components/ 或 data/，只清程序本体）');
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (KEEP_TOP.includes(name)) { log(`      · 保留 ${name}/`); continue; }
    rmrf(path.join(OUT_DIR, name));
  }
} else {
  rmrf(OUT_DIR);
}
rmrf(ZIP_PATH);
fs.mkdirSync(OUT_DIR, { recursive: true });
log(`      → ${OUT_DIR}`);

log('[2/6] 复制本体');
for (const entry of COPY_DIRS) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) { log(`      ! 跳过（不存在）：${entry}`); continue; }
  copyDir(src, path.join(OUT_DIR, entry), entry);
  log(`      + ${entry}/`);
}
for (const entry of COPY_FILES) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) { log(`      ! 跳过（不存在）：${entry}`); continue; }
  fs.copyFileSync(src, path.join(OUT_DIR, entry));
  log(`      + ${entry}`);
}
for (const rel of COPY_SCRIPTS) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { log(`      ! 跳过（不存在）：${rel}`); continue; }
  const dest = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  log(`      + ${rel}`);
}

log('[3/6] 放原生壳（exe + WebView2 依赖，全部进根目录）');
let shellMissing = 0;
for (const [rel, destName] of SHELL_FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    shellMissing++;
    log(`      ✗ 缺失：${rel}（先在 shell/ 里跑 build.bat）`);
    continue;
  }
  fs.copyFileSync(src, path.join(OUT_DIR, destName));
  log(`      + ${destName}`);
}
if (shellMissing) {
  log(`\n打包中止：原生壳缺少 ${shellMissing} 个文件。先编译：cd shell && build.bat`);
  process.exit(1);
}

log('[4/6] 校验关键文件');
const must = [
  'DaFeiYuToolbox.exe',
  'DaFeiYuToolbox.exe.config',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll',
  'server/server.mjs',
  'server/downloader.mjs',
  'server/components.mjs',
  'server/config.example.json',
  'web/index.html',
  'web/style.css',
  'web/app.js',
  'web/brand.ico',
  'web/manifest.json',
];
let bad = 0;
for (const rel of must) {
  if (!fs.existsSync(path.join(OUT_DIR, rel))) { bad++; log(`      ✗ 缺失：${rel}`); }
}
if (bad) { log(`\n打包中止：缺少 ${bad} 个必需文件`); process.exit(1); }
log('      全部就位');

// 私人配置绝不能进包
const cfg = path.join(OUT_DIR, 'server', 'config.json');
if (liveMode) {
  // 保留模式：config 是自己正在用的，不能删。
  // 注意 server/ 整个目录在 [2/6] 已经被重新复制过了，所以必须把开头缓存的写回去，
  // 否则自己的账号配置就没了（第一版就漏了这一步，测试时 config.json 直接消失）。
  if (cfgBackup) {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, cfgBackup);
    log('      · server/config.json 已还原（压缩时排除，zip 内不含）');
  } else {
    log('      · server/config.json 原本不存在，跳过');
  }
} else if (fs.existsSync(cfg)) {
  fs.rmSync(cfg);
  log('      ! 发现 config.json，已删除（不能外发账号密码）');
}
// data 目录也不该进包（运行缓存/窗口几何/WebView2 缓存）
const dataDir = path.join(OUT_DIR, 'data');
if (liveMode) {
  log('      · data/ 原地保留（压缩时排除，zip 内不含）');
} else if (fs.existsSync(dataDir)) {
  rmrf(dataDir);
  log('      ! 发现 data/，已删除（运行缓存）');
}

log('[5/6] 处理 Node 运行时');
if (withNode) {
  if (fs.existsSync(NODE_SRC)) {
    fs.mkdirSync(path.join(OUT_DIR, 'runtime'), { recursive: true });
    fs.copyFileSync(NODE_SRC, path.join(OUT_DIR, 'runtime', 'node.exe'));
    log(`      + runtime/node.exe (${human(fs.statSync(NODE_SRC).size)})`);
  } else {
    log(`      ! 找不到 ${NODE_SRC}，跳过。对方需要自己装 Node 22+`);
  }
} else {
  log('      按参数跳过（对方需要自己装 Node 22+）');
}

// 组件目录占位
fs.mkdirSync(path.join(OUT_DIR, 'components'), { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'components', '组件会下载到这里.txt'),
  '首次运行工具箱后，在「设置 → 组件管理」里下载即可。\r\n'
    + 'SnowLuma、AstrBot、MCSManager 都会解压到这个文件夹，各自独立。\r\n',
  'utf8'
);

if (noZip) {
  log('[6/6] 按参数跳过压缩');
  log(`\n完成 → ${OUT_DIR}`);
  log(`     大小 ${human(dirSize(OUT_DIR))}`);
} else {
  log('[6/6] 压缩');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const stageParent = path.dirname(OUT_DIR);
  const stageName = path.basename(OUT_DIR);
  try {
    // 排除项必须在路径列表之前。components/ 可能装着几 GB 组件、
    // data/ 是运行缓存、server/config.json 含账号密码 —— 这三样绝不能进分发包。
    await run(tar, [
      '-a', '-c', '-f', ZIP_PATH,
      '-C', stageParent,
      '--exclude=' + stageName + '/components',
      '--exclude=' + stageName + '/data',
      '--exclude=' + stageName + '/_src',
      '--exclude=' + stageName + '/server/config.json',
      stageName,
    ]);
    log(`\n完成`);
    log(`     可运行目录 ${OUT_DIR}  (${human(dirSize(OUT_DIR))})`);
    log(`     分发包     ${ZIP_PATH}  (${human(fs.statSync(ZIP_PATH).size)})`);
  } catch (e) {
    log(`\n压缩失败：${e.message}`);
    log(`目录已就绪，可手动压缩：${OUT_DIR}`);
    process.exit(1);
  }
}

// 关键：config 一定在压缩之后才复制进运行目录，
// 保证 zip（发给别人的那份）里永远不含 MCS 账号密码。
if (withConfig) {
  const srcCfg = path.join(ROOT, 'server', 'config.json');
  if (fs.existsSync(srcCfg)) {
    fs.copyFileSync(srcCfg, path.join(OUT_DIR, 'server', 'config.json'));
    log(`\n     已带入 server/config.json（含 MCS 账号与绝对路径）`);
    log(`     → 只给自己用；发出去的用上面那个 zip，它不含这个文件`);
  } else {
    log(`\n     ! --with-config 但源目录没有 server/config.json，跳过`);
  }
}

log(`\n试用：进入目录双击 DaFeiYuToolbox.exe`);
log(`发给朋友：解压后双击 DaFeiYuToolbox.exe，在设置里下载需要的组件。`);
