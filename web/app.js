/* ==========================================================================
   大肥鱼工具箱 · 前端逻辑
   --------------------------------------------------------------------------
   结构：
     0  统一入口与工具
     1  视觉特效（光晕 / 水波纹）
     2  顶栏与栏位切换
     3  状态渲染
     4  任务步骤
     5  大肥鱼操作
     6  浮层（AstrBot / 日志）
     7  MCS
     8  设置面板（组件 / 账号 / 外观 / 教程 / 关于）
     9  主题应用
    10  初始化
   ========================================================================== */
(() => {
  'use strict';

  // ---------------------------------------------------------------- 工具

  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // cookie 不分端口，但认 host。统一用 127.0.0.1，MCS 的登录态才能共享。
  if (location.hostname === 'localhost') {
    location.replace('http://127.0.0.1:' + (location.port || '8788') + location.pathname);
    return;
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    let data = null;
    try { data = await r.json(); } catch { /* 非 JSON */ }
    return { http: r.status, ok: r.ok, data: data || {} };
  }
  const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 去掉终端颜色控制符，日志里一堆 [0m 很难看
  function stripAnsi(s) {
    return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\[\d+m/g, '');
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .35s, transform .35s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 400);
    }, kind === 'err' ? 4200 : 2400);
  }

  // ---------------------------------------------------------------- 视觉特效

  const glow = $('#cursorGlow');
  let mx = innerWidth / 2, my = innerHeight / 2, cx = mx, cy = my;
  addEventListener('pointermove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    glow.style.opacity = '1';
  }, { passive: true });

  (function loop() {
    cx += (mx - cx) * 0.14;
    cy += (my - cy) * 0.14;
    glow.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    requestAnimationFrame(loop);
  })();

  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('.glowable');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('.btn, .icon-btn, .card.action, .set-tab, .swatch, .seg-item');
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const ink = document.createElement('span');
    ink.className = 'ripple';
    ink.style.width = ink.style.height = size + 'px';
    ink.style.left = e.clientX - r.left + 'px';
    ink.style.top = e.clientY - r.top + 'px';
    el.appendChild(ink);
    setTimeout(() => ink.remove(), 680);
  }, { passive: true });

  // ---------------------------------------------------------------- 栏位切换

  const tabs = $('#tabs');
  const tabsTrack = $('#tabsTrack');
  const tabPrev = $('#tabPrev');
  const tabNext = $('#tabNext');
  const tabAdd = $('#tabAdd');
  const indicator = $('#tabIndicator');
  let currentPane = 'fish';

  // 顶栏最多同时露出几个栏位，超出的用箭头翻
  const TABS_VISIBLE = 2;
  const TAB_FADE = 20;

  function moveIndicator() {
    const btn = tabsTrack.querySelector('.tab.is-active');
    if (!btn) return;
    indicator.style.left = btn.offsetLeft + 'px';
    indicator.style.width = btn.offsetWidth + 'px';
  }

  /** 量前 N 个 tab 的总宽，决定顶栏最宽多少；再看要不要出翻页箭头 */
  function layoutTabs() {
    const items = $$('.tab:not(.tab-add)', tabsTrack);

    if (items.length > TABS_VISIBLE) {
      let w = 0;
      for (let i = 0; i < TABS_VISIBLE; i++) w += items[i].offsetWidth;
      w += 4 * (TABS_VISIBLE - 1); // track 内的 gap
      // 轨道以外那些固定件：两个 22px 箭头 + 40px 加号 + 加号左边 6px 间距
      // + 三段 2px gap + 自身 5px*2 padding。改这几个尺寸时记得同步这里。
      w += 22 * 2 + 40 + 6 + 2 * 3 + 10;
      tabs.style.setProperty('--tabs-max', Math.ceil(w) + 'px');
    } else {
      tabs.style.removeProperty('--tabs-max');
    }

    const over = tabsTrack.scrollWidth > tabsTrack.clientWidth + 1;
    tabs.classList.toggle('has-overflow', over);
    updateTabFade();
  }

  /** 滚到哪边，哪边才淡出 */
  function updateTabFade() {
    const el = tabsTrack;
    const max = el.scrollWidth - el.clientWidth;
    const x = el.scrollLeft;
    el.style.setProperty('--fade-l', (x > 2 ? TAB_FADE : 0) + 'px');
    el.style.setProperty('--fade-r', (max - x > 2 ? TAB_FADE : 0) + 'px');
    if (max > 0) {
      tabPrev.disabled = x <= 1;
      tabNext.disabled = max - x <= 1;
    }
  }

  /** 切换后让选中的 tab 自己滚进可见范围 */
  function scrollTabIntoView(btn) {
    if (!btn) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    const viewLeft = tabsTrack.scrollLeft;
    const viewRight = viewLeft + tabsTrack.clientWidth;
    if (left < viewLeft) {
      tabsTrack.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    } else if (right > viewRight) {
      tabsTrack.scrollTo({ left: right - tabsTrack.clientWidth + 8, behavior: 'smooth' });
    }
  }

  function switchPane(name) {
    currentPane = name;
    $$('.tab:not(.tab-add)').forEach((t) => t.classList.toggle('is-active', t.dataset.pane === name));
    $$('.pane').forEach((p) => p.classList.toggle('is-active', p.id === 'pane-' + name));
    moveIndicator();
    scrollTabIntoView(tabsTrack.querySelector('.tab.is-active'));
    // 顶栏药丸跟着栏位走，切换时立刻刷新，不等下一次轮询
    renderGlobalPill();
    if (name === 'mcs') {
      autoTried = false;
      autoEnterMcs();
    }
  }

  // 绑在整条 .tabs 上：轨道里的栏位和轨道外的加号都能点到
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    // 「+」不切栏位，直接进下载中心
    if (btn.dataset.pane === 'add') return openSettings('components');
    switchPane(btn.dataset.pane);
  });

  tabPrev.addEventListener('click', () => tabsTrack.scrollBy({ left: -140, behavior: 'smooth' }));
  tabNext.addEventListener('click', () => tabsTrack.scrollBy({ left: 140, behavior: 'smooth' }));
  tabsTrack.addEventListener('scroll', updateTabFade, { passive: true });

  const relayoutTabs = () => {
    layoutTabs();
    moveIndicator();
  };

  addEventListener('resize', relayoutTabs);

  // ---------------------------------------------------------------- 状态

  let status = null;
  let stepsSignature = '';
  let mcsEntered = false;
  let mcsBusy = false;
  let config = null;

  /** 一次都没装过组件时的"空壳"状态；null = 还不知道 */
  let emptyMode = null;
  /** 板块定义（后端下发） */
  let groups = [];

  function setStat(card, on, text, warn) {
    const el = $(card);
    if (!el) return;
    el.classList.toggle('is-on', !!on);
    el.classList.toggle('is-warn', !on && !!warn);
    el.querySelector('.dot').className = 'dot ' + (on ? 'on' : warn ? 'warn' : '');
    el.querySelector('.stat-text').textContent = text;
  }

  const compOf = (id) => (status && status.components ? status.components.find((c) => c.id === id) : null);
  const installed = (id) => {
    const c = compOf(id);
    return !!(c && c.installed);
  };

  /** 顶栏那颗状态药丸：只反映「当前这个栏位」自己的服务。
      以前是把大肥鱼（AstrBot/SnowLuma）和 MCS（面板/守护进程）一起算的，
      结果大肥鱼全停着、MCS 在后台跑，大肥鱼页也会亮「运行中」，很误导。
      现在四种状态：未运行 / 启动中 / 停止中 / 运行中。 */
  function renderGlobalPill() {
    const s = status;
    if (!s) return;
    const dot = $('#globalDot');
    const txt = $('#globalText');
    const pill = $('#livePill');
    if (!dot || !txt) return;

    const f = s.fish || {};
    const m = s.mcs || {};
    const fishOn = !!(f.astrbot || f.snowluma);
    const mcsOn = !!(m.web || m.daemon);

    // 大肥鱼页看大肥鱼，MCS 页看 MCS，空壳页看全部
    const on = currentPane === 'mcs' ? mcsOn
      : currentPane === 'fish' ? fishOn
      : (fishOn || mcsOn);

    // 只认「发生在当前栏位」的任务，别把 MCS 的启动显示到大肥鱼页
    const kind = s.task && s.task.running ? s.task.kind : null;
    const kindFish = kind === 'dafeiyu' || kind === 'dafeiyu-stop';
    const kindMcs = kind === 'mcs' || kind === 'mcs-stop';
    const busy = currentPane === 'mcs' ? kindMcs
      : currentPane === 'fish' ? kindFish
      : !!kind;
    const stopping = kind === 'dafeiyu-stop' || kind === 'mcs-stop';

    dot.className = 'dot' + (busy ? ' busy' : on ? ' on' : '');
    txt.textContent = busy
      ? (stopping ? '停止中' : '启动中')
      : on ? '运行中' : '未运行';
    if (pill) {
      pill.classList.toggle('on', on && !busy);
      pill.classList.toggle('busy', !!busy);
    }
  }

  function renderStatus(s) {
    status = s;

    // 外观（后端是唯一真相，localStorage 只用来加速首屏）
    if (s.appearance) applyAppearance(s.appearance);

    // 大肥鱼
    const f = s.fish;
    setStat('#statAstrbot', f.astrbot, f.astrbot ? '运行中' : '未运行');
    setStat('#statSnow', f.snowluma, f.snowluma ? '运行中' : '未运行');
    setStat('#statChannel', f.channel, f.channel ? '已连接' : f.snowluma ? '等 QQ 进程' : '未连接', f.snowluma && !f.channel);
    $('#consoleLed').classList.toggle('on', !!f.astrbot);

    // 缺组件提示
    const missing = [];
    if (!installed('snowluma')) missing.push('SnowLuma');
    if (!installed('astrbot')) missing.push('AstrBot');
    const box = $('#fishMissing');
    if (box) {
      box.hidden = missing.length === 0;
      if (missing.length) {
        $('#fishMissingText').textContent =
          '需要 ' + missing.join(' 和 ') + ' 才能跑起来，去下载一下，几十秒的事。';
      }
    }
    $('#btnFishStartText').textContent = missing.length ? '去下载' : '启动大肥鱼';

    // 顶栏总状态（只反映当前栏位）
    renderGlobalPill();

    // MCS
    const m = s.mcs;
    $('#chipWeb').classList.toggle('on', m.web);
    $('#chipDaemon').classList.toggle('on', m.daemon);
    $('#chipInst').textContent =
      m.instances == null ? '实例 —' : `实例 ${m.runningInstances || 0}/${m.instances}`;
    $('#chipInst').classList.toggle('on', m.instances != null);

    const mcsMissing = !m.installed;
    $('#btnMcsStartText').textContent = mcsMissing ? '去下载' : (m.web ? '进入面板' : '启动并进入');
    $('#mcsHeroSub').textContent = mcsMissing
      ? '还没安装 MCSManager。不开 Minecraft 服务器的话，这一栏可以不装。'
      : '守护进程 + 网页面板。启动后自动登录，直接进主界面。';

    // 按钮状态
    const busy = s.task && s.task.running;
    $('#btnFishStart').disabled = !!busy;
    $('#btnFishStop').disabled = !!busy;
    $('#btnMcsStart').disabled = !!busy;
    $('#btnMcsStop').disabled = !!busy;
    $('#btnMcsStartBig').disabled = !!busy;

    // 组件列表（设置面板里）
    if (s.components) {
      if (Array.isArray(s.groups) && s.groups.length) groups = s.groups;
      syncLayoutMode(s.components);
      renderComponents(s.components);
    }

    renderTask(s.task);

    if (currentPane === 'mcs') {
      renderMcsEmpty();
      autoEnterMcs();
    }
  }

  // ---------------------------------------------------------------- 空壳引导页

  function sizeNum(hint) {
    const m = String(hint || '').match(/([\d.]+)\s*(GB|MB)/i);
    if (!m) return 0;
    return parseFloat(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : 1);
  }

  function renderWelcome(list) {
    const box = $('#welcomeGrid');
    if (!box || !groups.length) return;

    box.innerHTML = groups
      .map((g) => {
        const items = list.filter((c) => c.group === g.id);
        if (!items.length) return '';
        const mb = items.reduce((n, c) => n + sizeNum(c.sizeHint), 0);
        return `
          <div class="welcome-item">
            <div class="welcome-item-head">
              <span class="welcome-item-icon"><svg class="i" viewBox="0 0 24 24"><use href="${g.icon === 'server' ? '#i-server' : '#i-fish'}"/></svg></span>
              <strong>${escapeHtml(g.name)}</strong>
              <span class="welcome-item-sub">${escapeHtml(g.sub || '')}</span>
            </div>
            <p>${escapeHtml(g.desc || '')}</p>
            <span class="welcome-item-meta">${items.map((c) => escapeHtml(c.name)).join(' + ')}${mb ? ' · 约 ' + Math.round(mb) + ' MB' : ''}</span>
          </div>`;
      })
      .join('');
  }

  /** 一个组件都没装 → 顶栏只剩一个 +，主界面换成下载引导 */
  function syncLayoutMode(list) {
    const isEmpty = list.filter((c) => c.installed).length === 0;
    if (emptyMode === isEmpty) return;

    const first = emptyMode === null;
    emptyMode = isEmpty;
    tabs.classList.toggle('is-empty', isEmpty);
    renderWelcome(list);

    if (isEmpty) {
      switchPane('welcome');
      return;
    }
    // 装完第一个组件后自己跳回合适的栏位
    if (first || currentPane === 'welcome') {
      const hasFish = list.some((c) => c.installed && c.group === 'fish');
      const hasMcs = list.some((c) => c.installed && c.group === 'mcs');
      switchPane(hasFish || !hasMcs ? 'fish' : 'mcs');
    }
  }

  // ---------------------------------------------------------------- 组件列表

  let compSig = '';
  /** 检查更新的结果：Map<id, info> */
  let updates = null;

  const COMP_ICON = {
    snowluma: '#i-spark',
    astrbot: '#i-fish',
    mcsmanager: '#i-server',
  };

  const updOf = (id) => (updates ? updates.get(id) : null);
  const updState = (c) => {
    const u = updOf(c.id);
    if (!u) return '';
    if (u.hasUpdate) return 'new:' + u.latest;
    if (u.upToDate) return 'ok';
    return '?';
  };

  function groupHtml(g, items) {
    if (!items.length) return '';
    const done = items.filter((c) => c.installed).length;
    return `
      <section class="comp-group">
        <header class="comp-group-head">
          <span class="comp-group-mark"><svg class="i" viewBox="0 0 24 24"><use href="${g.icon === 'server' ? '#i-server' : '#i-fish'}"/></svg></span>
          <div class="comp-group-txt">
            <div class="comp-group-title">
              ${escapeHtml(g.name)}
              <small>${escapeHtml(g.sub || '')}</small>
            </div>
            <p class="comp-group-desc">${escapeHtml(g.desc || '')}</p>
          </div>
          <span class="comp-group-note">${done}/${items.length} 已装</span>
        </header>
        <div class="comp-list">${items.map(compCardHtml).join('')}</div>
      </section>`;
  }

  function renderComponents(list) {
    const box = $('#compList');
    if (!box) return;

    const sig =
      list
        .map((c) => `${c.id}:${c.installed ? 1 : 0}:${c.job ? c.job.status : '-'}:${c.version || ''}:${updState(c)}`)
        .join('|') +
      '#' + groups.map((g) => g.id).join(',');

    if (sig !== compSig) {
      compSig = sig;
      const grouped = groups.length
        ? groups.map((g) => groupHtml(g, list.filter((c) => c.group === g.id))).join('')
        : '';
      // 分组拿不到（或没匹配上）就退回平铺，别让面板空着
      box.innerHTML = grouped || list.map(compCardHtml).join('');
      bindCompActions();
    }

    // 进度条单独更新（比重建整块平滑）
    for (const c of list) {
      const wrap = $('#prog-' + c.id);
      const bar = $('#bar-' + c.id);
      const txt = $('#ptxt-' + c.id);
      if (!wrap) continue;
      const j = c.job;
      const active = j && ['querying', 'downloading', 'extracting'].includes(j.status);
      wrap.hidden = !active;
      if (active) {
        if (bar) bar.style.width = (j.percent || 0) + '%';
        if (txt) txt.textContent = compProgressText(j);
      }
    }

    // 侧边栏角标：有几个没装
    const notInstalled = list.filter((c) => !c.installed).length;
    const badge = $('#badgeComponents');
    if (badge) {
      badge.hidden = notInstalled === 0;
      badge.textContent = String(notInstalled);
    }
  }

  function compProgressText(j) {
    if (j.status === 'querying') return '正在查询最新版本…';
    if (j.status === 'extracting') return '下载完成，正在解压…';
    if (j.status === 'downloading') {
      const parts = [`${j.percent}%`, `${j.receivedText} / ${j.totalText}`];
      if (j.speedText) parts.push(j.speedText);
      if (j.etaText) parts.push('剩 ' + j.etaText);
      return parts.join(' · ');
    }
    return j.message || '';
  }

  function compCardHtml(c) {
    const j = c.job;
    const busy = !!(j && ['querying', 'downloading', 'extracting'].includes(j.status));
    const failed = !!(j && j.status === 'error');
    const up = updOf(c.id);

    const badges = [];
    if (c.installed) badges.push('<span class="comp-badge ok">已安装</span>');
    else if (c.required) badges.push('<span class="comp-badge req">必需</span>');
    else badges.push('<span class="comp-badge req">可选</span>');
    if (c.installed && up && up.hasUpdate) badges.push('<span class="comp-badge new">可更新</span>');

    let meta = '';
    if (c.installed) {
      meta = `v${escapeHtml(c.version || '未知版本')}`;
      if (up && up.hasUpdate) meta += ` → v${escapeHtml(up.latest)}`;
      meta += ` · ${escapeHtml(c.dir || '')}`;
    } else if (busy) {
      meta = '正在安装…';
    } else if (failed) {
      meta = '上次失败：' + escapeHtml(j.error || '未知原因');
    } else {
      meta = `未安装 · ${escapeHtml(c.sizeHint || '')}`;
    }

    const cls = ['comp-card'];
    if (c.installed) cls.push('is-installed');
    if (busy) cls.push('is-busy');

    let actions = '';
    if (busy) {
      actions = `<button class="btn btn-ghost btn-sm glowable" data-comp-cancel="${c.id}">取消</button>`;
    } else if (c.installed) {
      if (up && up.hasUpdate && up.managed) {
        actions =
          `<button class="btn btn-primary btn-sm glowable" data-comp-update="${c.id}">
            <svg class="i" viewBox="0 0 24 24"><use href="#i-arrow-up"/></svg>
            <span>更新</span>
          </button>` +
          `<button class="btn btn-ghost btn-sm glowable" data-comp-remove="${c.id}">卸载</button>`;
      } else if (up && up.hasUpdate && !up.managed) {
        actions =
          `<button class="btn btn-ghost btn-sm glowable" data-comp-release="${c.id}" title="这个组件装在工具箱外面，需要手动替换">手动更新</button>` +
          `<button class="btn btn-ghost btn-sm glowable" data-comp-remove="${c.id}">卸载</button>`;
      } else {
        actions = `<button class="btn btn-ghost btn-sm glowable" data-comp-remove="${c.id}">卸载</button>`;
      }
    } else {
      actions = `
        <button class="btn btn-primary btn-sm glowable" data-comp-install="${c.id}">
          <svg class="i" viewBox="0 0 24 24"><use href="#i-download"/></svg>
          <span>下载</span>
        </button>`;
    }

    return `
      <div class="${cls.join(' ')}" data-id="${c.id}">
        <div class="comp-icon"><svg class="i" viewBox="0 0 24 24"><use href="${COMP_ICON[c.id] || '#i-package'}"/></svg></div>
        <div class="comp-main">
          <div class="comp-title">
            ${escapeHtml(c.name)}
            <small>${escapeHtml(c.tagline || '')}</small>
            ${badges.join('')}
          </div>
          <div class="comp-desc">${escapeHtml(c.desc || '')}</div>
          <div class="comp-meta" title="${meta}">${meta}</div>
          <div class="comp-progress" id="prog-${c.id}" ${busy ? '' : 'hidden'}>
            <div class="comp-bar"><i id="bar-${c.id}" style="width:${busy && j ? j.percent : 0}%"></i></div>
            <div class="comp-progress-txt" id="ptxt-${c.id}">${busy && j ? escapeHtml(compProgressText(j)) : ''}</div>
          </div>
        </div>
        <div class="comp-actions">${actions}</div>
      </div>`;
  }

  function bindCompActions() {
    const box = $('#compList');
    if (!box) return;
    box.onclick = async (e) => {
      const inst = e.target.closest('[data-comp-install]');
      const canc = e.target.closest('[data-comp-cancel]');
      const rem = e.target.closest('[data-comp-remove]');
      const upd = e.target.closest('[data-comp-update]');
      const rel = e.target.closest('[data-comp-release]');

      if (inst) {
        const id = inst.dataset.compInstall;
        inst.disabled = true;
        const r = await post('/api/components/install', { id });
        if (!r.ok) {
          inst.disabled = false;
          return toast(r.data.message || '启动下载失败', 'err');
        }
        toast('开始下载…');
        compSig = '';
        poll();
        return;
      }

      if (canc) {
        const id = canc.dataset.compCancel;
        const r = await post('/api/components/cancel', { id });
        if (!r.ok) return toast(r.data.message || '取消失败', 'err');
        toast('已取消');
        compSig = '';
        poll();
        return;
      }

      if (upd) return updateComponent(upd.dataset.compUpdate);
      if (rel) return openReleaseInfo(rel.dataset.compRelease);

      if (rem) {
        const id = rem.dataset.compRemove;
        const c = (status.components || []).find((x) => x.id === id);
        if (!confirm(`卸载 ${c ? c.name : id}？\n\n只删程序文件，不删你的聊天记录和配置。`)) return;
        const r = await post('/api/components/remove', { id });
        if (!r.ok) return toast(r.data.message || '卸载失败', 'err');
        toast('已卸载');
        if (updates) updates.delete(id);
        compSig = '';
        poll();
      }
    };
  }

  // ---- 检查更新 / 更新

  let checking = false;
  let checkedAt = 0;

  function setUpdateDesc(text) {
    const el = $('#updateDesc');
    if (el) el.textContent = text;
  }

  async function checkUpdates(manual) {
    if (checking) return;
    checking = true;
    const btn = $('#btnCheckUpdate');
    const label = btn ? btn.querySelector('span') : null;
    const oldText = label ? label.textContent : '';
    if (btn) btn.disabled = true;
    if (label) label.textContent = '检查中…';
    setUpdateDesc('正在问 GitHub 有没有新版本…');

    try {
      const r = await api('/api/components/check');
      if (!r.ok) {
        setUpdateDesc('检查失败：' + ((r.data && r.data.message) || '网络不通'));
        if (manual) toast('检查失败，可能是网络问题', 'err');
        return;
      }
      const items = r.data.items || [];
      updates = new Map(items.map((i) => [i.id, i]));
      checkedAt = Date.now();
      compSig = ''; // 让卡片重建，把「可更新」标记带出来
      if (status && status.components) renderComponents(status.components);
      reportUpdates(items, manual);
    } catch {
      setUpdateDesc('检查失败，网络好像不太通');
      if (manual) toast('检查失败，可能是网络问题', 'err');
    } finally {
      checking = false;
      if (btn) btn.disabled = false;
      if (label) label.textContent = oldText;
    }
  }

  function reportUpdates(items, manual) {
    if (!items.length) {
      setUpdateDesc('还没有装任何组件，装完再来检查更新。');
      return;
    }
    const newer = items.filter((i) => i.hasUpdate);
    const failed = items.filter((i) => i.error);

    if (newer.length) {
      setUpdateDesc(
        `${newer.length} 个有新版本：` +
          newer.map((i) => `${i.name} v${i.current} → v${i.latest}`).join('、')
      );
      if (manual) toast(`有 ${newer.length} 个组件可以更新`, 'ok');
      return;
    }
    if (failed.length) {
      setUpdateDesc('查不到最新版本：' + failed[0].error + '（网络问题的话换个下载源再试）');
      if (manual) toast('检查没成功，看看下面的说明', 'err');
      return;
    }
    const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    setUpdateDesc(`全部都是最新版（${t} 检查）`);
    if (manual) toast('已经是最新版了', 'ok');
  }

  /** 等某个组件的下载任务结束 */
  async function waitComponentJob(id, timeoutMs = 900000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await api('/api/status');
      if (r.ok && r.data && r.data.fish) renderStatus(r.data);
      const c = compOf(id);
      const j = c && c.job;
      if (j && ['done', 'error', 'cancelled'].includes(j.status)) return j;
      await sleep(900);
    }
    return null;
  }

  async function updateComponent(id) {
    const c = (status.components || []).find((x) => x.id === id);
    const u = updOf(id);
    const name = c ? c.name : id;
    const from = u ? u.current : c && c.version;
    const to = u ? u.latest : '最新版';

    if (
      !confirm(
        `更新 ${name}？\n\n${from ? '现在 v' + from + ' → ' : ''}v${to}\n\n` +
          '只替换程序文件，配置、插件和聊天记录都留着。\n' +
          `下载量约 ${c && c.sizeHint ? c.sizeHint : '一两百 MB'}，期间别开这个软件。`
      )
    )
      return;

    const r = await post('/api/components/update', { id });
    if (!r.ok) return toast(r.data.message || '更新失败', 'err');

    toast('开始更新 ' + name + '…');
    compSig = '';
    poll();

    const j = await waitComponentJob(id);
    if (!j) return toast('等太久了，去日志看看进度', 'err');
    if (j.status === 'error') return toast('更新失败：' + j.error, 'err');
    if (j.status === 'cancelled') return toast('已取消更新');

    if (updates) updates.delete(id);
    compSig = '';
    setUpdateDesc(`${name} 已更新到 v${j.version || to}`);
    toast(`${name} 已更新到 v${j.version || to}`, 'ok');
    poll();
  }

  /** 装在工具箱外面的组件：自动更新不代管，说清楚该去哪儿手动换 */
  function openReleaseInfo(id) {
    const c = (status.components || []).find((x) => x.id === id);
    if (!c) return;
    const u = updOf(id);
    const more = confirm(
      `${c.name} 装在工具箱外面：\n${c.dir || '（路径未知）'}\n\n` +
        `自动更新只接管工具箱自己 components/ 里的那份，这份得手动换。\n\n` +
        `现在 v${u && u.current ? u.current : c.version || '?'}，最新 v${u && u.latest ? u.latest : '?'}\n\n` +
        `现在打开 GitHub 下载页吗？下下来解压，用里面的文件夹替换上面那个路径。`
    );
    if (more && c.homepage) window.open(c.homepage, '_blank');
  }

  // ---------------------------------------------------------------- 任务步骤

  const STEP_ICON = { pending: '', active: '', done: '✓', fail: '✕', skipped: '–' };
  let hideStepsTimer = null;
  let stepsCollapsed = false;

  function renderTask(t) {
    const box = $('#fishSteps');
    if (!t || (!t.running && !t.steps.length)) {
      box.hidden = true;
      return;
    }

    const isFishTask = t.kind === 'dafeiyu' || t.kind === 'dafeiyu-stop';
    const isMcsTask = t.kind === 'mcs' || t.kind === 'mcs-stop';
    const show = (isFishTask && currentPane === 'fish') || (isMcsTask && currentPane === 'mcs');
    if (!show) {
      box.hidden = true;
      stepsSignature = '';
      return;
    }

    if (t.running) {
      stepsCollapsed = false;
      clearTimeout(hideStepsTimer);
      hideStepsTimer = null;
    } else if (stepsCollapsed) {
      box.hidden = true;
      return;
    }

    const sig = JSON.stringify(t.steps.map((x) => [x.label, x.status, x.note])) + '|' + t.running + '|' + (t.error || '');
    if (sig === stepsSignature) return;
    stepsSignature = sig;

    box.hidden = false;

    // 标题按具体任务类型给，别用 isFishTask 这种合并判断 ——
    // 那样「关闭」也会显示成「正在启动」，跟下面的步骤文案自相矛盾。
    let title;
    if (t.running) {
      if (t.kind === 'dafeiyu-stop') title = '正在关闭大肥鱼…';
      else if (t.kind === 'dafeiyu') title = '正在启动大肥鱼…';
      else if (t.kind === 'mcs-stop') title = '正在关闭 MCS…';
      else if (t.kind === 'mcs') title = '正在启动 MCS…';
      else title = '正在处理…';
    } else {
      title = t.error ? '出错了' : '已完成';
    }
    $('#stepsTitle').textContent = title;

    const isStopTask = t.kind === 'dafeiyu-stop' || t.kind === 'mcs-stop';

    $('#stepsSpinner').className = 'spinner' + (t.running ? '' : ' done');
    $('#stepsHint').textContent = t.running
      ? (isStopTask ? '马上就好，别关页面' : '大概 1 分钟，别关页面')
      : t.error ? '看下面的提示或日志' : '全部完成';

    $('#stepsList').innerHTML = t.steps
      .map((s) => {
        const icon = STEP_ICON[s.status] || '';
        return `<li class="${s.status}">
          <span class="step-dot">${icon}</span>
          <span class="step-label">${escapeHtml(s.label)}</span>
          ${s.note ? `<span class="step-note">${escapeHtml(s.note)}</span>` : ''}
        </li>`;
      })
      .join('');

    if (!t.running && !t.error) {
      clearTimeout(hideStepsTimer);
      hideStepsTimer = setTimeout(() => {
        stepsCollapsed = true;
        box.hidden = true;
      }, 7000);
    }
  }

  // ---------------------------------------------------------------- 轮询

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const r = await api('/api/status');
      if (r.ok && r.data && r.data.fish) renderStatus(r.data);
    } catch { /* 服务可能刚重启 */ }
    finally { polling = false; }
  }

  async function refreshConsole() {
    const r = await api('/api/log?key=astrbot&lines=8');
    const text = stripAnsi((r.data && r.data.text) || '').trim();
    const body = $('#consoleBody');
    if (!text) { body.textContent = '还没有日志，启动大肥鱼后这里会实时滚动。'; return; }
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-5);
    body.innerHTML = lines
      .map((raw) => {
        const l = raw.length > 190 ? raw.slice(0, 190) + '…' : raw;
        let cls = 'ln-dim';
        if (/ERROR|Traceback|错误|失败|Exception/i.test(l)) cls = 'ln-err';
        else if (/INFO|成功|已启动|已连接|running/i.test(l)) cls = 'ln-ok';
        return `<span class="${cls}">${escapeHtml(l)}</span>`;
      })
      .join('\n');
  }

  (async function consoleTick() {
    await sleep(800);
    await refreshConsole();
    await sleep(4000);
    consoleTick();
  })();

  (async function tick() {
    await poll();
    await sleep(1200);
    tick();
  })();

  async function waitTask(timeoutMs = 240000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await api('/api/task');
      if (r.ok) {
        renderTask(r.data);
        if (!r.data.running) return r.data;
      }
      await sleep(600);
    }
    return null;
  }

  // ---------------------------------------------------------------- 大肥鱼操作

  function goInstall() {
    openSettings('components');
  }

  $('#btnFishStart').addEventListener('click', async () => {
    if (!installed('snowluma') || !installed('astrbot')) return goInstall();
    const r = await post('/api/fish/start');
    if (!r.ok) return toast(r.data.message || '启动失败', 'err');
    toast('开始启动大肥鱼…');
    const t = await waitTask();
    if (!t) return toast('等待超时，看运行日志', 'err');
    if (t.error) return toast('启动出错：' + t.error, 'err');
    toast('大肥鱼已就绪，去 QQ 找她吧', 'ok');
    poll();
  });

  $('#btnFishGoInstall').addEventListener('click', goInstall);
  $('#btnWelcomeInstall').addEventListener('click', goInstall);

  $('#btnFishStop').addEventListener('click', async () => {
    const r = await post('/api/fish/stop');
    if (!r.ok) return toast(r.data.message || '停止失败', 'err');
    toast('正在停止…');
    await waitTask(90000);
    toast('已全部停止', 'ok');
    poll();
  });

  // ---------------------------------------------------------------- AstrBot 浮层

  const sheetAstrbot = $('#sheetAstrbot');

  $('#btnOpenAstrbot').addEventListener('click', () => {
    if (!status || !status.fish.astrbot) return toast('AstrBot 还没启动，先点「启动大肥鱼」', 'err');
    // 带时间戳，避免拿到打完补丁前的旧 index.html 缓存
    $('#astrbotFrame').src = 'http://127.0.0.1:6185/?_t=' + Date.now();
    sheetAstrbot.hidden = false;
  });
  $('#btnSheetBack').addEventListener('click', () => { sheetAstrbot.hidden = true; });
  $('#btnSheetReload').addEventListener('click', () => {
    $('#astrbotFrame').src = 'http://127.0.0.1:6185/?_t=' + Date.now();
  });

  // ---------------------------------------------------------------- SnowLuma

  // ---------------------------------------------------------------- SnowLuma 视图
  // 跟初版一样的形态：点开之后内容区整块换成 SnowLuma，顶栏不动，
  // hero 上有「返回」。iframe 指向 5100 反代 —— SnowLuma 原站送
  // X-Frame-Options: DENY，直连 5099 会被浏览器拒绝渲染。
  const fishMain = $('#fishMain');
  const snowView = $('#snowView');
  const snowFrame = $('#snowFrame');
  const snowHero = $('#snowHero');
  const btnSnowFold = $('#btnSnowFold');

  function setSnowHeroFolded(folded) {
    if (!snowHero || !btnSnowFold) return;
    snowHero.classList.toggle('is-folded', folded);
    btnSnowFold.setAttribute('aria-expanded', String(!folded));
    btnSnowFold.title = folded ? '展开操作栏' : '收起操作栏';
  }

  function openSnowView() {
    fishMain.hidden = true;
    snowView.hidden = false;
    setSnowHeroFolded(false); // 刚进来给完整操作栏
    snowFrame.src = 'http://127.0.0.1:5100/?_t=' + Date.now();
  }

  function closeSnowView() {
    snowView.hidden = true;
    fishMain.hidden = false;
    snowFrame.removeAttribute('src'); // 释放，别让它在后台挂着连接
  }

  $('#btnOpenSnow').addEventListener('click', () => {
    if (!status || !status.fish.snowluma) return toast('SnowLuma 还没启动，先点「启动大肥鱼」', 'err');
    openSnowView();
  });

  $('#btnSnowBack').addEventListener('click', closeSnowView);

  $('#btnSnowReload').addEventListener('click', () => {
    snowFrame.src = 'http://127.0.0.1:5100/?_t=' + Date.now();
  });

  if (btnSnowFold && snowHero) {
    btnSnowFold.addEventListener('click', () => {
      setSnowHeroFolded(!snowHero.classList.contains('is-folded'));
    });
  }

  // ---------------------------------------------------------------- 日志浮层

  const sheetLog = $('#sheetLog');
  let currentLog = 'astrbot';

  async function loadLog() {
    $('#logBody').textContent = '加载中…';
    const r = await api('/api/log?key=' + encodeURIComponent(currentLog) + '&lines=400');
    $('#logBody').textContent = stripAnsi((r.data && r.data.text) || '') || '（这个日志还是空的）';
    $('#logBody').scrollTop = $('#logBody').scrollHeight;
  }

  $('#btnLogs').addEventListener('click', () => {
    sheetLog.hidden = false;
    loadLog();
  });
  $('#btnLogBack').addEventListener('click', () => { sheetLog.hidden = true; });
  $('#btnLogReload').addEventListener('click', loadLog);
  $('#logTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.mini-tab');
    if (!b) return;
    $$('#logTabs .mini-tab').forEach((x) => x.classList.toggle('is-active', x === b));
    currentLog = b.dataset.log;
    loadLog();
  });

  // ---------------------------------------------------------------- MCS

  const frame = $('#mcsFrame');
  const empty = $('#mcsEmpty');
  const mcsHero = $('#mcsHero');
  const btnMcsFold = $('#btnMcsFold');
  let mcsNeedSetup = false;

  /** 展开 / 收起上方操作栏。面板一进来就自动收起，把高度让给 iframe。
      三个状态标签（面板/守护/实例）始终留在细栏上，收起了也看得见服务还活着。 */
  function setMcsHeroFolded(folded) {
    if (!mcsHero || !btnMcsFold) return;
    mcsHero.classList.toggle('is-folded', folded);
    btnMcsFold.setAttribute('aria-expanded', String(!folded));
    btnMcsFold.title = folded ? '展开操作栏' : '收起操作栏';
  }

  if (btnMcsFold && mcsHero) {
    btnMcsFold.addEventListener('click', () => {
      setMcsHeroFolded(!mcsHero.classList.contains('is-folded'));
    });
  }

  function showMcsFrame() {
    empty.hidden = true;
    frame.hidden = false;
    if (!frame.getAttribute('src')) frame.src = 'http://127.0.0.1:23333/';
    setMcsHeroFolded(true);
  }

  function hideMcsFrame() {
    empty.hidden = false;
    frame.hidden = true;
    frame.removeAttribute('src');
    setMcsHeroFolded(false);
  }

  /** 空态文案跟着实际情况变，别让人以为没启动 */
  function renderMcsEmpty() {
    if (!empty || empty.hidden) return;
    const running = !!(status && status.mcs.web);
    const hasPwd = !!(status && status.account && status.account.hasPassword);
    const mcsInstalled = installed('mcsmanager');
    const h2 = empty.querySelector('h2');
    const p = $('#mcsEmptyText');
    const btnText = $('#btnMcsStartBig span');

    if (!mcsInstalled) {
      h2.textContent = '还没安装 MCSManager';
      p.innerHTML = '这是一个 Minecraft 服务器管理面板。不开服的话不需要它；想用的话点下面的按钮，几十秒就能装好。';
      btnText.textContent = '去下载';
    } else if (running && hasPwd) {
      h2.textContent = 'MCS 正在运行';
      p.innerHTML = '面板和守护进程都已经起来了。点下面的按钮<strong>免密进入</strong>，直接到主界面。';
      btnText.textContent = '免密进入';
    } else if (running && !hasPwd) {
      h2.textContent = '还差一步：设置一次密码';
      p.innerHTML = 'MCS 已经跑起来了。为了免去每次输密码，先填一次 MCS 面板密码，之后就能直接进。';
      btnText.textContent = '设置密码并进入';
    } else {
      h2.textContent = 'MCS 服务器还没起来';
      p.innerHTML = '点下面的按钮把守护进程和面板一起拉起来，然后自动登录进入主界面——不用输密码。';
      btnText.textContent = '一键启动';
    }
  }

  // 3 秒内不重复登录。后端也有节流，这里是第二道闸 ——
  // 曾经因为某个循环每 1-2 秒登录一次，上千次请求把 MCS 面板拖崩过。
  let lastLoginAt = 0;

  async function mcsLogin(silent) {
    if (Date.now() - lastLoginAt < 3000) return false;
    lastLoginAt = Date.now();

    const r = await post('/api/mcs/login');
    if (r.http === 428 || (r.data && r.data.needSetup)) {
      mcsNeedSetup = true;
      if (!silent) openSettings('account');
      renderMcsEmpty();
      return false;
    }
    if (!r.data || !r.data.ok) {
      if (!silent) toast((r.data && r.data.message) || '免密登录失败', 'err');
      return false;
    }
    mcsNeedSetup = false;
    frame.src = 'http://127.0.0.1:23333/?_t=' + Date.now();
    showMcsFrame();
    return true;
  }

  async function startMcsFlow() {
    if (mcsBusy) return;
    if (!installed('mcsmanager')) return openSettings('components');

    mcsBusy = true;
    try {
      const already = status && status.mcs.web;
      if (!already) {
        const r = await post('/api/mcs/start');
        if (!r.ok) return toast(r.data.message || '启动失败', 'err');
        toast('正在启动 MCS…');
        const t = await waitTask(150000);
        if (!t) return toast('等待超时，看运行日志', 'err');
        if (t.error) return toast('启动出错：' + t.error, 'err');
      }
      const ok = await mcsLogin(false);
      if (ok) toast('已免密进入 MCS 面板', 'ok');
      mcsEntered = true;
      poll();
    } finally {
      mcsBusy = false;
    }
  }

  $('#btnMcsStart').addEventListener('click', startMcsFlow);
  $('#btnMcsStartBig').addEventListener('click', startMcsFlow);

  $('#btnMcsRelogin').addEventListener('click', async () => {
    if (!status || !status.mcs.web) return toast('MCS 还没启动', 'err');
    if (await mcsLogin(false)) toast('已重新登录', 'ok');
  });

  $('#btnMcsStop').addEventListener('click', async () => {
    const r = await post('/api/mcs/stop');
    if (!r.ok) return toast(r.data.message || '停止失败', 'err');
    toast('正在停止 MCS…');
    await waitTask(60000);
    hideMcsFrame();
    mcsEntered = false;
    toast('MCS 已停止', 'ok');
    poll();
  });

  let autoTried = false;
  async function autoEnterMcs() {
    if (mcsEntered || autoTried) return;
    if (!status || !status.mcs.web) return;
    if (frame.getAttribute('src')) return;
    autoTried = true;
    const ok = await mcsLogin(true);
    if (ok) mcsEntered = true;
    else renderMcsEmpty();
  }

  // ---------------------------------------------------------------- 设置面板

  const sheetSettings = $('#sheetSettings');

  function setSection(name) {
    $$('.set-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.sec === name));
    $$('.set-sec').forEach((s) => s.classList.toggle('is-active', s.id === 'sec-' + name));
    const body = $('.set-body');
    if (body) body.scrollTop = 0;
  }

  // ---------------------------------------------------------------- 各组件访问密码
  // 三个密码框都是**可编辑输入框**，并且「口令以面板为准」：
  //   打开设置 → 把本机记录的值填进来 → 你改完点「保存并登录」→ 写回本机文件。
  // 自动登录 / 免密注入读的就是这几个文件，所以保存即生效，不会有
  // 「面板显示新密码、自动登录还在用旧的」这种分裂状态。
  //   snowluma：data/snowluma-pw.txt（启动时 seed 用，反代改密后也会自动回写）
  //   astrbot ：data/astrbot-pw.txt（首启生成；面板里登录/改密时由页面补丁回传）
  //   astrbotUser：data/astrbot-user.txt，没手填过就回落到 cmd_config.json
  //   mcs     ：server/config.json 的 mcsAccount
  const PW_INPUT = {
    snowluma: '#inpSnowlumaPass',
    astrbot: '#inpAstrBotPass',
    mcs: '#inpPass',
  };

  const pwInput = (k) => $(PW_INPUT[k]);

  // 打开设置时 MCS 密码的快照，用来判断「这次保存到底有没有改 MCS 密码」——
  // 没改就别去登一次 MCS，否则只改 AstrBot 密码也会弹一句「MCS 登录没成功」，很误导。
  let mcsPassSnapshot = '';

  /** 复制到剪贴板；无权限时退回「临时 textarea + execCommand」的老办法 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 走下面的兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 真复制不了就手抄 */ }
    ta.remove();
    return ok;
  }

  /** 把后端读到的值填进各输入框，并把「显示」按钮复位成密文状态 */
  function fillCredentials(d) {
    for (const k of Object.keys(PW_INPUT)) {
      const el = pwInput(k);
      if (!el) continue;
      el.value = d[k] || '';
      el.type = 'password';
    }
    const u = $('#inpAstrBotUser');
    if (u) u.value = String(d.astrbotUser || '').trim();
    // 密码还是空的（说明日志里也没捞到），给一条能照着做的指引，别让人干瞪眼
    const warn = $('#warnAstrbotPw');
    if (warn) warn.hidden = !!String(d.astrbot || '').trim() || !installed('astrbot');
    $$('[data-pw][data-act="eye"]').forEach((b) => { b.textContent = '显示'; });
    const m = pwInput('mcs');
    mcsPassSnapshot = m ? m.value : '';
  }

  /**
   * 没装的组件不占版面：MCS / SnowLuma / AstrBot 三块各自只在装了之后才出现。
   * 「各组件的访问密码」这个分组标题也只在底下还剩东西时才显示。
   */
  function applyCredVisibility() {
    // status 还没拉到（components 缺失）时一律显示，宁可多显示也别把人要用的藏了
    const list = status && Array.isArray(status.components) ? status.components : null;
    const has = (id) => (list ? list.some((c) => c.id === id && c.installed) : true);
    const hasMcs = has('mcsmanager');
    const hasSnow = has('snowluma');
    const hasBot = has('astrbot');
    const set = (sel, on) => {
      const el = $(sel);
      if (el) el.hidden = !on;
    };
    set('#mcsCredBlock', hasMcs);
    set('#rowCredSnowluma', hasSnow);
    set('#rowCredAstrbot', hasBot);
    set('#rowCredAstrbotUser', hasBot);
    set('#rowPatchAstrbot', hasBot);
    set('#credTitleBlock', hasSnow || hasBot);
  }

  async function loadCredentials() {
    const r = await api('/api/credentials');
    fillCredentials((r.ok && r.data) || {});
    applyCredVisibility();
  }

  // AstrBot 账号的复制按钮（密码那几个走下面的 data-pw 通用逻辑）
  (function bindAstrBotUserCopy() {
    const btn = $('#btnAstrBotUserCopy');
    const inp = $('#inpAstrBotUser');
    if (!btn || !inp) return;
    btn.addEventListener('click', async () => {
      const v = inp.value.trim();
      if (!v) return toast('还没有 AstrBot 账号', 'err');
      await copyText(v);
      toast('已复制 AstrBot 账号', 'ok');
    });
  })();

  // 「显示 / 复制」对所有密码框通用：按 data-pw 找到对应的 input，
  // 显示就切 type，复制就取框里的当前值（你刚改的也能直接复制）。
  $$('[data-pw]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const inp = pwInput(btn.dataset.pw);
      if (!inp) return;
      if (btn.dataset.act === 'eye') {
        const reveal = inp.type === 'password';
        inp.type = reveal ? 'text' : 'password';
        btn.textContent = reveal ? '隐藏' : '显示';
        return;
      }
      const v = inp.value.trim();
      if (!v) return toast('还没有密码，先启动一次或直接填在框里', 'err');
      await copyText(v);
      toast('已复制密码', 'ok');
    });
  });

  async function openSettings(section) {
    // 拉一次配置，拿目录信息与下载源
    if (!config) {
      const r = await api('/api/config');
      if (r.ok) config = r.data;
    }
    const acc = (status && status.account) || {};
    $('#inpUser').value = acc.username || '';
    // 密码统一由 loadCredentials 从 /api/credentials 填（以本机记录的为准），
    // 这里只保证是密文状态，别让上次点过「显示」的框亮着。
    $('#inpPass').type = 'password';

    await loadCredentials();

    renderAbout();
    renderMirrors();

    sheetSettings.hidden = false;
    setSection(section || 'components');
    if (section === 'account' && installed('mcsmanager')) setTimeout(() => $('#inpPass').focus(), 80);

    // 进到下载中心就顺手查一下版本（3 分钟内不重复查，免得刷 GitHub）
    if ((section || 'components') === 'components' && Date.now() - checkedAt > 180000) {
      checkUpdates(false);
    }
  }

  function closeSettings() {
    sheetSettings.hidden = true;
  }

  $$('.set-tab').forEach((b) => {
    b.addEventListener('click', () => setSection(b.dataset.sec));
  });

  $('#btnSettings').addEventListener('click', () => openSettings('components'));
  $('#btnSettingsCancel').addEventListener('click', closeSettings);
  $('#btnSettingsClose').addEventListener('click', closeSettings);
  $('#btnSettingsX').addEventListener('click', closeSettings);

  sheetSettings.addEventListener('click', (e) => {
    if (e.target === sheetSettings) closeSettings();
  });

  // ---- 检查更新

  $('#btnCheckUpdate').addEventListener('click', () => checkUpdates(true));

  // ---- 下载源

  function renderMirrors() {
    const sel = $('#selMirror');
    if (!sel || !config || !config.mirrors) return;
    const cur = (config.download && config.download.mirror) || 'auto';
    sel.innerHTML = config.mirrors
      .map((m) => `<option value="${m.id}"${m.id === cur ? ' selected' : ''}>${escapeHtml(m.name)}</option>`)
      .join('');
  }

  $('#selMirror').addEventListener('change', async (e) => {
    const r = await post('/api/download/mirror', { mirror: e.target.value });
    if (!r.ok) return toast('保存失败', 'err');
    if (config && config.download) config.download.mirror = e.target.value;
    toast('下载源已切换', 'ok');
  });

  // ---- 账号保存

  $('#btnSettingsSave').addEventListener('click', async () => {
    // 一次提交三组值。空字段后端会跳过（留空 = 不修改）。
    const body = {
      mcsUser: $('#inpUser').value.trim(),
      mcsPass: $('#inpPass').value,
      astrbotUser: $('#inpAstrBotUser').value.trim(),
      astrbot: $('#inpAstrBotPass').value,
      snowluma: $('#inpSnowlumaPass').value,
    };
    // 先判断 MCS 密码有没有真的改，再决定保存后要不要去验一次登录
    const mcsChanged = !!body.mcsPass && body.mcsPass !== mcsPassSnapshot;
    const r = await post('/api/credentials', body);
    if (!r.ok || (r.data && r.data.ok === false)) {
      const msg = r.data && r.data.message ? '：' + r.data.message : '';
      return toast('保存失败' + msg, 'err');
    }

    const saved = (r.data && r.data.saved) || {};
    fillCredentials(r.data || {});
    applyCredVisibility();

    if (saved.snowluma === 'too-short') {
      // 没存进去，就别把他刚打的字冲掉
      const el = pwInput('snowluma');
      if (el) el.value = body.snowluma;
      return toast('SnowLuma 密码至少 8 位，这一项没保存', 'err');
    }

    // MCS 密码这次真的改了，就顺手登录一次，顺便验证对不对
    if (mcsChanged && installed('mcsmanager')) {
      toast('已保存，正在登录 MCS…');
      const ok = await mcsLogin(false);
      if (ok) {
        closeSettings();
        toast('免密登录成功', 'ok');
        poll();
        return;
      }
      return toast('已保存，但 MCS 登录没成功，密码可能不对', 'err');
    }
    toast('已保存，下次打开面板就用这个密码', 'ok');
  });

  $('#btnPatch').addEventListener('click', async () => {
    if (!confirm('给 AstrBot 的 webui/index.html 插入免密脚本？\n原文件会备份成 index.html.tbx-bak。')) return;
    const r = await post('/api/astrbot/patch');
    if (!r.ok || (r.data && r.data.ok === false)) return toast((r.data && r.data.message) || '打补丁失败', 'err');
    toast(r.data.changed ? '免密补丁已写入，重新打开面板即可' : '补丁已经是最新的，不用重打', 'ok');
  });

  // ---- 外观

  let appearance = { theme: 'light', accent: 'blue' };

  function applyAppearance(a) {
    if (a.theme) appearance.theme = a.theme;
    if (a.accent) appearance.accent = a.accent;

    const dark =
      appearance.theme === 'dark' ||
      (appearance.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);

    const root = document.documentElement;
    const nextTheme = dark ? 'dark' : 'light';
    if (root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
    if (root.dataset.accent !== appearance.accent) root.dataset.accent = appearance.accent;

    try {
      localStorage.setItem('tbx-appearance', JSON.stringify(appearance));
    } catch { /* 隐私模式忽略 */ }

    // 桌面壳（Edge 应用窗口）会拿这个色染标题栏，跟顶栏保持一个调
    const meta = document.getElementById('themeColorMeta');
    if (meta) meta.setAttribute('content', dark ? '#101827' : '#eef3fb');

    $$('#segTheme .seg-item').forEach((b) => b.classList.toggle('is-active', b.dataset.theme === appearance.theme));
    $$('#swatches .swatch').forEach((b) => b.classList.toggle('is-active', b.dataset.accent === appearance.accent));
  }

  $('#segTheme').addEventListener('click', async (e) => {
    const b = e.target.closest('.seg-item');
    if (!b) return;
    applyAppearance({ theme: b.dataset.theme });
    const r = await post('/api/appearance', { theme: b.dataset.theme });
    if (!r.ok) return toast('保存失败', 'err');
    if (config && config.appearance) config.appearance.theme = b.dataset.theme;
  });

  $('#swatches').addEventListener('click', async (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    applyAppearance({ accent: b.dataset.accent });
    const r = await post('/api/appearance', { accent: b.dataset.accent });
    if (!r.ok) return toast('保存失败', 'err');
    if (config && config.appearance) config.appearance.accent = b.dataset.accent;
  });

  // 跟随系统时，系统切换要立刻响应
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appearance.theme === 'auto') applyAppearance(appearance);
  });

  // ---- 关于

  async function renderAbout() {
    if (!config) {
      const r = await api('/api/config');
      if (r.ok) config = r.data;
    }
    if (!config) return;
    const L = config.layout || {};
    const kv = $('#kvVersion');
    if (kv) kv.textContent = config.version || '—';
    $('#kvCompDir').textContent = L.components || '（未使用 components/ 目录）';
    $('#kvDataDir').textContent = L.data || '—';
    $('#kvMode').textContent = L.portable ? '便携模式（组件装在本地 components/）' : '旧布局（引用外部固定路径）';
  }

  async function quitToolbox() {
    if (!confirm('退出工具箱界面？\n\n已经启动的 AstrBot / MCS 不会被关掉，下次双击图标还能接着用。')) return;
    await post('/api/quit');
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;font:600 15px/1.6 system-ui;color:#64748b">' +
      '工具箱已退出，可以直接关掉这个标签页了。</div>';
  }

  $('#btnQuit').addEventListener('click', quitToolbox);
  $('#btnQuit2').addEventListener('click', quitToolbox);

  // ---------------------------------------------------------------- ESC

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    sheetAstrbot.hidden = true;
    sheetLog.hidden = true;
    closeSettings();
  });

  // ---------------------------------------------------------------- 初始化

  try {
    const cached = JSON.parse(localStorage.getItem('tbx-appearance') || 'null');
    if (cached) applyAppearance(cached);
  } catch { /* ignore */ }
  applyAppearance(appearance);

  relayoutTabs();
  requestAnimationFrame(relayoutTabs);
  addEventListener('load', relayoutTabs);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayoutTabs);

  const qs = new URLSearchParams(location.search);
  const initTab = qs.get('tab');
  if (initTab === 'mcs') switchPane('mcs');

  // ?settings=components 可以直接打开设置某一栏（调试和截图时用得上）
  const initSettings = qs.get('settings');
  if (initSettings) {
    setTimeout(() => openSettings(initSettings === '1' ? 'components' : initSettings), 350);
  }

  api('/api/config').then((r) => { if (r.ok) config = r.data; });
})();

