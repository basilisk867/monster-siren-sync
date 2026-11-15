/* ============================================================
   塞壬唱片同步器 · 前端逻辑
   ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');
const ESC = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  ready: false,
  albums: [],
  albumMap: new Map(),
  stats: null,
  prefetch: null,
  tasks: new Map(),
  filter: 'all',
  search: '',
  queueTab: 'active',
  currentCid: null,
  currentAlbum: null,
  settings: null,
};

const fmtDate = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : '');
const fmtSize = (n) => {
  if (!n || n < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return x.toFixed(i ? 1 : 0) + ' ' + u[i];
};
const fmtSpeed = (n) => (n ? fmtSize(n) + '/s' : '');
const stepLabel = (s) => ({ audio: '音频', lyric: '歌词', mv: 'MV', cover: '封面', done: '完成' }[s] || s);
const isView = (v) => document.querySelector('.nav-item.active')?.dataset.view === v;
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
};

const ICON_PLAY_SM = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const ICON_PLUS_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CLOSE_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const MODE_ICONS = {
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  single: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="7" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></svg>',
};
const MODE_LABELS = { loop: '列表循环', single: '单曲循环', shuffle: '随机播放' };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

/* ============================== Toast ============================== */
function toast(msg, type = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

/* ============================== 加载 ============================== */
async function boot() {
  bindEvents();
  initTheme();
  initPlayer();
  const params = new URLSearchParams(location.search);
  const noSSE = params.has('nosse');
  if (!noSSE) connectSSE();
  try {
    const st = await api('/api/state');
    state.settings = st.config;
    renderSettingsFields();
    updateFootDir();
  } catch (e) {
    toast('无法连接后端服务：' + e.message, 'err');
  }
  await loadAlbums();
  const autoAlbum = params.get('album');
  if (autoAlbum) openAlbum(autoAlbum);
  route();
}

function catalogHint(on) {
  const el = $('#catalog-hint');
  el.hidden = !on;
  if (on) el.textContent = '正在获取在线专辑目录…';
}

async function loadAlbums() {
  for (let i = 0; i < 200; i++) {
    let j;
    try {
      j = await api('/api/albums');
    } catch (e) {
      toast('获取专辑目录失败：' + e.message, 'err');
      catalogHint(false);
      return;
    }
    if (j.ready) {
      state.ready = true;
      state.albums = j.albums || [];
      state.albumMap = new Map(state.albums.map((a) => [a.cid, a]));
      state.stats = j.stats;
      state.prefetch = j.prefetch;
      catalogHint(false);
      renderAll();
      return;
    }
    catalogHint(true);
    if (j.error) {
      catalogHint(false);
      toast('专辑目录加载失败：' + j.error + '，稍后自动重试', 'err');
    }
    await sleep(900);
  }
  catalogHint(false);
}

/* ============================== 渲染：统计 ============================== */
function renderStats() {
  const s = state.stats;
  const grid = $('#stats-grid');
  if (!s) { grid.innerHTML = ''; return; }
  const donePct = s.songs ? Math.round((s.downloadedSongs / s.songs) * 100) : 0;
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">专辑总数</div>
      <div class="stat-value">${s.albums}</div>
      <div class="stat-sub">塞壬唱片在线目录</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">歌曲总数</div>
      <div class="stat-value">${s.songs.toLocaleString()}</div>
      <div class="stat-sub">平均每张 ${s.albums ? (s.songs / s.albums).toFixed(1) : '0'} 首</div>
    </div>
    <div class="stat-card hl">
      <div class="stat-label">已下载歌曲</div>
      <div class="stat-value">${s.downloadedSongs}</div>
      <div class="stat-sub">已完成 <b>${donePct}%</b></div>
      <div class="stat-bar"><i style="width:${donePct}%"></i></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">已下载专辑</div>
      <div class="stat-value">${s.downloadedAlbums}<span class="unit">/ ${s.albums}</span></div>
      <div class="stat-sub">部分下载 <b>${s.partialAlbums}</b> 张</div>
    </div>`;
}

/* ============================== 渲染：专辑网格 ============================== */
function filteredAlbums() {
  const q = state.search.trim().toLowerCase();
  return state.albums.filter((a) => {
    const st = a.local?.status || 'none';
    if (state.filter !== 'all' && st !== state.filter) return false;
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      (a.artistes || []).join(' ').toLowerCase().includes(q)
    );
  });
}

function albumCardHtml(a) {
  const local = a.local || { downloaded: 0, total: a.songCount || 0, cover: false, status: 'none' };
  const st = local.status || 'none';
  const total = local.total || a.songCount || 0;
  const active = a.active || {};
  const activeCount = Object.keys(active).length;
  const pctDone = total ? Math.min(100, Math.round(((local.downloaded || 0) / total) * 100)) : 0;

  const badge = st === 'full' ? '<span class="badge full">✓</span>' : st === 'partial' ? `<span class="badge partial">${pctDone}%</span>` : '';
  const stateTag = activeCount
    ? `<span class="tag partial">下载中 ${activeCount}</span>`
    : st === 'full'
      ? '<span class="tag full">已全部下载</span>'
      : st === 'partial'
        ? `<span class="tag partial">${local.downloaded || 0}/${total} 首</span>`
        : '<span class="tag none">未下载</span>';
  const action =
    activeCount || st === 'full'
      ? ''
      : `<button class="btn xs" data-action="download-album" data-cid="${a.cid}">下载整张</button>`;

  const artists = (a.artistes || []).join(' / ') || '未知艺人';
  return `<article class="album-card ${st}" data-cid="${a.cid}">
    <button class="cover-btn" data-action="open-album" data-cid="${a.cid}" title="${ESC(a.name)}">
      <img loading="lazy" src="/api/cover?albumCid=${encodeURIComponent(a.cid)}" alt="" onerror="this.style.opacity=0.15">
      ${badge}
    </button>
    <div class="album-info">
      <div class="album-name" title="${ESC(a.name)}">${ESC(a.name)}</div>
      <div class="album-sub" title="${ESC(artists)}">${ESC(artists)}${a.date ? ' · ' + fmtDate(a.date) : ''}</div>
      <div class="album-state">${stateTag}${action}</div>
    </div>
  </article>`;
}

function renderGrid() {
  const list = filteredAlbums();
  const grid = $('#album-grid');
  const empty = $('#lib-empty');
  const count = $('#lib-count');
  count.textContent = state.albums.length ? `显示 ${list.length} / ${state.albums.length} 张专辑` : '';
  empty.hidden = list.length > 0;
  if (!state.albums.length) empty.textContent = '正在加载专辑目录…';
  else if (state.search || state.filter !== 'all') empty.textContent = '没有匹配的专辑';
  else empty.textContent = '暂无专辑';
  grid.innerHTML = list.map(albumCardHtml).join('');
}

/* ============================== 抽屉 ============================== */
async function openAlbum(cid) {
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  state.currentCid = cid;
  drawer.hidden = false;
  overlay.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    overlay.classList.add('open');
  });
  $('#drawer-head').innerHTML = '';
  $('#drawer-body').innerHTML = '<div class="empty">正在加载歌曲列表…</div>';
  try {
    const j = await api('/api/album/' + encodeURIComponent(cid));
    if (state.currentCid !== cid) return;
    state.currentAlbum = j.album;
    renderDrawer(j);
  } catch (e) {
    if (state.currentCid !== cid) return;
    $('#drawer-body').innerHTML = `<div class="empty">加载失败：${ESC(e.message)}</div>`;
  }
}

function closeDrawer() {
  const drawer = $('#drawer');
  const overlay = $('#overlay');
  drawer.classList.remove('open');
  overlay.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    drawer.hidden = true;
    overlay.hidden = true;
  }, 260);
  state.currentCid = null;
  state.currentAlbum = null;
}

function songRowHtml(s) {
  const a = s.active;
  const cur = player.playlist[player.current];
  const playing = !!cur && cur.songCid === s.cid && cur.albumCid === state.currentCid;
  let side;
  if (a && (a.status === 'queued' || a.status === 'downloading')) {
    if (a.status === 'queued') {
      side = '<span class="song-state">排队中</span>';
    } else {
      const p = a.step === 'audio' && a.total ? Math.min(100, Math.round((a.received / a.total) * 100)) : 100;
      side = `<div class="mini-progress"><i style="width:${p}%"></i></div><span class="song-state">${p}%</span>`;
    }
  } else if (s.downloaded) {
    side = '<span class="song-state ok">✓</span>';
  } else if (a && a.status === 'error') {
    side = `<span class="song-state err" title="${ESC(a.error)}">失败</span>
      <button class="btn xs ghost" data-action="retry-task" data-task="${a.id}">重试</button>`;
  } else {
    side = `<button class="btn xs ghost" data-action="download-song" data-cid="${s.cid}">下载</button>`;
  }
  const btns = s.downloaded
    ? `<div class="song-btns">
        <button class="icon-btn" data-action="play-song" data-cid="${s.cid}" title="播放">${ICON_PLAY_SM}</button>
        <button class="icon-btn" data-action="add-song" data-cid="${s.cid}" title="加入播放列表">${ICON_PLUS_SM}</button>
      </div>`
    : '';
  const lyric = s.hasLyric ? ' · 含歌词' : '';
  return `<div class="song-row ${s.downloaded ? 'downloaded' : ''} ${playing ? 'playing' : ''}" data-song="${s.cid}">
    <span class="song-index">${pad2(s.index)}</span>
    <div class="song-title">
      <span class="song-name" title="${ESC(s.name)}">${ESC(s.name)}</span>
      <span class="song-artists">${ESC((s.artistes || []).join(' / '))}${lyric}</span>
    </div>
    <div class="song-side">${btns}${side}</div>
  </div>`;
}

function renderDrawer({ album, local }) {
  const total = album.songs.length;
  const done = album.songs.filter((s) => s.downloaded).length;
  const artists = (album.artistes || []).join(' / ') || '未知艺人';

  $('#drawer-head').innerHTML = `
    <button class="drawer-close" data-action="close-drawer" title="关闭">✕</button>
    <img class="drawer-cover" src="/api/cover?albumCid=${encodeURIComponent(album.cid)}&big=1" alt="">
    <div class="drawer-meta">
      <h2>${ESC(album.name)}</h2>
      <div class="dw-sub">${ESC(artists)}${album.date ? ' · ' + fmtDate(album.date) : ''}</div>
      ${album.intro ? `<div class="dw-intro">${ESC(album.intro)}</div>` : ''}
      <div class="dw-tags">
        <span class="tag ${done >= total ? 'full' : 'none'}">${done >= total ? '已全部下载' : `已下载 ${done}/${total}`}</span>
        ${local?.cover ? '<span class="tag full">封面已存</span>' : ''}
      </div>
    </div>`;

  $('#drawer-body').innerHTML = `
    <div class="drawer-toolbar">
      <span>共 ${total} 首 · 已下载 ${done}</span>
      <div class="drawer-toolbar-btns">
        ${done > 0 ? `<button class="btn xs ghost" data-action="play-album" data-cid="${album.cid}">▶ 播放全部</button>` : ''}
        ${done < total ? `<button class="btn xs" data-action="download-album" data-cid="${album.cid}">下载全部未下载</button>` : ''}
      </div>
    </div>
    <div class="song-list">${album.songs.map(songRowHtml).join('')}</div>`;
}

function updateDrawerRow(t) {
  if (state.currentCid !== t.albumCid) return;
  const row = document.querySelector(`.song-row[data-song="${t.songCid}"]`);
  if (!row) return;
  const s = state.currentAlbum?.songs?.find((x) => x.cid === t.songCid);
  if (!s) return;
  if (t.status === 'done') {
    s.downloaded = true;
    s.active = null;
  } else {
    s.active = t;
  }
  const holder = document.createElement('div');
  holder.innerHTML = songRowHtml(s);
  const fresh = holder.firstElementChild;
  if (fresh) row.replaceWith(fresh);
}

let drawerRefreshTimer = null;
function scheduleDrawerRefresh() {
  if (drawerRefreshTimer) return;
  drawerRefreshTimer = setTimeout(async () => {
    drawerRefreshTimer = null;
    const cid = state.currentCid;
    if (!cid) return;
    try {
      const j = await api('/api/album/' + encodeURIComponent(cid));
      if (state.currentCid === cid) renderDrawer(j);
    } catch { /* ignore */ }
  }, 400);
}

/* ============================== 渲染：队列 ============================== */
function taskItemHtml(t) {
  const p = t.status === 'done' ? 100 : t.step === 'audio' && t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : t.status === 'downloading' ? 100 : 0;
  let statusHtml;
  if (t.status === 'queued') {
    statusHtml = '<span class="task-status queued">排队中</span>';
  } else if (t.status === 'downloading') {
    statusHtml = `<div class="task-bar"><i style="width:${p}%"></i></div>
      <span class="task-status">${p}%${t.speed ? ' · ' + fmtSpeed(t.speed) : ''}</span>
      <span class="task-step">${stepLabel(t.step)}</span>`;
  } else if (t.status === 'done') {
    statusHtml = '<span class="task-status ok">✓ 完成</span>';
  } else {
    statusHtml = `<span class="task-status err" title="${ESC(t.error)}">失败</span>
      <button class="btn xs ghost" data-action="retry-task" data-task="${t.id}">重试</button>`;
  }
  return `<div class="task-item">
    <img class="task-cover" src="/api/cover?albumCid=${encodeURIComponent(t.albumCid)}" alt="" loading="lazy" onerror="this.style.opacity=0.15">
    <div class="task-main">
      <span class="task-name" title="${ESC(t.songName)}">${ESC(t.songName)}</span>
      <span class="task-album" title="${ESC(t.albumName)}">${ESC(t.albumName)} · 第 ${t.index} 首</span>
    </div>
    <div class="task-right">${statusHtml}</div>
  </div>`;
}

function renderQueue() {
  const all = Array.from(state.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  const active = all.filter((t) => t.status === 'queued' || t.status === 'downloading');
  const errors = all.filter((t) => t.status === 'error');
  const done = all.filter((t) => t.status === 'done');
  const list = state.queueTab === 'active' ? active : state.queueTab === 'error' ? errors : done.slice(0, 200);

  const empty = $('#queue-empty');
  empty.hidden = list.length > 0;
  empty.textContent =
    state.queueTab === 'active'
      ? '当前没有进行中的任务'
      : state.queueTab === 'error'
        ? '没有失败的任务'
        : '没有已完成的任务';
  $('#task-list').innerHTML = list.map(taskItemHtml).join('');
}

let queueRenderTimer = null;
function scheduleRenderQueue() {
  if (queueRenderTimer) return;
  queueRenderTimer = setTimeout(() => {
    queueRenderTimer = null;
    updateQueueBadge();
    if (isView('queue')) renderQueue();
  }, 250);
}

function updateQueueBadge() {
  const n = Array.from(state.tasks.values()).filter((t) => t.status === 'queued' || t.status === 'downloading').length;
  const b = $('#queue-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
}

/* ============================== 渲染：设置 ============================== */
function renderSettingsFields() {
  const s = state.settings;
  if (!s) return;
  $('#set-dir').value = s.downloadDir;
  $('#set-mv').checked = !!s.downloadMV;
  $('#set-concurrency').value = s.concurrency;
  $('#set-port').value = s.port;
}

function updateFootDir() {
  const el = $('#foot-dir');
  if (!state.settings) return;
  el.textContent = '📁 ' + state.settings.downloadDir;
  el.title = state.settings.downloadDir;
}

function renderAll() {
  renderStats();
  renderGrid();
  renderQueue();
  updateQueueBadge();
  updateFootDir();
}

/* ============================== 操作 ============================== */
async function downloadAlbum(cid, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumCid: cid }),
    });
    if (r.added > 0) toast(`已加入 ${r.added} 首歌曲下载任务`, 'accent');
    else if (r.skipped > 0) toast('该专辑没有待下载的歌曲');
  } catch (e) {
    toast('下单失败：' + e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

async function downloadSong(cid, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songCid: cid }),
    });
    if (r.added > 0) toast('已加入下载队列', 'accent');
    else toast(r.already ? '歌曲已下载' : '歌曲已在队列中');
    if (btn) btn.disabled = false;
  } catch (e) {
    toast('下单失败：' + e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

async function retryTask(taskId, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/api/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
  } catch (e) {
    toast('重试失败：' + e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

async function refreshCatalog(btn) {
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await api('/api/refresh-catalog', { method: 'POST' });
    await loadAlbums();
    toast('专辑目录已刷新', 'accent');
  } catch (e) {
    toast('刷新失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新目录';
  }
}

async function rescanLocal(btn) {
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const r = await api('/api/scan', { method: 'POST' });
    await loadAlbums();
    toast(`扫描完成：已下载 ${r.downloadedSongs} 首歌曲`, 'accent');
  } catch (e) {
    toast('扫描失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '重新扫描';
  }
}

async function saveSettings(btn) {
  btn.disabled = true;
  const hint = $('#save-hint');
  const portChanged = Number($('#set-port').value) !== state.settings?.port;
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        downloadDir: $('#set-dir').value.trim(),
        downloadMV: $('#set-mv').checked,
        concurrency: Number($('#set-concurrency').value),
        port: Number($('#set-port').value),
      }),
    });
    state.settings = r.config;
    renderSettingsFields();
    updateFootDir();
    hint.textContent = portChanged ? '已保存，端口变更需重启程序生效' : '已保存';
    hint.className = 'save-hint ok';
    setTimeout(() => { hint.textContent = ''; }, 3000);
    await loadAlbums();
  } catch (e) {
    hint.textContent = '保存失败：' + e.message;
    hint.className = 'save-hint err';
  } finally {
    btn.disabled = false;
  }
}

async function openFolder() {
  try {
    await api('/api/open-folder', { method: 'POST' });
  } catch (e) {
    toast('无法打开文件夹：' + e.message, 'err');
  }
}

async function pickFolder(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '选择中…';
  }
  toast('正在打开选择窗口，若主屏没显示请查看副屏');
  try {
    const r = await api('/api/pick-folder', { method: 'POST' });
    if (!r.path) {
      toast('已取消选择');
      return;
    }
    // 选完直接应用并保存，无需再点保存
    const saved = await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDir: r.path }),
    });
    state.settings = saved.config;
    renderSettingsFields();
    updateFootDir();
    toast('保存目录已更新：' + r.path, 'accent');
    await loadAlbums();
  } catch (e) {
    toast('文件夹选择失败：' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '选择文件夹';
    }
  }
}

/* ============================== 外观 / 主题 ============================== */
const THEME_KEY = 'siren.theme.v1';
const PRESETS_KEY = 'siren.presets.v1';

const THEME_DEFAULTS = {
  mode: 'dark',
  accent: '#ffe800',
  bgOpacity: 0.5,
  overlayOpacity: 0.65,
  backgroundUrl: '',
  lyricSize: 'medium',
};

const LYRIC_SIZES = { small: '24px', medium: '28px', large: '32px' };

const ACCENT_SWATCHES = ['#ffe800', '#ff6b6b', '#4dabf7', '#7ee787', '#c084fc', '#ff922b', '#22d3ee', '#f472b6'];

const BUILTIN_PRESETS = [
  { id: 'p-dark', name: '暗夜', builtin: true, mode: 'dark', accent: '#ffe800', bgOpacity: 0.5, overlayOpacity: 0.65 },
  { id: 'p-light', name: '白昼', builtin: true, mode: 'light', accent: '#b8860b', bgOpacity: 0.5, overlayOpacity: 0.65 },
];

const theme = { ...THEME_DEFAULTS };
let userPresets = [];

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return [255, 232, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hexToRgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

function loadTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) || '{}');
    if (t && typeof t === 'object') {
      if (t.mode === 'light' || t.mode === 'dark') theme.mode = t.mode;
      if (typeof t.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(t.accent)) theme.accent = t.accent;
      if (Number.isFinite(t.bgOpacity)) theme.bgOpacity = Math.min(1, Math.max(0, t.bgOpacity));
      if (Number.isFinite(t.overlayOpacity)) theme.overlayOpacity = Math.min(1, Math.max(0, t.overlayOpacity));
      if (typeof t.backgroundUrl === 'string') theme.backgroundUrl = t.backgroundUrl;
      if (['small', 'medium', 'large'].includes(t.lyricSize)) theme.lyricSize = t.lyricSize;
    }
  } catch { /* ignore */ }
  try {
    const p = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
    if (Array.isArray(p)) userPresets = p.filter((x) => x && typeof x.name === 'string');
  } catch { /* ignore */ }
}

function saveTheme() {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch { /* ignore */ }
}
function savePresets() {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(userPresets)); } catch { /* ignore */ }
}

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = theme.mode === 'light' ? 'light' : 'dark';
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-2', theme.accent);
  root.style.setProperty('--accent-soft', hexToRgba(theme.accent, 0.1));
  root.style.setProperty('--accent-line', hexToRgba(theme.accent, 0.35));
  root.style.setProperty('--bg-image', theme.backgroundUrl ? `url("${theme.backgroundUrl}")` : 'none');
  root.style.setProperty('--bg-image-opacity', String(theme.backgroundUrl ? theme.bgOpacity : 0));
  root.style.setProperty('--overlay-opacity', String(theme.overlayOpacity));
  root.style.setProperty('--fp-lyric-size', LYRIC_SIZES[theme.lyricSize] || LYRIC_SIZES.medium);
}

function renderThemeControls() {
  $$('#theme-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === theme.mode));
  $$('#lyric-size button, #fp-lyric-size button').forEach((b) =>
    b.classList.toggle('active', b.dataset.size === (theme.lyricSize || 'medium'))
  );

  const sw = $('#accent-swatches');
  if (sw) {
    sw.innerHTML = ACCENT_SWATCHES.map(
      (c) =>
        `<div class="swatch ${c.toLowerCase() === String(theme.accent).toLowerCase() ? 'active' : ''}" data-color="${c}" style="background:${c}"></div>`
    ).join('');
  }
  const cc = $('#accent-color');
  if (cc) cc.value = /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : '#ffe800';

  const prev = $('#bg-preview');
  if (prev) {
    if (theme.backgroundUrl) {
      prev.hidden = false;
      prev.src = theme.backgroundUrl;
    } else {
      prev.hidden = true;
    }
  }
  const clearBtn = $('#btn-bg-clear');
  if (clearBtn) clearBtn.hidden = !theme.backgroundUrl;

  const bo = $('#bg-opacity');
  const oo = $('#overlay-opacity');
  if (bo) bo.value = Math.round(theme.bgOpacity * 100);
  if (oo) oo.value = Math.round(theme.overlayOpacity * 100);
  const bl = $('#bg-opacity-label');
  const ol = $('#overlay-opacity-label');
  if (bl) bl.textContent = Math.round(theme.bgOpacity * 100) + '%';
  if (ol) ol.textContent = Math.round(theme.overlayOpacity * 100) + '%';
}

function presetItemHtml(p) {
  return `<div class="preset-item">
    <span class="dot" style="background:${ESC(p.accent || '#ffe800')}"></span>
    <span>${ESC(p.name)}${p.builtin ? ' · 内置' : ''}</span>
    <button data-action="preset-apply" data-preset="${ESC(p.id)}" title="应用">▶</button>
    ${p.builtin ? '' : `<button data-action="preset-delete" data-preset="${ESC(p.id)}" title="删除">✕</button>`}
  </div>`;
}

function renderPresets() {
  const box = $('#preset-list');
  if (!box) return;
  box.innerHTML = BUILTIN_PRESETS.map(presetItemHtml).join('') + userPresets.map(presetItemHtml).join('');
}

function findPreset(id) {
  return userPresets.find((p) => p.id === id) || BUILTIN_PRESETS.find((p) => p.id === id) || null;
}

function applyPreset(p) {
  if (!p) return;
  theme.mode = p.mode === 'light' ? 'light' : 'dark';
  theme.accent = typeof p.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.accent) ? p.accent : '#ffe800';
  theme.bgOpacity = Number.isFinite(p.bgOpacity) ? Math.min(1, Math.max(0, p.bgOpacity)) : 0.5;
  theme.overlayOpacity = Number.isFinite(p.overlayOpacity) ? Math.min(1, Math.max(0, p.overlayOpacity)) : 0.65;
  if (typeof p.backgroundUrl === 'string' && p.backgroundUrl) theme.backgroundUrl = p.backgroundUrl;
  saveTheme();
  applyTheme();
  renderThemeControls();
  toast('已应用预设：' + p.name, 'accent');
}

function saveCurrentPreset() {
  const input = $('#preset-name');
  const name = (input?.value || '').trim();
  if (!name) {
    toast('请先输入预设名称');
    return;
  }
  userPresets.push({
    id: 'u' + Date.now(),
    name,
    mode: theme.mode,
    accent: theme.accent,
    bgOpacity: theme.bgOpacity,
    overlayOpacity: theme.overlayOpacity,
    backgroundUrl: theme.backgroundUrl,
  });
  savePresets();
  renderPresets();
  if (input) input.value = '';
  toast('预设已保存：' + name, 'accent');
}

function deletePreset(id) {
  userPresets = userPresets.filter((p) => p.id !== id);
  savePresets();
  renderPresets();
}

function exportPreset() {
  const payload = { type: 'siren-theme-preset', version: 1, ...theme };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'siren-theme-preset.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('预设已导出');
}

async function importPreset(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const p = JSON.parse(text);
    if (!p || typeof p !== 'object') throw new Error('文件格式不正确');
    applyPreset({
      name: typeof p.name === 'string' && p.name ? p.name : '导入的预设',
      mode: p.mode,
      accent: p.accent,
      bgOpacity: p.bgOpacity,
      overlayOpacity: p.overlayOpacity,
      backgroundUrl: p.backgroundUrl,
    });
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  }
}

function compressImage(file, maxW = 2560, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        const scale = Math.min(1, maxW / iw);
        const w = Math.max(1, Math.round(iw * scale));
        const h = Math.max(1, Math.round(ih * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    img.src = url;
  });
}

async function uploadBackground(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', 'err');
    return;
  }
  const btn = $('#btn-bg-upload');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '上传中…';
  }
  try {
    const dataUrl = await compressImage(file);
    const r = await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataUrl }),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = await r.json();
        if (j.error) msg = j.error;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const j = await r.json();
    theme.backgroundUrl = j.url;
    saveTheme();
    applyTheme();
    renderThemeControls();
    toast('背景已更新', 'accent');
  } catch (e) {
    toast('上传失败：' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '上传背景';
    }
  }
}

async function clearBackground() {
  try {
    await fetch('/api/background', { method: 'DELETE' });
  } catch { /* ignore */ }
  theme.backgroundUrl = '';
  saveTheme();
  applyTheme();
  renderThemeControls();
  toast('背景已清除');
}

function bindThemeEvents() {
  $('#theme-mode')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    theme.mode = btn.dataset.mode;
    saveTheme();
    applyTheme();
    renderThemeControls();
  });

  $('#accent-swatches')?.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    theme.accent = sw.dataset.color;
    saveTheme();
    applyTheme();
    renderThemeControls();
  });

  $('#accent-color')?.addEventListener('input', (e) => {
    theme.accent = e.target.value;
    saveTheme();
    applyTheme();
    renderThemeControls();
  });

  const onLyricSize = (e) => {
    const btn = e.target.closest('button[data-size]');
    if (!btn) return;
    theme.lyricSize = btn.dataset.size;
    saveTheme();
    applyTheme();
    renderThemeControls();
  };
  $('#lyric-size')?.addEventListener('click', onLyricSize);
  $('#fp-lyric-size')?.addEventListener('click', onLyricSize);

  const bindRange = (id, key, labelId) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      theme[key] = Number(el.value) / 100;
      const label = document.getElementById(labelId);
      if (label) label.textContent = el.value + '%';
      saveTheme();
      applyTheme();
    });
  };
  bindRange('bg-opacity', 'bgOpacity', 'bg-opacity-label');
  bindRange('overlay-opacity', 'overlayOpacity', 'overlay-opacity-label');

  $('#btn-bg-upload')?.addEventListener('click', () => $('#bg-file')?.click());
  $('#bg-file')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    uploadBackground(f);
    e.target.value = '';
  });
  $('#btn-bg-clear')?.addEventListener('click', clearBackground);

  $('#btn-preset-save')?.addEventListener('click', saveCurrentPreset);
  $('#btn-preset-export')?.addEventListener('click', exportPreset);
  $('#btn-preset-import')?.addEventListener('click', () => $('#preset-file')?.click());
  $('#preset-file')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    importPreset(f);
    e.target.value = '';
  });
}

function initTheme() {
  loadTheme();
  applyTheme();
  renderThemeControls();
  renderPresets();
  bindThemeEvents();
}

/* ============================== 播放器 ============================== */
const PL_KEY = 'siren.playlist.v1';
const PLAYER_KEY = 'siren.player.v1';

const player = {
  audio: null,
  playlist: [],       // [{albumCid, songCid, songName, albumName, index, coverUrl}]
  current: -1,
  mode: 'loop',       // loop | single | shuffle
  volume: 0.8,
  muted: false,
  restorePosition: 0,
};

let playerSaveTimer = null;
let lastStateSave = 0;

const audioSrc = (item) =>
  `/api/audio?albumCid=${encodeURIComponent(item.albumCid)}&songCid=${encodeURIComponent(item.songCid)}`;

function savePlayerState() {
  clearTimeout(playerSaveTimer);
  playerSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PL_KEY, JSON.stringify(player.playlist));
      const a = player.audio;
      localStorage.setItem(
        PLAYER_KEY,
        JSON.stringify({
          current: player.current,
          mode: player.mode,
          volume: player.volume,
          muted: player.muted,
          position: a && Number.isFinite(a.currentTime) && a.currentTime > 0 ? a.currentTime : player.restorePosition,
        })
      );
    } catch { /* 隐私模式等存储失败时忽略 */ }
  }, 350);
}

function restorePlayerState() {
  try {
    const pl = JSON.parse(localStorage.getItem(PL_KEY) || '[]');
    if (Array.isArray(pl)) player.playlist = pl.filter((x) => x && x.albumCid && x.songCid);
  } catch { /* ignore */ }
  try {
    const st = JSON.parse(localStorage.getItem(PLAYER_KEY) || '{}');
    if (['loop', 'single', 'shuffle'].includes(st.mode)) player.mode = st.mode;
    if (Number.isFinite(st.volume)) player.volume = Math.min(1, Math.max(0, st.volume));
    if (typeof st.muted === 'boolean') player.muted = st.muted;
    if (Number.isFinite(st.position) && st.position > 0) player.restorePosition = st.position;
    if (Number.isInteger(st.current) && st.current >= 0 && st.current < player.playlist.length) player.current = st.current;
  } catch { /* ignore */ }
  applyVolume();
  updateModeBtn();
  if (player.current >= 0 && player.playlist[player.current]) {
    player.audio.src = audioSrc(player.playlist[player.current]);
    $('#player').hidden = false;
    updatePlayerBar();
    loadLyric(player.playlist[player.current]);
  } else if (player.playlist.length) {
    $('#player').hidden = false;
    updateBadge();
  }
}

function initPlayer() {
  player.audio = $('#audio');
  const a = player.audio;

  a.addEventListener('timeupdate', updateProgress);
  a.addEventListener('loadedmetadata', () => {
    $('#time-total').textContent = fmtTime(a.duration);
    if (player.restorePosition > 0) {
      try {
        a.currentTime = Math.max(0, Math.min(player.restorePosition, (a.duration || 0) - 0.3));
      } catch { /* ignore */ }
      player.restorePosition = 0;
    }
    updateProgress();
  });
  a.addEventListener('play', () => { setPlayIcon(true); highlightPlaying(); });
  a.addEventListener('pause', () => setPlayIcon(false));
  a.addEventListener('ended', onTrackEnded);
  a.addEventListener('error', () => {
    if (a.getAttribute('src')) toast('音频加载失败，文件可能已被移动或删除', 'err');
  });

  restorePlayerState();

  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', prevTrack);
  $('#btn-next').addEventListener('click', nextTrack);
  $('#btn-mode').addEventListener('click', cycleMode);
  $('#btn-vol').addEventListener('click', toggleMute);
  $('#btn-full').addEventListener('click', openFullPlayer);
  $('#fp-close').addEventListener('click', closeFullPlayer);
  $('#fp-play').addEventListener('click', togglePlay);
  $('#fp-prev').addEventListener('click', prevTrack);
  $('#fp-next').addEventListener('click', nextTrack);
  $('#fp-mode').addEventListener('click', cycleMode);
  $('#fp-list').addEventListener('click', () => togglePlaylistPanel());
  $('#fp-vol').addEventListener('click', toggleMute);
  $('#fp-volume').addEventListener('input', (e) => {
    player.volume = Number(e.target.value) / 100;
    player.muted = false;
    applyVolume();
    savePlayerState();
  });
  $('#fp-pbar').addEventListener('pointerdown', (e) => onSeekStart(e, 'fp-pbar', 'fp-pbar-fill'));
  $('#volume').addEventListener('input', (e) => {
    player.volume = Number(e.target.value) / 100;
    player.muted = false;
    applyVolume();
    savePlayerState();
  });
  $('#pbar').addEventListener('pointerdown', (e) => onSeekStart(e, 'pbar', 'pbar-fill'));
  $('#btn-list').addEventListener('click', () => togglePlaylistPanel());
  $('#btn-pl-close').addEventListener('click', () => togglePlaylistPanel(false));
  $('#btn-pl-clear').addEventListener('click', clearPlaylist);
  bindPlaylistDnd();
  document.addEventListener('pointerdown', (e) => {
    const panel = $('#playlist-panel');
    if (panel.hidden) return;
    if (panel.contains(e.target) || e.target.closest('#btn-list')) return;
    togglePlaylistPanel(false);
  });

  renderPlaylist();
  updateBadge();
}

function updateProgress() {
  const a = player.audio;
  const dur = Number.isFinite(a.duration) ? a.duration : 0;
  const cur = Number.isFinite(a.currentTime) ? a.currentTime : 0;
  $('#time-cur').textContent = fmtTime(cur);
  if (dur > 0) {
    const pct = Math.min(100, (cur / dur) * 100);
    $('#pbar-fill').style.width = pct + '%';
    $('#pbar').style.setProperty('--p', pct + '%');
  }
  // 全屏播放页进度
  const fpCur = $('#fp-cur');
  if (fpCur) {
    fpCur.textContent = fmtTime(cur);
    const fpTotal = $('#fp-total');
    if (fpTotal) fpTotal.textContent = fmtTime(dur);
    const fpFill = $('#fp-pbar-fill');
    if (fpFill && dur > 0) fpFill.style.width = Math.min(100, (cur / dur) * 100) + '%';
  }
  updateLyricSync();
  if (!a.paused && Date.now() - lastStateSave > 3000) {
    lastStateSave = Date.now();
    savePlayerState();
  }
}

function onSeekStart(e, barId = 'pbar', fillId = 'pbar-fill') {
  const bar = document.getElementById(barId);
  if (!bar) return;
  const seek = (ev) => {
    const a = player.audio;
    if (!Number.isFinite(a.duration) || a.duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    a.currentTime = ratio * a.duration;
    const fill = document.getElementById(fillId);
    if (fill) fill.style.width = ratio * 100 + '%';
    updateProgress();
  };
  seek(e);
  const move = (ev) => seek(ev);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    savePlayerState();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function togglePlay() {
  if (!player.playlist.length) {
    toast('播放列表为空');
    return;
  }
  const a = player.audio;
  if (a.paused) {
    if (!a.getAttribute('src')) playIndex(player.current >= 0 ? player.current : 0);
    else a.play().catch((err) => toast('播放失败：' + err.message, 'err'));
  } else {
    a.pause();
  }
}

function playIndex(i, autoPlay = true) {
  if (!player.playlist.length) return;
  const n = player.playlist.length;
  player.current = ((i % n) + n) % n;
  const item = player.playlist[player.current];
  player.restorePosition = 0;
  player.audio.src = audioSrc(item);
  $('#player').hidden = false;
  updatePlayerBar();
  if (autoPlay) player.audio.play().catch((err) => toast('播放失败：' + err.message, 'err'));
  savePlayerState();
  renderPlaylist();
  highlightPlaying();
  loadLyric(item);
  if (!$('#fullplayer').hidden) renderFullPlayer();
  updateProgress();
}

function nextTrack() {
  if (!player.playlist.length) return;
  if (player.mode === 'shuffle' && player.playlist.length > 1) {
    let n = player.current;
    while (n === player.current) n = Math.floor(Math.random() * player.playlist.length);
    playIndex(n);
  } else {
    playIndex(player.current + 1);
  }
}

function prevTrack() {
  if (player.playlist.length) playIndex(player.current - 1);
}

function onTrackEnded() {
  if (player.mode === 'single') {
    player.audio.currentTime = 0;
    player.audio.play().catch(() => {});
  } else {
    nextTrack();
  }
}

function cycleMode() {
  const order = ['loop', 'single', 'shuffle'];
  player.mode = order[(order.indexOf(player.mode) + 1) % order.length];
  updateModeBtn();
  savePlayerState();
  toast('播放模式：' + MODE_LABELS[player.mode]);
}

function updateModeBtn() {
  const label = '播放模式：' + MODE_LABELS[player.mode];
  const btn = $('#btn-mode');
  if (btn) {
    btn.innerHTML = MODE_ICONS[player.mode];
    btn.title = label;
  }
  const fp = $('#fp-mode');
  if (fp) {
    fp.innerHTML = MODE_ICONS[player.mode];
    fp.title = label;
  }
}

function applyVolume() {
  const a = player.audio;
  if (!a) return;
  const muted = player.muted || player.volume === 0;
  a.volume = muted ? 0 : player.volume;
  const val = Math.round(muted ? 0 : player.volume * 100);
  $('#volume').value = val;
  const fpVolume = $('#fp-volume');
  if (fpVolume) fpVolume.value = val;
  const volIcon = $('#icon-vol');
  const muteIcon = $('#icon-mute');
  if (volIcon) volIcon.style.display = muted ? 'none' : '';
  if (muteIcon) muteIcon.style.display = muted ? '' : 'none';
  const fpVolIcon = $('#fp-icon-vol');
  const fpMuteIcon = $('#fp-icon-mute');
  if (fpVolIcon) fpVolIcon.style.display = muted ? 'none' : '';
  if (fpMuteIcon) fpMuteIcon.style.display = muted ? '' : 'none';
}

function toggleMute() {
  player.muted = !player.muted;
  applyVolume();
  savePlayerState();
}

function setPlayIcon(playing) {
  const play = $('#icon-play');
  const pause = $('#icon-pause');
  if (play) play.style.display = playing ? 'none' : '';
  if (pause) pause.style.display = playing ? '' : 'none';
  const fpPlay = $('#fp-icon-play');
  const fpPause = $('#fp-icon-pause');
  if (fpPlay) fpPlay.style.display = playing ? 'none' : '';
  if (fpPause) fpPause.style.display = playing ? '' : 'none';
  $('#btn-play').title = playing ? '暂停' : '播放';
  $('#fp-play').title = playing ? '暂停' : '播放';
}

function updatePlayerBar() {
  const item = player.playlist[player.current];
  if (!item) return;
  $('#player').hidden = false;
  const cover = $('#player-cover');
  cover.src = `/api/cover?albumCid=${encodeURIComponent(item.albumCid)}&big=1`;
  cover.dataset.cid = item.albumCid;
  $('#player-title').textContent = item.songName;
  $('#player-album').textContent = item.albumName;
  updateBadge();
}

function updateBadge() {
  const n = player.playlist.length;
  const badge = $('#pl-badge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  $('#pl-count').textContent = n ? `（${n} 首）` : '';
}

function highlightPlaying() {
  const cur = player.playlist[player.current];
  $$('.song-row').forEach((row) => {
    const on = !!cur && state.currentCid === cur.albumCid && row.dataset.song === cur.songCid;
    row.classList.toggle('playing', on);
  });
}

/* ---------- 播放列表操作 ---------- */
function findCurrentSong(cid) {
  return state.currentAlbum?.songs?.find((s) => s.cid === cid) || null;
}

function songItemFromAlbum(s) {
  const album = state.currentAlbum;
  return {
    albumCid: album.cid,
    songCid: s.cid,
    songName: s.name,
    albumName: album.name,
    index: s.index,
    coverUrl: album.coverUrl,
  };
}

function playSongNow(cid) {
  const s = findCurrentSong(cid);
  if (!s || !s.downloaded) return;
  const item = songItemFromAlbum(s);
  const idx = player.playlist.findIndex((p) => p.albumCid === item.albumCid && p.songCid === item.songCid);
  if (idx >= 0) playIndex(idx);
  else {
    player.playlist.push(item);
    playIndex(player.playlist.length - 1);
  }
}

function addSongToPlaylist(cid) {
  const s = findCurrentSong(cid);
  if (!s || !s.downloaded) return;
  const item = songItemFromAlbum(s);
  if (player.playlist.some((p) => p.albumCid === item.albumCid && p.songCid === item.songCid)) {
    toast('已在播放列表中');
    return;
  }
  player.playlist.push(item);
  savePlayerState();
  updateBadge();
  renderPlaylist();
  toast('已加入播放列表', 'accent');
}

function playAlbumNow() {
  const album = state.currentAlbum;
  if (!album) return;
  const songs = album.songs.filter((s) => s.downloaded);
  if (!songs.length) {
    toast('这张专辑还没有已下载的歌曲');
    return;
  }
  player.playlist = songs.map(songItemFromAlbum);
  player.current = 0;
  savePlayerState();
  renderPlaylist();
  playIndex(0);
  toast(`已开始播放整张专辑（${songs.length} 首）`, 'accent');
}

/* ---------- 播放列表面板 ---------- */
function togglePlaylistPanel(force) {
  const panel = $('#playlist-panel');
  const open = force !== undefined ? force : panel.hidden;
  if (open) {
    panel.hidden = false;
    renderPlaylist();
    requestAnimationFrame(() => panel.classList.add('open'));
  } else {
    panel.classList.remove('open');
    setTimeout(() => { panel.hidden = true; }, 180);
  }
}

function renderPlaylist() {
  const body = $('#pl-body');
  if (!body) return;
  const n = player.playlist.length;
  $('#pl-count').textContent = n ? `（${n} 首）` : '';
  if (!n) {
    body.innerHTML = '<div class="pl-empty">播放列表为空<br>在专辑详情里点歌曲旁的 ▶ 或 ＋ 添加</div>';
    return;
  }
  body.innerHTML = player.playlist
    .map(
      (item, i) => `
    <div class="pl-row ${i === player.current ? 'playing' : ''}" draggable="true" data-pl-index="${i}" data-action="pl-play" data-index="${i}">
      <span class="pl-idx">${i + 1}</span>
      <div class="pl-info">
        <div class="pl-name" title="${ESC(item.songName)}">${ESC(item.songName)}</div>
        <div class="pl-album" title="${ESC(item.albumName)}">${ESC(item.albumName)}</div>
      </div>
      <button class="icon-btn" data-action="pl-remove" data-index="${i}" title="移除">${ICON_CLOSE_SM}</button>
    </div>`
    )
    .join('');
}

function removePlaylistItem(i) {
  if (i < 0 || i >= player.playlist.length) return;
  player.playlist.splice(i, 1);
  if (!player.playlist.length) {
    clearPlaylist();
    return;
  }
  if (player.current === i) {
    player.current = Math.min(i, player.playlist.length - 1);
    playIndex(player.current);
  } else if (i < player.current) {
    player.current--;
  }
  savePlayerState();
  renderPlaylist();
  updateBadge();
}

function clearPlaylist() {
  player.playlist = [];
  player.current = -1;
  const a = player.audio;
  a.pause();
  a.removeAttribute('src');
  try { a.load(); } catch { /* ignore */ }
  $('#player').hidden = true;
  updateBadge();
  $('#time-cur').textContent = '0:00';
  $('#time-total').textContent = '0:00';
  $('#pbar-fill').style.width = '0%';
  renderPlaylist();
  savePlayerState();
  $$('.song-row').forEach((r) => r.classList.remove('playing'));
  toast('播放列表已清空');
}

function movePlaylistItem(from, to) {
  const item = player.playlist.splice(from, 1)[0];
  if (!item) return;
  player.playlist.splice(to, 0, item);
  if (player.current === from) player.current = to;
  else if (from < player.current && to >= player.current) player.current--;
  else if (from > player.current && to <= player.current) player.current++;
  savePlayerState();
  renderPlaylist();
}

function bindPlaylistDnd() {
  const body = $('#pl-body');
  let dragIdx = null;
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.pl-row');
    if (!row) return;
    dragIdx = Number(row.dataset.plIndex);
    row.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  body.addEventListener('dragend', () => {
    dragIdx = null;
    $$('#pl-body .pl-row').forEach((r) => r.classList.remove('dragging', 'drag-over'));
  });
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('#pl-body .pl-row').forEach((r) => r.classList.remove('drag-over'));
    const row = e.target.closest('.pl-row');
    if (row && dragIdx !== null && Number(row.dataset.plIndex) !== dragIdx) row.classList.add('drag-over');
  });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.pl-row');
    if (!row || dragIdx === null) return;
    const to = Number(row.dataset.plIndex);
    if (to !== dragIdx) movePlaylistItem(dragIdx, to);
    dragIdx = null;
  });
}

/* ---------- 全屏播放 + 滚动歌词 ---------- */
const lyricCache = new Map(); // songCid -> lines[] | null
let currentLyricLines = [];
let lastLyricIndex = -1;
let lyricLoadSeq = 0;

function parseLrc(text) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(text).split(/\r?\n/)) {
    const tags = [...raw.matchAll(re)];
    if (!tags.length) continue;
    const content = raw.replace(re, '').trim();
    if (!content) continue;
    for (const m of tags) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      lines.push({ t: min * 60 + sec + frac, text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

function openFullPlayer() {
  if (!player.playlist.length) {
    toast('播放列表为空');
    return;
  }
  const fp = $('#fullplayer');
  fp.hidden = false;
  renderFullPlayer();
  renderLyrics();
  requestAnimationFrame(() => fp.classList.add('open'));
  if (currentLyricLines.length === 0) loadLyric(player.playlist[player.current]);
}

function closeFullPlayer() {
  const fp = $('#fullplayer');
  fp.classList.remove('open');
  setTimeout(() => { fp.hidden = true; }, 340);
}

/* ---------- 封面取色：全屏播放页背景与高亮色 ---------- */
const coverThemeCache = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToCss(h, s, l) {
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

async function getCoverTheme(albumCid) {
  if (coverThemeCache.has(albumCid)) return coverThemeCache.get(albumCid);
  let result = { bg1: '#1c1b1f', bg2: '#08080a', accent: '#ffe9a8' };
  try {
    const img = await loadImage(`/api/cover?albumCid=${encodeURIComponent(albumCid)}&big=1`);
    const S = 48;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);
    const data = ctx.getImageData(0, 0, S, S).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    let best = null;
    let bestLum = -1;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const A = data[i + 3];
      if (A < 128) continue;
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (lum < 16) continue;
      r += R;
      g += G;
      b += B;
      n++;
      if (lum > bestLum) {
        bestLum = lum;
        best = [R, G, B];
      }
    }
    if (n > 0 && best) {
      const [h, s] = rgbToHsl(r / n, g / n, b / n);
      // 背景：沿封面主色相，把颜色压暗成深色渐变
      const bg1 = hslToCss(h, Math.min(s, 0.48), 0.18);
      const bg2 = hslToCss(h, Math.min(s, 0.42), 0.07);
      // 当前行高亮：取封面里最亮的颜色，提亮到 85% 亮度、降低饱和
      const [bh, bs] = rgbToHsl(best[0], best[1], best[2]);
      const accent = hslToCss(bh, Math.min(bs, 0.42), 0.85);
      result = { bg1, bg2, accent };
    }
  } catch { /* 取色失败用默认深色 */ }
  coverThemeCache.set(albumCid, result);
  return result;
}

function renderFullPlayer() {
  const item = player.playlist[player.current];
  if (!item) return;
  const cover = `/api/cover?albumCid=${encodeURIComponent(item.albumCid)}&big=1`;
  $('#fp-cover').src = cover;
  $('#fp-song').textContent = item.songName;
  $('#fp-artist').textContent = item.albumName;
  updateModeBtn();
  setPlayIcon(!player.audio.paused);
  updateProgress();
  // 异步取封面色，应用到背景与当前行高亮
  getCoverTheme(item.albumCid).then((t) => {
    const fp = $('#fullplayer');
    if (!fp) return;
    fp.style.setProperty('--fp-accent', t.accent);
    $('#fp-bg').style.background = `linear-gradient(160deg, ${t.bg1} 0%, ${t.bg2} 58%, #060607 100%)`;
  });
}

