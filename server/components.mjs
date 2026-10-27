/**
 * 组件目录 —— 大肥鱼工具箱能下载安装的第三方软件
 * ------------------------------------------------------------
 * 设计原则：**不写死版本号**。
 *   运行时先去 GitHub 问最新 release，挑符合 assetPattern 的那个文件；
 *   网络不通 / API 限流时，退回 builtinAsset 指定的固定文件（保证永远下得到）。
 *
 * 换版本只需要改 builtinAsset 里的版本号和文件名，其余逻辑不用动。
 */

export const REPO_HOME = 'https://github.com';

/**
 * 板块分组 —— 设置里的下载中心按这个分块展示，每块带自己的介绍。
 * 组件用 group 字段挂到对应板块上。
 */
export const GROUPS = [
  {
    id: 'fish',
    name: 'QQ 机器人',
    sub: '大肥鱼本体',
    icon: 'fish',
    desc: 'SnowLuma 负责收发 QQ 消息，AstrBot 负责思考怎么回。两个装齐，在 QQ 里发消息她才会有反应。',
    note: '两个都要装',
    order: 10,
  },
  {
    id: 'mcs',
    name: 'Minecraft 服务器',
    sub: '开服面板',
    icon: 'server',
    desc: 'MCSManager 是给 Minecraft 开服用的网页面板：创建实例、看控制台、传整合包、定时重启，全在网页里点。',
    note: '不开服可以不装',
    order: 20,
  },
];

export const CATALOG = [
  {
    id: 'snowluma',
    name: 'SnowLuma',
    tagline: 'QQ 连接器',
    group: 'fish',
    desc: '把 QQ 消息转成标准接口，等于机器人的耳朵和嘴。必须先有它，AstrBot 才能收发消息。',
    repo: 'SnowLuma/SnowLuma',
    // 完整版（自带 Node.js）；刻意排除 -lite
    assetPattern: /^SnowLuma-v[\d.]+-win-x64\.zip$/i,
    builtinAsset: 'SnowLuma-v2.1.1-win-x64.zip',
    dir: 'snowluma',
    sizeHint: '约 130 MB',
    required: true,
    order: 10,
    homepage: 'https://github.com/SnowLuma/SnowLuma/releases',
    hint: '自动选完整版（内置 Node.js 运行时），不要 lite 版',
    // 认这个文件判断是否装好
    marker: ['node.exe', 'index.mjs'],
  },
  {
    id: 'astrbot',
    name: 'AstrBot',
    tagline: 'AI 机器人大脑',
    group: 'fish',
    desc: '接大模型、装插件、给机器人写人格。它的网页控制台会嵌在工具箱第一个栏位里。',
    repo: 'AstrBotDevs/AstrBot-desktop',
    assetPattern: /^AstrBot_[\d.]+_windows_amd64_portable\.zip$/i,
    builtinAsset: 'AstrBot_4.29.3_windows_amd64_portable.zip',
    dir: 'astrbot',
    sizeHint: '约 186 MB',
    required: true,
    order: 20,
    homepage: 'https://github.com/AstrBotDevs/AstrBot',
    hint: '需要系统已装 WebView2 运行时（Win11 自带，Win10 可能要单独装）',
    marker: ['AstrBot.exe'],
  },
  {
    id: 'mcsmanager',
    name: 'MCSManager',
    tagline: 'Minecraft 服务器面板',
    group: 'mcs',
    desc: '开服、看控制台、传文件、定时任务。不开 Minecraft 的话这个可以不装。',
    repo: 'MCSManager/MCSManager',
    assetPattern: /^mcsmanager_windows_release\.zip$/i,
    builtinAsset: 'mcsmanager_windows_release.zip',
    dir: 'mcsmanager',
    sizeHint: '约 92 MB',
    required: false,
    order: 30,
    homepage: 'https://mcsmanager.com/',
    hint: '完整包，含守护进程 + 网页面板',
    marker: ['web/node_app.exe', 'daemon/node_app.exe'],
  },
];

/** 下载加速镜像：前面拼在原始 GitHub 地址上即可 */
export const MIRRORS = [
  { id: 'auto', name: '自动（直连优先，失败换镜像）', prefix: '' },
  { id: 'direct', name: 'GitHub 直连', prefix: '' },
  { id: 'ghproxy', name: 'ghproxy.net 镜像', prefix: 'https://ghproxy.net/' },
  { id: 'ghproxycom', name: 'gh-proxy.com 镜像', prefix: 'https://gh-proxy.com/' },
];

/** auto 模式下依次尝试的镜像（实测直连最快，所以镜像只作兜底） */
export const AUTO_MIRROR_ORDER = ['ghproxy', 'ghproxycom'];

export const MIRROR_BY_ID = new Map(MIRRORS.map((m) => [m.id, m]));

export function byId(id) {
  return CATALOG.find((c) => c.id === id) || null;
}

/** 某个板块下的组件（按 order 排好） */
export function ofGroup(groupId) {
  return CATALOG.filter((c) => (c.group || '') === groupId).sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** 把原始下载地址套上镜像前缀 */
export function withMirror(url, mirrorId) {
  if (!mirrorId || mirrorId === 'direct' || mirrorId === 'auto') return url;
  const m = MIRROR_BY_ID.get(mirrorId);
  if (!m || !m.prefix) return url;
  return m.prefix + url;
}
