/**
 * 组件下载 / 解压引擎
 * ------------------------------------------------------------
 * 零依赖：下载用 Node 内置 fetch，解压用 Windows 自带的 bsdtar（System32\tar.exe）。
 *
 * 一个组件的完整安装流程：
 *   1. 问 GitHub 最新 release（失败就用清单里写死的兜底文件）
 *   2. 断点续传下载到 components/.downloads/<id>.zip（带进度、速度、剩余时间）
 *   3. bsdtar 解压到临时目录
 *   4. 剥掉压缩包自带的顶层文件夹（AstrBot_4.29.3_windows_amd64_portable/ 之类）
 *   5. 校验关键文件是否存在，通过才移动到 components/<dir>
 *   6. 写 .tbx-install.json 记录版本，失败则回滚不留半成品
 *
 * 全程只写 components/ 和 data/ 两个目录，不碰系统任何地方。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CATALOG, byId, withMirror, AUTO_MIRROR_ORDER } from './components.mjs';
const UA = 'DaFeiYu-Toolbox/1.0 (+https://github.com/)';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const INSTALL_META = '.tbx-install.json';
const API_TTL = 30 * 60 * 1000; // GitHub API 缓存半小时，免得触发限流

// 下载健壮性参数（"卡在 92% 不动"就是靠这几个治的）
const STALL_MS = 45000;        // 45 秒没收到任何新字节 → 认定卡住
const MAX_STALL_RETRY = 5;     // 同一地址最多续传 5 次，还不行才换源
const PROBE_BYTES = 400 * 1024; // 试速只下 400 KB
const PROBE_TIMEOUT = 9000;

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
}

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

/** 比版本号：a>b 返回 1，a<b 返回 -1，相同返回 0。只认数字段，4.29.3 vs v4.29.1 这种也能比 */
function cmpVersion(a, b) {
  const parse = (s) =>
    String(s || '')
      .replace(/^v/i, '')
      .split(/[.\-+_]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
  const pa = parse(a);
  const pb = parse(b);
  if (!pa.length || !pb.length) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export class Downloader {
  /**
   * @param {object} o
   * @param {string} o.componentsRoot  组件安装根（<安装根>/components）
   * @param {string} o.downloadRoot    下载缓存（<安装根>/data/downloads）
   * @param {() => string} o.getMirror 返回当前镜像 id
   * @param {(item:object)=>string|null} o.locate
   *        返回该组件「实际生效的目录」。旧布局（组件散落在别的盘）靠它接进来，
   *        不传就默认只看 componentsRoot。
   */
  constructor({ componentsRoot, downloadRoot, getMirror, locate }) {
    this.componentsRoot = componentsRoot;
    this.downloadRoot = downloadRoot;
    this.getMirror = getMirror || (() => 'auto');
    this.locate = locate || ((item) => this.dirOf(item));
    this.apiCache = new Map();   // repo -> { at, release }
    this.jobs = new Map();       // id  -> 进度对象
    this.states = new Map();     // id  -> 上次安装结果

    fs.mkdirSync(this.componentsRoot, { recursive: true });
    fs.mkdirSync(this.downloadRoot, { recursive: true });
  }

  // ------------------------------------------------------------ 安装探测

  /** 安装目标目录（新装的装这儿） */
  dirOf(item) {
    return path.join(this.componentsRoot, item.dir);
  }

  /** 当前真正在用的目录：可能是便携装的，也可能是旧布局的 */
  activeDir(item) {
    try {
      const d = this.locate(item);
      return d && fs.existsSync(d) ? d : null;
    } catch { return null; }
  }

  /** 读组件目录里记录的安装信息 */
  metaOf(item) {
    const dir = this.activeDir(item);
    if (!dir) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, INSTALL_META), 'utf8'));
    } catch { return null; }
  }

  /** 组件是否已经装好（关键文件都在才算数） */
  isInstalled(item) {
    const dir = this.activeDir(item);
    if (!dir) return false;
    return item.marker.every((rel) => fs.existsSync(path.join(dir, rel)));
  }

  /** 从各组件自己的文件里尽量读出真实版本号 */
  readVersion(item) {
    const meta = this.metaOf(item);
    if (meta && meta.version) return meta.version;
    const dir = this.activeDir(item);
    if (!dir) return '';
    try {
      if (item.id === 'snowluma') {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
        if (j.version) return j.version;
      }
      if (item.id === 'mcsmanager') {
        // 面板版本在 web/package.json（10.x）。daemon/package.json 里的 4.x 是守护进程自己的
        // 版本号，跟 GitHub release tag 不是一回事，拿它比会一直误报"有更新"。
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'web', 'package.json'), 'utf8'));
        if (j.version) return j.version;
      }
      if (item.id === 'astrbot') {
        // Electron 包根目录没有 package.json，版本藏在目录名 AstrBot_4.29.1_windows_amd64_portable 里
        const m = dir.match(/AstrBot_([\d.]+)_/i);
        if (m) return m[1];
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app', 'package.json'), 'utf8'));
        if (j.version) return j.version;
      }
    } catch { /* 读不到就算了 */ }
    return '';
  }

  /** 所有组件的安装状态（给 /api/components 用） */
  detect() {
    return CATALOG.map((item) => {
      const installed = this.isInstalled(item);
      const job = this.jobs.get(item.id);
      const dir = installed ? this.activeDir(item) || '' : '';
      return {
        id: item.id,
        name: item.name,
        tagline: item.tagline,
        desc: item.desc,
        group: item.group || '',
        sizeHint: item.sizeHint,
        required: !!item.required,
        homepage: item.homepage,
        hint: item.hint,
        installed,
        version: installed ? this.readVersion(item) : '',
        dir,
        // 装在工具箱自己的 components/ 下才允许一键更新/卸载（外部目录不代管）
        managed: !!dir && this._isManaged(dir),
        busy: !!(job && job.status !== 'idle' && job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled'),
        job: job ? this.publicJob(job) : null,
      };
    });
  }

  /** 目录是否位于 componentsRoot 之内 */
  _isManaged(dir) {
    const a = path.resolve(dir).toLowerCase();
    const b = path.resolve(this.componentsRoot).toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  }

  // ------------------------------------------------------------ 检查更新

  /**
   * 逐个问 GitHub 要最新版，跟本机已装的版本比。只读，不动任何文件。
   * @returns {Promise<Array<object>>}
   */
  async checkUpdates() {
    const out = [];
    for (const item of CATALOG) {
      if (!this.isInstalled(item)) continue;

      const current = this.readVersion(item);
      const dir = this.activeDir(item) || '';
      const managed = !!dir && this._isManaged(dir);
      const busy = !!this.jobs.get(item.id) &&
        !['idle', 'done', 'error', 'cancelled'].includes(this.jobs.get(item.id).status);

      let latest = '';
      let size = 0;
      let error = '';
      try {
        const rel = await this.fetchLatest(item);
        latest = rel.version;
        size = rel.size;
      } catch (e) {
        error = e && e.message ? e.message : String(e);
      }

      out.push({
        id: item.id,
        name: item.name,
        current,
        latest,
        size,
        error,
        managed,
        dir,
        busy,
        // 读不到本机版本时不敢说"有更新"，只把两个版本都报给前端
        hasUpdate: !!(latest && current && cmpVersion(latest, current) > 0),
        upToDate: !!(latest && current && cmpVersion(latest, current) === 0),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ 查最新版本

  async fetchLatest(item) {
    const hit = this.apiCache.get(item.repo);
    if (hit && Date.now() - hit.at < API_TTL) return hit.release;

    const r = await fetch(`https://api.github.com/repos/${item.repo}/releases/latest`, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error('GitHub 返回 ' + r.status + (r.status === 403 ? '（可能被限流）' : ''));
    const j = await r.json();

    const assets = Array.isArray(j.assets) ? j.assets : [];
    const pick = assets.find((a) => item.assetPattern.test(a.name));
    if (!pick) throw new Error('最新版里没找到匹配的安装包（' + item.assetPattern + '）');

    const release = {
      version: String(j.tag_name || '').replace(/^v/i, ''),
      tag: j.tag_name,
      name: pick.name,
      size: pick.size,
      url: pick.browser_download_url,
      publishedAt: j.published_at,
    };
    this.apiCache.set(item.repo, { at: Date.now(), release });
    return release;
  }

  /** 拿不到 GitHub 信息时的兜底：用清单里写死的文件名走 latest/download */
  fallbackRelease(item) {
    return {
      version: (item.builtinAsset.match(/(\d+\.\d+(?:\.\d+)?)/) || [, ''])[1],
      tag: '',
      name: item.builtinAsset,
      size: 0,
      url: `https://github.com/${item.repo}/releases/latest/download/${item.builtinAsset}`,
      publishedAt: '',
      fallback: true,
    };
  }

  // ------------------------------------------------------------ 进度

  publicJob(job) {
    const percent = job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0;
    return {
      id: job.id,
      status: job.status,
      received: job.received,
      total: job.total,
      percent,
      speed: job.speed,
      speedText: job.speed ? fmtBytes(job.speed) + '/s' : '',
      receivedText: fmtBytes(job.received),
      totalText: job.total ? fmtBytes(job.total) : '',
      etaText: job.eta > 0 && job.eta < 86400 ? formatEta(job.eta) : '',
      version: job.version,
      asset: job.asset,
      message: job.message,
      error: job.error,
    };
  }

  progress() {
    const out = {};
    for (const [id, job] of this.jobs) out[id] = this.publicJob(job);
    return out;
  }

  // ------------------------------------------------------------ 下载

  /**
   * 开始安装一个组件。立即返回，进度通过 poll 拿。
   * @param {string} id
   * @param {{force?:boolean}} [opts] force=true 表示更新：允许覆盖已装的版本
   * @returns {{ok:boolean, message?:string}}
   */
  start(id, opts = {}) {
    const force = !!opts.force;
    const item = byId(id);
    if (!item) return { ok: false, message: '没有这个组件' };

    const running = this.jobs.get(id);
    if (running && !['idle', 'done', 'error', 'cancelled'].includes(running.status)) {
      return { ok: false, message: '这个组件正在处理中' };
    }
    // 同时只允许一个下载任务，避免把带宽和磁盘打满
    for (const [otherId, job] of this.jobs) {
      if (otherId !== id && !['idle', 'done', 'error', 'cancelled'].includes(job.status)) {
        return { ok: false, message: '另一个组件正在下载，请等它完成' };
      }
    }

    if (!force && this.isInstalled(item)) {
      return { ok: false, message: '已经装好了，不用重复下载' };
    }
    if (force) {
      // 更新只接管工具箱自己 components/ 里的那份，别处装的不代管
      const dir = this.activeDir(item);
      if (dir && !this._isManaged(dir)) {
        return { ok: false, message: '这个组件装在工具箱外面，为了安全不代你覆盖' };
      }
    }

    const job = {
      id,
      status: 'querying',
      force,
      received: 0,
      total: 0,
      speed: 0,
      eta: 0,
      version: '',
      asset: '',
      message: '正在查询最新版本…',
      error: null,
      abort: null,
      tickTimer: null,
      noResume: false,
    };
    this.jobs.set(id, job);

    this._run(item, job).catch((e) => {
      if (job.status === 'cancelled') return;
      job.status = 'error';
      job.error = e && e.message ? e.message : String(e);
      job.message = '安装失败';
      this._stopTick(job);
      job.abort = null;
    });

    return { ok: true };
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, message: '没有正在进行的任务' };
    if (['done', 'error', 'cancelled', 'idle'].includes(job.status)) {
      return { ok: false, message: '当前没有可取消的任务' };
    }
    job.status = 'cancelled';
    job.message = '已取消';
    this._stopTick(job);
    if (job.abort) { try { job.abort.abort(); } catch { /* ignore */ } }
    return { ok: true };
  }

  async _run(item, job) {
    // 1. 版本信息
    let rel;
    try {
      rel = await this.fetchLatest(item);
    } catch (e) {
      rel = this.fallbackRelease(item);
      job.message = '查询最新版失败，改用内置版本（' + rel.version + '）';
    }
    if (job.status === 'cancelled') return;

    job.version = rel.version;
    job.asset = rel.name;
    if (rel.size) job.total = rel.size;

    // 更新时先看一眼：本来就没旧版，就没必要白下 200 MB
    if (job.force) {
      const cur = this.readVersion(item);
      if (cur && rel.version && cmpVersion(rel.version, cur) <= 0) {
        job.status = 'done';
        job.version = cur;
        job.received = 1;
        job.total = 1;
        job.message = `已经是最新版 v${cur}`;
        return;
      }
    }

    // 2. 下载
    const mirror = this.getMirror();
    const zipPath = path.join(this.downloadRoot, `${item.id}.zip`);
    const partPath = zipPath + '.part';
    rmrf(zipPath);

    job.status = 'downloading';
    job.message = '正在下载 ' + rel.name;

    const urls = await this._pickUrls(job, rel, mirror);
    if (job.status === 'cancelled') return;

    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await this._downloadResilient(job, url, partPath);
        if (r && r.stalled) {
          lastErr = new Error('这个地址一直卡住');
          continue;
        }
        lastErr = null;
        break;
      } catch (e) {
        if (job.status === 'cancelled') return;
        lastErr = e;
        job.message = '这个下载地址不行，换下一个…';
        // 残片留着：换的只是源，字节还是同一份，续传能接着用
      }
    }
    if (lastErr) throw lastErr;
    if (job.status === 'cancelled') return; // 残片保留，下次点下载能续上

    fs.renameSync(partPath, zipPath);

    // 3. 解压
    job.status = 'extracting';
    job.message = '正在解压…';
    this._stopTick(job);

    const tmp = path.join(this.componentsRoot, `.tmp-${item.id}`);
    rmrf(tmp);
    fs.mkdirSync(tmp, { recursive: true });

    await runTar(['-xf', zipPath, '-C', tmp]);

    // 4. 剥掉压缩包自带的顶层文件夹
    let contentRoot = tmp;
    for (let depth = 0; depth < 3; depth++) {
      const names = fs.readdirSync(contentRoot).filter((n) => !n.startsWith('.'));
      if (names.length === 1) {
        const only = path.join(contentRoot, names[0]);
        if (fs.statSync(only).isDirectory()) { contentRoot = only; continue; }
      }
      break;
    }

    // 5. 校验关键文件
    const missing = item.marker.filter((rel2) => !fs.existsSync(path.join(contentRoot, rel2)));
    if (missing.length) {
      rmrf(tmp);
      throw new Error('压缩包内容不对劲，缺少 ' + missing.join('、') + '（下载可能不完整）');
    }

    // 6. 落位（更新时旧版本先改名保住，装成功才删；装失败自动还原）
    const dest = this.dirOf(item);
    const backup = dest + '.tbx-bak';
    rmrf(backup);
    const hadOld = fs.existsSync(dest);
    if (hadOld) {
      try {
        fs.renameSync(dest, backup);
      } catch {
        rmrf(tmp);
        throw new Error(`旧的 ${item.name} 还在运行，文件被占用。先把它关掉再更新`);
      }
    }
    try {
      if (contentRoot === tmp) {
        // 内容就在临时根下：整个搬过去
        fs.renameSync(tmp, dest);
      } else {
        fs.renameSync(contentRoot, dest);
        rmrf(tmp);
      }
    } catch (e) {
      // 搬不过去就把旧的还原，别留下个空目录
      rmrf(dest);
      if (hadOld) {
        try { fs.renameSync(backup, dest); } catch { /* 兜不住也没别的办法 */ }
      }
      throw new Error('安装落位失败：' + e.message);
    }
    rmrf(backup);

    fs.writeFileSync(
      path.join(dest, INSTALL_META),
      JSON.stringify(
        { id: item.id, version: rel.version, asset: rel.name, installedAt: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    );

    rmrf(zipPath);

    job.status = 'done';
    job.received = job.total || job.received;
    job.message = job.force ? '更新完成' : '安装完成';
    job.speed = 0;
    job.eta = 0;
  }

  /**
   * 决定用哪些地址下载。auto 模式先各试 400KB 测速，最快的排前面。
   * 这一步几秒钟，但能避免"挑了个龟速源硬耗半小时"。
   */
  async _pickUrls(job, rel, mirror) {
    if (mirror !== 'auto') return [withMirror(rel.url, mirror)];

    const cands = [rel.url, ...AUTO_MIRROR_ORDER.map((m) => withMirror(rel.url, m))];
    job.message = '正在挑最快的下载源…';
    const speeds = await Promise.all(cands.map((u) => this._probe(u).catch(() => 0)));
    const ranked = cands.map((u, i) => ({ u, s: speeds[i] || 0 })).sort((a, b) => b.s - a.s);

    if (ranked[0].s > 0) job.message = `已选最快的源（约 ${fmtBytes(ranked[0].s)}/s）`;
    this._probes = ranked.map((r) => ({ url: r.u, speed: r.s }));
    return ranked.map((r) => r.u);
  }

  /** 试速：只下一小段看看多快，超时/失败算 0 */
  async _probe(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    let got = 0;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Range: `bytes=0-${PROBE_BYTES - 1}` },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok && res.status !== 206) return 0;
      if (!res.body) return 0;
      for await (const chunk of Readable.fromWeb(res.body)) {
        got += chunk.length;
        if (got >= PROBE_BYTES) break;
      }
    } catch { /* 超时就按已拿到的算 */ }
    finally { clearTimeout(timer); }

    const dt = (Date.now() - t0) / 1000;
    return dt > 0.05 ? got / dt : 0;
  }

  /**
   * 同一个地址的下载，卡住 / 断线时**接着原进度续传**。
   * 这是治"卡在 92% 不动"的关键：换源要清零重来，续传不用。
   */
  async _downloadResilient(job, url, partPath) {
    for (let i = 0; i <= MAX_STALL_RETRY; i++) {
      if (job.status === 'cancelled') return { stalled: false };

      const r = await this._downloadOnce(job, url, partPath);
      if (!r || !r.stalled) return r || { stalled: false };
      if (job.status === 'cancelled') return { stalled: false };

      // 服务器不支持断点续传，重试也只是从头再来一遍，别白耗流量
      if (job.noResume) return { stalled: true };

      if (i < MAX_STALL_RETRY) {
        job.message = `连接卡了一下，从 ${job.percent}% 接着下（第 ${i + 1} 次重试）`;
        await new Promise((res) => setTimeout(res, 800));
      }
    }
    return { stalled: true };
  }

  /** 单次下载尝试（服务器不支持 Range 时自动从头下） */
  async _downloadOnce(job, url, partPath) {
    const ctrl = new AbortController();
    job.abort = ctrl;
    job.noResume = false;

    let start = 0;
    try { start = fs.statSync(partPath).size; } catch { start = 0; }

    const headers = { 'User-Agent': UA };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      // 416 表示本地残片已经完整
      if (res.status === 416 && start > 0) return { stalled: false };
      throw new Error('HTTP ' + res.status);
    }

    const isPartial = res.status === 206;
    if (start > 0 && !isPartial) {
      // 服务器不支持续传，只能从头来。打上标记，上层别再指望"续传能救回来"
      start = 0;
      job.noResume = true;
      rmrf(partPath);
    }

    const cr = res.headers.get('content-range'); // bytes 100-999/1000
    const total = cr ? Number(String(cr).split('/')[1]) || 0 : Number(res.headers.get('content-length')) || 0;
    job.total = total || job.total;
    job.received = start;

    const ws = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });

    // 进度节流：每 400ms 更新一次速度与剩余时间
    let lastAt = Date.now();
    let lastBytes = start;
    this._stopTick(job);
    job.tickTimer = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastAt) / 1000;
      if (dt <= 0) return;
      const inst = (job.received - lastBytes) / dt;
      job.speed = job.speed ? job.speed * 0.7 + inst * 0.3 : inst;
      if (job.speed > 0 && job.total > job.received) job.eta = Math.round((job.total - job.received) / job.speed);
      lastAt = now;
      lastBytes = job.received;
    }, 400);

    // 卡死看门狗：45 秒一个字节都没多，就主动断开交给上层续传
    let stalled = false;
    let seen = job.received;
    let movedAt = Date.now();
    const watchdog = setInterval(() => {
      if (job.received > seen) {
        seen = job.received;
        movedAt = Date.now();
        return;
      }
      if (Date.now() - movedAt >= STALL_MS) {
        stalled = true;
        clearInterval(watchdog);
        try { ctrl.abort(); } catch { /* ignore */ }
      }
    }, 5000);

    try {
      const src = Readable.fromWeb(res.body);
      src.on('data', (chunk) => { job.received += chunk.length; });
      await pipeline(src, ws);
    } catch (e) {
      if (stalled) return { stalled: true };
      throw e;
    } finally {
      clearInterval(watchdog);
      this._stopTick(job);
    }

    // 连接悄悄断了（没报错但字节不够）：交给上层续传
    if (job.total && job.received < job.total) return { stalled: true };
    return { stalled: false };
  }

  _stopTick(job) {
    if (job.tickTimer) { clearInterval(job.tickTimer); job.tickTimer = null; }
  }

  // ------------------------------------------------------------ 卸载

  /** 删除组件目录（不动用户存档数据） */
  remove(id) {
    const item = byId(id);
    if (!item) return { ok: false, message: '没有这个组件' };
    const job = this.jobs.get(id);
    if (job && !['idle', 'done', 'error', 'cancelled'].includes(job.status)) {
      return { ok: false, message: '正在下载，先取消再卸载' };
    }
    const dir = this.dirOf(item);
    if (!fs.existsSync(dir)) {
      return {
        ok: false,
        message: this.isInstalled(item)
          ? '这个组件装在工具箱外面（旧布局），为了安全不代你删除，需要的话手动清'
          : '本来就没装',
      };
    }
    try {
      rmrf(dir);
      this.jobs.delete(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: '删不掉，可能有文件被占用：' + e.message };
    }
  }
}

function formatEta(sec) {
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.ceil(sec / 60) + ' 分钟';
  return Math.ceil(sec / 3600) + ' 小时';
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile(TAR, args, { windowsHide: true, maxBuffer: 4 << 20 }, (err, _out, stderr) => {
      if (err) {
        reject(new Error('解压失败：' + (String(stderr || '').trim().split('\n').pop() || err.message)));
        return;
      }
      resolve();
    });
  });
}