async function loadLyric(item) {
  if (!item) {
    currentLyricLines = [];
    lastLyricIndex = -1;
    renderLyrics();
    return;
  }
  if (lyricCache.has(item.songCid)) {
    currentLyricLines = lyricCache.get(item.songCid) || [];
    lastLyricIndex = -1;
    renderLyrics();
    return;
  }
  const seq = ++lyricLoadSeq;
  try {
    const r = await fetch(
      `/api/lyric?albumCid=${encodeURIComponent(item.albumCid)}&songCid=${encodeURIComponent(item.songCid)}`
    );
    const j = await r.json();
    if (seq !== lyricLoadSeq) return;
    const lines = j.lyric ? parseLrc(j.lyric) : [];
    lyricCache.set(item.songCid, lines);
    currentLyricLines = lines;
    lastLyricIndex = -1;
    renderLyrics();
  } catch {
    if (seq === lyricLoadSeq) {
      currentLyricLines = [];
      renderLyrics();
    }
  }
}

function renderLyrics() {
  const box = $('#fp-lyrics');
  if (!box) return;
  if (!currentLyricLines.length) {
    box.innerHTML = '<div class="fp-lyrics-empty">暂无歌词</div>';
    return;
  }
  box.innerHTML = currentLyricLines.map((l, i) => `<div class="lyric-line" data-line="${i}">${ESC(l.text)}</div>`).join('');
  lastLyricIndex = -1;
  box.scrollTop = 0;
}