/* ==========================================================================
 * 原生壳标题栏（DaFeiYuToolbox.exe · WebView2）
 * 浏览器里没有 chrome.webview，不加 has-shell —— 标题栏不显示，一切照旧。
 * ========================================================================== */
(function initShellTitlebar() {
  const host = window.chrome && chrome.webview;
  if (!host) return;

  // 只要跑在原生壳里就打这个标记（不含 webview 的浏览器模式不受影响）。
  // 用来消除「系统亚克力标题栏 ↔ 网页顶栏」之间那条 1px 白缝等壳内专属修正。
  document.documentElement.classList.add('is-shell');

  // 只有壳明确要求网页画标题栏时才画（DFY_TITLEBAR=custom）。
  // 默认 native 模式用系统自带标题栏 —— DWM 亚克力只对真正的系统非客户区生效，
  // WebView2 画布再透明也透不到 DWM backdrop 上。
  const q = new URLSearchParams(location.search);
  if (q.get('shelltitle') !== '1') return;

  document.documentElement.classList.add('has-shell');

  const post = (msg) => { try { host.postMessage(msg); } catch (e) { /* 壳不在了 */ } };

  const bar = document.getElementById('titlebar');
  if (bar) {
    // 按标题栏拖动窗口（交给系统：HTCAPTION）
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.tb-btn')) return;
      post('win:drag');
    });
    // 双击标题栏 = 最大化/还原
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tb-btn')) return;
      post('win:max');
    });
  }

  const bind = (id, msg) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => post(msg));
  };
  bind('tbMin', 'win:min');
  bind('tbMax', 'win:max');
  bind('tbClose', 'win:close');

  // 四边/四角调窗口尺寸（交给系统：HTLEFT..HTBOTTOMRIGHT）
  document.querySelectorAll('.tb-edge').forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      post('win:rz:' + el.dataset.edge);
    });
  });
})();