function updateLyricSync() {
  if (!currentLyricLines.length) return;
  const t = player.audio.currentTime;
  let idx = -1;
  for (let i = 0; i < currentLyricLines.length; i++) {
    if (currentLyricLines[i].t <= t + 0.08) idx = i;
    else break;
  }
  if (idx === lastLyricIndex) return;
  lastLyricIndex = idx;
  const box = $('#fp-lyrics');
  if (!box) return;
  const prev = box.querySelector('.lyric-line.active');
  if (prev) prev.classList.remove('active');
  if (idx >= 0) {
    const row = box.querySelector(`.lyric-line[data-line="${idx}"]`);
    if (row) {
      row.classList.add('active');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ============================== SSE ============================== */
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('task', (ev) => {
    const t = JSON.parse(ev.data);
    const prev = state.tasks.get(t.id);
    state.tasks.set(t.id, t);
    scheduleRenderQueue();
    updateDrawerRow(t);
    if (prev && (prev.status === 'queued' || prev.status === 'downloading') && (t.status === 'done' || t.status === 'error')) {
      // 完成/失败时刷新对应专辑卡片状态
    }
    const album = state.albumMap.get(t.albumCid);
    if (album) {
      album.active = album.active || {};
      if (t.status === 'queued' || t.status === 'downloading') album.active[t.songCid] = t;
      else delete album.active[t.songCid];
      const card = document.querySelector(`.album-card[data-cid="${t.albumCid}"]`);
      if (card && (t.status === 'queued' || t.status === 'done' || t.status === 'error' || t.status === 'downloading')) {
        card.outerHTML = albumCardHtml(album);
      }
    }
  });

  es.addEventListener('album', (ev) => {
    const { albumCid, local, active } = JSON.parse(ev.data);
    const album = state.albumMap.get(albumCid);
    if (album) {
      album.local = local;
      album.active = active || {};
      const card = document.querySelector(`.album-card[data-cid="${albumCid}"]`);
      if (card) card.outerHTML = albumCardHtml(album);
    }
    if (state.currentCid === albumCid) scheduleDrawerRefresh();
  });

  es.addEventListener('stats', (ev) => {
    state.stats = JSON.parse(ev.data);
    renderStats();
  });

  es.addEventListener('catalog', () => {
    // 目录就绪通知：若尚未加载完成，主动拉一次
    if (!state.ready) loadAlbums();
  });

  es.addEventListener('prefetch', (ev) => {
    state.prefetch = JSON.parse(ev.data);
  });

  es.onerror = () => {
    // EventSource 会自动重连，无需处理
  };
}

/* ============================== 事件绑定 ============================== */
function bindEvents() {
  // 全局点击委托
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'open-album') {
      if (!$('#fullplayer').hidden) closeFullPlayer();
      openAlbum(el.dataset.cid);
    } else if (action === 'open-full') openFullPlayer();
    else if (action === 'download-album') downloadAlbum(el.dataset.cid, el);
    else if (action === 'download-song') downloadSong(el.dataset.cid, el);
    else if (action === 'retry-task') retryTask(el.dataset.task, el);
    else if (action === 'close-drawer') closeDrawer();
    else if (action === 'play-song') playSongNow(el.dataset.cid);
    else if (action === 'add-song') addSongToPlaylist(el.dataset.cid);
    else if (action === 'play-album') playAlbumNow();
    else if (action === 'pl-play') playIndex(Number(el.dataset.index));
    else if (action === 'pl-remove') removePlaylistItem(Number(el.dataset.index));
    else if (action === 'preset-apply') {
      const p = findPreset(el.dataset.preset);
      if (p) applyPreset(p);
    } else if (action === 'preset-delete') deletePreset(el.dataset.preset);
  });

  // 抽屉遮罩 / ESC
  $('#overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#fullplayer').hidden) closeFullPlayer();
    else closeDrawer();
  });

  // 搜索
  $('#search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderGrid();
  });

  // 筛选 chips
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderGrid();
  });

  // 队列 tabs
  $('#queue-tabs').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.queueTab = chip.dataset.qt;
    $$('#queue-tabs .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderQueue();
  });

  // 顶栏按钮
  $('#btn-refresh').addEventListener('click', (e) => refreshCatalog(e.currentTarget));
  $('#btn-scan').addEventListener('click', (e) => rescanLocal(e.currentTarget));

  // 队列操作
  $('#btn-clear').addEventListener('click', async () => {
    try {
      const r = await api('/api/clear-done', { method: 'POST' });
      for (const [id, t] of Array.from(state.tasks)) {
        if (t.status === 'done' || t.status === 'error') state.tasks.delete(id);
      }
      renderQueue();
      toast(`已清除 ${r.cleared} 条完成记录`);
    } catch (e) {
      toast('清除失败：' + e.message, 'err');
    }
  });

  // 设置
  $('#btn-save').addEventListener('click', (e) => saveSettings(e.currentTarget));
  $('#btn-pick-folder').addEventListener('click', (e) => pickFolder(e.currentTarget));

  // 路由
  window.addEventListener('hashchange', route);
}

/* ============================== 路由 ============================== */
function route() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  const view = ['library', 'queue', 'settings'].includes(raw) ? raw : 'library';
  $$('.view').forEach((s) => (s.hidden = s.id !== 'view-' + view));
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const titles = { library: '音乐库', queue: '下载队列', settings: '设置' };
  $('#page-title').textContent = titles[view];
  if (view === 'queue') {
    renderQueue();
    updateQueueBadge();
  }
  if (view === 'settings') renderSettingsFields();
}

/* ============================== 启动 ============================== */
boot();
