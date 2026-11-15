#!/usr/bin/env node
/**
 * 塞壬唱片同步器 — Monster Siren Sync
 * 零依赖 Node.js 后端：专辑列表缓存、本地扫描、增量下载队列、SSE 进度推送。
 *
 * 启动：node server.mjs   （或双击 start.bat）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec, execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCompiled = typeof Bun !== 'undefined';
// 单文件 exe 模式下，config.json 与 userdata 写到 exe 所在目录
const APP_DIR = isCompiled ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
// 编译模式使用内联的前端资源；开发模式仍读 public/ 目录
let embeddedAssets = null;
if (isCompiled) {
  try {
    embeddedAssets = await import('./public-assets.mjs');
  } catch { /* 没有生成内联资源时回退到文件系统 */ }
}

const API_BASE = 'https://monster-siren.hypergryph.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HDR = { 'User-Agent': UA, 'Referer': API_BASE + '/' };
const MAX_RETRY = 3;

// 默认下载到当前用户的「音乐」文件夹：<用户目录>\Music\MonsterSiren
// Windows 上即 C:\Users\<用户名>\Music\MonsterSiren，不写死任何机器路径
const DEFAULT_CONFIG = {
  downloadDir: path.join(os.homedir(), 'Music', 'MonsterSiren'),
  concurrency: 3,
  downloadMV: false,
  port: 3456,
};

const log = (...a) => console.log('[siren]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- 工具
function sanitizeFilename(name, fallback, maxLen = 60) {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s || s === '.' || s === '..') s = String(fallback || 'untitled');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJson(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

// 同一张专辑的写操作串行化，避免 album.json 并发覆盖
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// ---------------------------------------------------------------- 配置
let config = { ...DEFAULT_CONFIG };
async function loadConfig() {
  const saved = await readJson(CONFIG_PATH, {});
  config = { ...DEFAULT_CONFIG, ...saved };
  if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
  if (!Number.isFinite(config.concurrency) || config.concurrency < 1) config.concurrency = 3;
}
async function saveConfig(patch) {
  config = { ...config, ...patch };
  await writeJson(CONFIG_PATH, config);
}

// ---------------------------------------------------------------- 状态
const catalog = {
  ready: false,
  loading: false,
  error: '',
  albums: [],
  albumMap: new Map(),
  songsCount: 0,
};

const detailCache = new Map();          // albumCid -> api detail（含 songs 顺序）
const songDetailCache = new Map();      // songCid -> api detail（下载时使用）
let local = { albums: {} };             // albumCid -> { dir, cover, songs: { cid: {...} } }
const prefetch = { running: false, done: 0, total: 0 };

const tasks = new Map();                // taskId -> task
const songActive = new Map();           // songCid -> taskId（排队/下载中）
let queue = [];
let runningCount = 0;
let sseClients = new Set();
let taskSeq = 0;
let pickingFolder = false;

// ---------------------------------------------------------------- API 客户端
async function api(p, { timeout = 60000, retry = MAX_RETRY } = {}) {
  const url = p.startsWith('http') ? p : API_BASE + p;
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.code !== 0) throw new Error(`API code ${j.code} ${j.msg || ''}`.trim());
      return j.data;
    } catch (e) {
      lastErr = e;
      if (i < retry && !String(e.message).includes('HTTP 4')) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

async function getAlbumDetail(cid) {
  if (detailCache.has(cid)) return detailCache.get(cid);
  const d = await api(`/api/album/${cid}/detail`);
  detailCache.set(cid, d);
  return d;
}
async function getSongDetail(cid) {
  if (songDetailCache.has(cid)) return songDetailCache.get(cid);
  const d = await api(`/api/song/${cid}`);
  songDetailCache.set(cid, d);
  return d;
}

// ---------------------------------------------------------------- 专辑目录
async function loadCatalog() {
  if (catalog.loading) return;
  catalog.loading = true;
  catalog.error = '';
  try {
    const [albums, songs] = await Promise.all([api('/api/albums'), api('/api/songs')]);
    const counts = {};
    for (const s of songs.list || []) counts[s.albumCid] = (counts[s.albumCid] || 0) + 1;
    catalog.albums = (albums || []).map((a) => ({
      cid: a.cid,
      name: a.name,
      coverUrl: a.coverUrl,
      artistes: a.artistes || [],
      date: (a.coverUrl || '').match(/\/pic\/(\d{8})\//)?.[1] || '',
      songCount: counts[a.cid] || 0,
    }));
    catalog.albumMap = new Map(catalog.albums.map((a) => [a.cid, a]));
    catalog.songsCount = (songs.list || []).length;
    catalog.ready = true;
    log(`专辑目录已加载: ${catalog.albums.length} 张专辑 / ${catalog.songsCount} 首歌曲`);
    broadcast('catalog', catalogView());
    prefetchDetails();
  } catch (e) {
    catalog.error = String(e?.message || e);
    log('专辑目录加载失败:', catalog.error);
    setTimeout(() => loadCatalog(), 8000);
  } finally {
    catalog.loading = false;
  }
}

async function prefetchDetails() {
  if (prefetch.running || !catalog.ready) return;
  prefetch.running = true;
  const todo = catalog.albums.filter((a) => !detailCache.has(a.cid)).map((a) => a.cid);
  prefetch.total = Math.max(todo.length, 1);
  prefetch.done = 0;
  const q = [...todo];
  const worker = async () => {
    while (q.length) {
      const cid = q.shift();
      try { await getAlbumDetail(cid); } catch { /* 忽略单张失败，点开时可重试 */ }
      prefetch.done++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  prefetch.running = false;
  log(`专辑详情预取完成 (${todo.length} 张)`);
  broadcast('prefetch', { running: false, done: prefetch.done, total: prefetch.total });
}

// ---------------------------------------------------------------- 本地扫描
async function scanLocal() {
  const result = { albums: {} };
  const root = config.downloadDir;
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { /* 目录不存在 */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const meta = await readJson(path.join(dir, 'album.json'));
    if (!meta || !meta.cid) continue;
    const songs = {};
    for (const s of meta.songs || []) {
      if (!s || !s.cid) continue;
      let downloaded = false, size = 0;
      if (s.file) {
        try {
          const st = await fsp.stat(path.join(dir, s.file));
          downloaded = st.size > 0;
          size = st.size;
        } catch { /* 文件已不存在 */ }
      }
      songs[s.cid] = { downloaded, size, file: s.file || null, lyric: s.lyric || null, mv: s.mv || null };
    }
    let cover = false;
    if (meta.cover) cover = await exists(path.join(dir, meta.cover));
    result.albums[meta.cid] = { dir: e.name, cover, songs };
  }
  local = result;
  const dirs = Object.keys(local.albums).length;
  log(`本地扫描完成: ${dirs} 张专辑目录`);
  broadcast('stats', statsView());
}

// ---------------------------------------------------------------- 聚合 / 视图
function aggregateFor(cid) {
  const album = catalog.albumMap.get(cid);
  const detail = detailCache.get(cid);
  const ls = local.albums[cid];
  const localSongs = ls?.songs ? Object.values(ls.songs) : [];
  const localDownloaded = localSongs.filter((s) => s.downloaded).length;

  let downloaded, total;
  const songStatus = {};
  if (detail) {
    total = detail.songs.length;
    downloaded = 0;
    for (const s of detail.songs) {
      const ok = !!ls?.songs?.[s.cid]?.downloaded;
      songStatus[s.cid] = ok;
      if (ok) downloaded++;
    }
  } else {
    total = album?.songCount || localSongs.length;
    downloaded = localDownloaded;
  }
  const cover = !!ls?.cover;
  let status = 'none';
  if ((total > 0 && downloaded >= total) || (total === 0 && ls)) status = 'full';
  if (status !== 'full' && (downloaded > 0 || cover)) status = 'partial';
  if (localSongs.length > 0 && downloaded === 0 && !cover) status = 'none';
  return { total, downloaded, cover, status, songStatus };
}

function catalogView() {
  return { ready: catalog.ready, loading: catalog.loading, error: catalog.error, prefetch };
}
function statsView() {
  let downloadedSongs = 0, downloadedAlbums = 0, partialAlbums = 0;
  for (const a of catalog.albums) {
    const agg = aggregateFor(a.cid);
    downloadedSongs += agg.downloaded;
    if (agg.status === 'full') downloadedAlbums++;
    else if (agg.status === 'partial') partialAlbums++;
  }
  return {
    albums: catalog.albums.length,
    songs: catalog.songsCount,
    downloadedSongs,
    downloadedAlbums,
    partialAlbums,
  };
}

function taskView(t) {
  return {
    id: t.id,
    albumCid: t.albumCid,
    albumName: t.albumName,
    songCid: t.songCid,
    songName: t.songName,
    index: t.index,
    status: t.status,
    step: t.step,
    received: t.received,
    total: t.total,
    speed: t.speed,
    retries: t.retries,
    error: t.error,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---------------------------------------------------------------- 广播
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch { /* 客户端断开 */ }
  }
}
function broadcastTask(t) { broadcast('task', taskView(t)); }
function broadcastAlbum(cid) {
  const agg = aggregateFor(cid);
  broadcast('album', { albumCid: cid, local: agg, active: activeTasksForAlbum(cid) });
}
function activeTasksForAlbum(cid) {
  const out = {};
  for (const t of tasks.values()) {
    if (t.albumCid === cid && (t.status === 'queued' || t.status === 'downloading')) out[t.songCid] = taskView(t);
  }
  return out;
}

// ---------------------------------------------------------------- 队列 / 下载
function pump() {
  while (runningCount < config.concurrency && queue.length) {
    const id = queue.shift();
    const t = tasks.get(id);
    if (!t || t.status !== 'queued') continue;
    runningCount++;
    runTask(t)
      .catch((e) => { log('任务异常:', t.id, e?.message || e); failTask(t, e); })
      .finally(() => { runningCount--; pump(); });
  }
}

function enqueueSong(albumCid, albumName, song, index) {
  const existing = songActive.get(song.cid);
  if (existing) {
    const t = tasks.get(existing);
    if (t && (t.status === 'queued' || t.status === 'downloading')) return 'active';
    songActive.delete(song.cid);
  }
  const id = 't' + (++taskSeq);
  const t = {
    id, albumCid, albumName,
    songCid: song.cid, songName: song.name, index: index + 1,
    status: 'queued', step: 'audio',
    received: 0, total: 0, speed: 0, retries: 0, error: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  tasks.set(id, t);
  songActive.set(song.cid, id);
  queue.push(id);
  broadcastTask(t);
  pump();
  return 'added';
}

function failTask(t, e) {
  t.status = 'error';
  t.error = String(e?.message || e || '未知错误');
  t.speed = 0;
  t.updatedAt = Date.now();
  songActive.delete(t.songCid);
  broadcastTask(t);
  broadcastAlbum(t.albumCid);
}

async function runTask(task) {
  task.status = 'downloading';
  task.startedAt = Date.now();
  task.updatedAt = Date.now();
  broadcastTask(task);
  try {
    const album = await getAlbumDetail(task.albumCid);
    const idx = album.songs.findIndex((s) => s.cid === task.songCid);
    if (idx < 0) throw new Error('歌曲不在该专辑中');
    const { albumDir } = await ensureAlbumDir(album);
    await downloadSongFiles(task, album, albumDir, idx);

    task.status = 'done';
    task.step = 'done';
    task.finishedAt = Date.now();
    task.speed = 0;
    task.updatedAt = Date.now();
    songActive.delete(task.songCid);

    const ls = (local.albums[task.albumCid] ||= { dir: path.basename(albumDir), cover: false, songs: {} });
    ls.songs[task.songCid] = {
      downloaded: true,
      size: task.total || 0,
      file: task.file,
      lyric: task.lyricFile,
      mv: task.mvFile,
    };
    broadcastTask(task);
    broadcastAlbum(task.albumCid);
    broadcast('stats', statsView());
  } catch (e) {
    task.error = String(e?.message || e);
    if (task.retries < MAX_RETRY) {
      task.retries++;
      task.status = 'queued';
      task.updatedAt = Date.now();
      log(`任务重试 ${task.retries}/${MAX_RETRY}: ${task.songName} — ${task.error}`);
      broadcastTask(task);
      setTimeout(() => {
        const cur = tasks.get(task.id);
        if (cur && cur.status === 'queued' && !queue.includes(task.id)) {
          queue.push(task.id);
          pump();
        }
      }, 1500 * Math.pow(2, task.retries - 1));
    } else {
      failTask(task, e);
    }
  }
}

/** 确保专辑目录、封面、album.json 就绪 */
async function ensureAlbumDir(album) {
  return withLock('album:' + album.cid, async () => {
    const dirName = sanitizeFilename(album.name, album.cid, 60);
    const albumDir = path.join(config.downloadDir, dirName);
    await fsp.mkdir(albumDir, { recursive: true });

    let cover = await findCoverFile(albumDir);
    if (!cover) cover = await fetchCover(album, albumDir);

    const metaPath = path.join(albumDir, 'album.json');
    const old = await readJson(metaPath, null);
    const oldMap = new Map((old?.songs || []).map((s) => [s.cid, s]));
    const meta = {
      version: 1,
      cid: album.cid,
      name: album.name,
      artistes: album.artistes || [],
      intro: album.intro || '',
      cover,
      songs: (album.songs || []).map((s, i) => {
        const prev = oldMap.get(s.cid);
        return {
          cid: s.cid,
          index: i + 1,
          name: s.name,
          artistes: s.artistes || [],
          file: prev?.file || null,
          lyric: prev?.lyric || null,
          mv: prev?.mv || null,
        };
      }),
    };
    await writeJson(metaPath, meta);
    return { albumDir, meta };
  });
}

async function downloadSongFiles(task, album, albumDir, order) {
  const sd = await getSongDetail(task.songCid);
  if (!sd || !sd.sourceUrl) throw new Error('该歌曲没有可下载的音频地址');

  const srcExt = (new URL(sd.sourceUrl).pathname.match(/\.[a-z0-9]+$/i) || ['.wav'])[0].toLowerCase();
  const base = `${pad2(order + 1)} - ${sanitizeFilename(task.songName, task.songCid, 55)}`;
  const audioName = base + srcExt;
  const audioPath = path.join(albumDir, audioName);

  task.step = 'audio';
  const audioInfo = await downloadFile(task, sd.sourceUrl, audioPath);
  if (audioInfo.skipped) log(`跳过已存在音频: ${audioName}`);

  let lyricName = null;
  if (sd.lyricUrl) {
    task.step = 'lyric';
    task.speed = 0;
    task.updatedAt = Date.now();
    broadcastTask(task);
    lyricName = base + '.lrc';
    const r = await downloadFile(task, sd.lyricUrl, path.join(albumDir, lyricName), { quiet: true });
    if (r.skipped) log(`跳过已存在歌词: ${lyricName}`);
  }

  let mvName = null;
  if (config.downloadMV && sd.mvUrl) {
    task.step = 'mv';
    task.speed = 0;
    task.updatedAt = Date.now();
    broadcastTask(task);
    const mvDir = path.join(albumDir, 'MV');
    await fsp.mkdir(mvDir, { recursive: true });
    const mvExt = (new URL(sd.mvUrl).pathname.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0].toLowerCase();
    mvName = base + mvExt;
    await downloadFile(task, sd.mvUrl, path.join(mvDir, mvName), { quiet: true });
  }

  task.file = audioName;
  task.lyricFile = lyricName;
  task.mvFile = mvName;

  await withLock('album:' + album.cid, async () => {
    const metaPath = path.join(albumDir, 'album.json');
    const meta = await readJson(metaPath, null);
    if (!meta) return;
    const rec = (meta.songs || []).find((s) => s.cid === task.songCid);
    if (rec) {
      rec.file = audioName;
      rec.lyric = lyricName;
      rec.mv = mvName;
      await writeJson(metaPath, meta);
    }
  });
}

async function downloadFile(task, url, target, opts = {}) {
  const existing = await fsp.stat(target).catch(() => null);
  if (!opts.force && existing && existing.size > 0) {
    return { skipped: true, size: existing.size };
  }
  const tmp = target + '.part';
  const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);

  let received = 0;
  let lastT = Date.now(), lastB = 0;
  let timer = null;
  if (!opts.quiet) {
    timer = setInterval(() => {
      const now = Date.now();
      const dt = Math.max((now - lastT) / 1000, 0.001);
      task.received = received;
      task.total = total;
      task.speed = (received - lastB) / dt;
      lastB = received;
      lastT = now;
      task.updatedAt = now;
      broadcastTask(task);
    }, 500);
  }

  try {
    const meterStream = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meterStream, fs.createWriteStream(tmp));
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  } finally {
    if (timer) clearInterval(timer);
  }

  const st = await fsp.stat(tmp).catch(() => null);
  if (total && (!st || st.size !== total)) {
    try { await fsp.unlink(tmp); } catch {}
    throw new Error(`文件不完整 ${st?.size || 0}/${total}`);
  }
  await fsp.rename(tmp, target);
  if (!opts.quiet) {
    task.received = received;
    task.total = total || received;
    task.speed = 0;
  }
  return { skipped: false, size: received };
}

// ---------------------------------------------------------------- 封面
async function findCoverFile(dir) {
  for (const name of ['cover.jpg', 'cover.png', 'cover.webp']) {
    if (await exists(path.join(dir, name))) return name;
  }
  return null;
}

async function fetchCover(album, dir) {
  const candidates = [album.coverDeUrl, album.coverUrl].filter(Boolean);
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(60000) });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
      const name = 'cover' + ext;
      const tmp = path.join(dir, name + '.part');
      const meter = new Transform({ transform: (c, _e, cb) => cb(null, c) });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, path.join(dir, name));
      return name;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------- 打开文件夹
function openFolder(dir) {
  let cmd;
  if (process.platform === 'win32') cmd = `explorer "${String(dir).replace(/"/g, '')}"`;
  else if (process.platform === 'darwin') cmd = `open "${String(dir).replace(/"/g, '')}"`;
  else cmd = `xdg-open "${String(dir).replace(/"/g, '')}"`;
  exec(cmd, () => {});
}
function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') cmd = `start "" "${url}"`;
  else if (process.platform === 'darwin') cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ---------------------------------------------------------------- HTTP 服务
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// 安全的流式响应：任何一方出错都不影响进程
function pipeSafe(stream, res) {
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

async function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // 单文件 exe：直接从内联资源返回
  if (embeddedAssets && embeddedAssets.default && embeddedAssets.default[rel]) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream' });
    res.end(embeddedAssets.default[rel]);
    return;
  }
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
}

async function handler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(u.pathname);

  try {
    // ---------- API ----------
    if (p === '/api/state') {
      return sendJson(res, 200, {
        config: { downloadDir: config.downloadDir, concurrency: config.concurrency, downloadMV: config.downloadMV, port: config.port },
        ...catalogView(),
        stats: catalog.ready ? statsView() : null,
        tasksRunning: runningCount,
        queueLen: queue.length,
      });
    }

    if (p === '/api/albums') {
      if (!catalog.ready && !catalog.loading) loadCatalog();
      return sendJson(res, 200, {
        ...catalogView(),
        stats: catalog.ready ? statsView() : null,
        albums: catalog.albums.map((a) => ({
          ...a,
          local: aggregateFor(a.cid),
          active: activeTasksForAlbum(a.cid),
        })),
      });
    }

    if (p.startsWith('/api/album/')) {
      const cid = p.slice('/api/album/'.length);
      if (!cid) return sendJson(res, 400, { error: 'missing cid' });
      const detail = await getAlbumDetail(cid);
      const ls = local.albums[cid];
      const agg = aggregateFor(cid);
      const active = activeTasksForAlbum(cid);
      return sendJson(res, 200, {
        album: {
          cid: detail.cid,
          name: detail.name,
          intro: detail.intro || '',
          belong: detail.belong || '',
          coverUrl: detail.coverUrl,
          coverDeUrl: detail.coverDeUrl || detail.coverUrl,
          artistes: detail.artistes || [],
          date: (detail.coverUrl || '').match(/\/pic\/(\d{8})\//)?.[1] || '',
          songs: detail.songs.map((s, i) => ({
            cid: s.cid,
            index: i + 1,
            name: s.name,
            artistes: s.artistes || [],
            downloaded: !!agg.songStatus[s.cid],
            file: ls?.songs?.[s.cid]?.file || null,
            hasLyric: !!ls?.songs?.[s.cid]?.lyric,
            hasMV: !!ls?.songs?.[s.cid]?.mv,
            active: active[s.cid] || null,
          })),
        },
        local: agg,
      });
    }

    if (p === '/api/song' && u.searchParams.get('cid')) {
      return sendJson(res, 200, { song: await getSongDetail(u.searchParams.get('cid')) });
    }

    if (p === '/api/download' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.albumCid) {
        const detail = await getAlbumDetail(body.albumCid);
        await ensureAlbumDir(detail);
        const agg = aggregateFor(detail.cid);
        let added = 0, skipped = 0;
        detail.songs.forEach((s, i) => {
          if (agg.songStatus[s.cid]) { skipped++; return; }
          if (enqueueSong(detail.cid, detail.name, s, i) === 'added') added++;
          else skipped++;
        });
        broadcastAlbum(detail.cid);
        return sendJson(res, 200, { ok: true, added, skipped });
      }
      if (body.songCid) {
        const sd = await getSongDetail(body.songCid);
        const albumCid = sd.albumCid;
        if (!albumCid) return sendJson(res, 400, { error: '无法确定歌曲所属专辑' });
        const detail = await getAlbumDetail(albumCid);
        const idx = detail.songs.findIndex((s) => s.cid === body.songCid);
        if (idx < 0) return sendJson(res, 400, { error: '歌曲不在专辑中' });
        const agg = aggregateFor(albumCid);
        if (agg.songStatus[body.songCid]) return sendJson(res, 200, { ok: true, added: 0, skipped: 1, already: true });
        const r = enqueueSong(albumCid, detail.name, detail.songs[idx], idx);
        broadcastAlbum(albumCid);
        return sendJson(res, 200, { ok: true, added: r === 'added' ? 1 : 0, skipped: r === 'added' ? 0 : 1 });
      }
      return sendJson(res, 400, { error: '缺少 albumCid 或 songCid' });
    }

    if (p === '/api/download-many' && req.method === 'POST') {
      const body = await readBody(req);
      let added = 0, skipped = 0;
      for (const albumCid of body.albumCids || []) {
        try {
          const detail = await getAlbumDetail(albumCid);
          await ensureAlbumDir(detail);
          const agg = aggregateFor(albumCid);
          detail.songs.forEach((s, i) => {
            if (agg.songStatus[s.cid]) { skipped++; return; }
            if (enqueueSong(albumCid, detail.name, s, i) === 'added') added++;
            else skipped++;
          });
          broadcastAlbum(albumCid);
        } catch { skipped++; }
      }
      return sendJson(res, 200, { ok: true, added, skipped });
    }

    if (p === '/api/retry' && req.method === 'POST') {
      const body = await readBody(req);
      const t = tasks.get(body.taskId);
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      if (t.status !== 'error') return sendJson(res, 200, { ok: true, ignored: true });
      t.status = 'queued';
      t.error = '';
      t.retries = 0;
      t.received = 0;
      t.total = 0;
      t.speed = 0;
      t.updatedAt = Date.now();
      songActive.set(t.songCid, t.id);
      if (!queue.includes(t.id)) queue.push(t.id);
      broadcastTask(t);
      pump();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/tasks') {
      const list = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
      return sendJson(res, 200, { tasks: list.map(taskView), running: runningCount, queued: queue.length });
    }

    if (p === '/api/clear-done' && req.method === 'POST') {
      let n = 0;
      for (const [id, t] of tasks) {
        if (t.status === 'done' || t.status === 'error') { tasks.delete(id); if (t.status === 'done') n++; }
      }
      broadcast('stats', statsView());
      return sendJson(res, 200, { ok: true, cleared: n });
    }

    if (p === '/api/scan' && req.method === 'POST') {
      await scanLocal();
      return sendJson(res, 200, { ok: true, ...statsView() });
    }

    if (p === '/api/refresh-catalog' && req.method === 'POST') {
      detailCache.clear();
      songDetailCache.clear();
      await loadCatalog();
      return sendJson(res, 200, { ok: true, ...catalogView() });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
        patch.downloadDir = path.resolve(body.downloadDir.trim());
      }
      if (Number.isFinite(body.concurrency)) patch.concurrency = Math.min(5, Math.max(1, Math.round(body.concurrency)));
      if (typeof body.downloadMV === 'boolean') patch.downloadMV = body.downloadMV;
      if (Number.isFinite(body.port)) patch.port = Math.round(body.port);
      await saveConfig(patch);
      if (patch.downloadDir) await fsp.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      if (patch.downloadDir) {
        await scanLocal();
        broadcast('stats', statsView());
      }
      return sendJson(res, 200, {
        ok: true,
        config: { downloadDir: config.downloadDir, concurrency: config.concurrency, downloadMV: config.downloadMV, port: config.port },
        portChanged: !!patch.port && patch.port !== (body.oldPort ?? config.port),
      });
    }

    if (p === '/api/open-folder' && req.method === 'POST') {
      await fsp.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      openFolder(config.downloadDir);
      return sendJson(res, 200, { ok: true, dir: config.downloadDir });
    }

    // 弹出系统「选择文件夹」对话框（Windows），选完直接返回路径
    if (p === '/api/pick-folder' && req.method === 'POST') {
      if (process.platform !== 'win32') {
        return sendJson(res, 400, { error: '当前系统暂不支持文件夹选择器，请手动输入路径' });
      }
      if (pickingFolder) return sendJson(res, 409, { error: '已有一个选择窗口打开中，请先处理它' });
      pickingFolder = true;
      try {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          'Add-Type @"',
          'using System;',
          'using System.Runtime.InteropServices;',
          'public class Win32 {',
          '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);',
          '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
          '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
          '}',
          '"@',
          '$screens = [System.Windows.Forms.Screen]::AllScreens',
          '$target = $screens[0]',
          'if ($screens.Count -gt 1) { $target = $screens[1] }',
          '$wa = $target.WorkingArea',
          '$owner = New-Object System.Windows.Forms.Form',
          '$owner.TopMost = $true',
          '$owner.ShowInTaskbar = $false',
          "$owner.FormBorderStyle = 'None'",
          '$owner.Opacity = 0',
          "$owner.StartPosition = 'Manual'",
          '$owner.Location = New-Object System.Drawing.Point(($wa.X + [int]($wa.Width/2)), ($wa.Y + [int]($wa.Height/2)))',
          '$owner.Size = New-Object System.Drawing.Size(1, 1)',
          '$owner.Show()',
          '$owner.Activate()',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$d.Description = '选择音乐保存文件夹'",
          '$d.ShowNewFolderButton = $true',
          'try { $d.SelectedPath = [Environment]::GetFolderPath("MyMusic") } catch {}',
          '$t = New-Object System.Windows.Forms.Timer',
          '$t.Interval = 600',
          '$t.Add_Tick({',
          "  $h = [Win32]::FindWindow('#32770', '浏览文件夹')",
          '  if ($h -ne [IntPtr]::Zero) {',
          '    if ($screens.Count -gt 1) {',
          '      $tx = $wa.X + [int](($wa.Width - 900) / 2)',
          '      $ty = $wa.Y + [int](($wa.Height - 923) / 2)',
          '      [Win32]::SetWindowPos($h, [IntPtr](-1), $tx, $ty, 0, 0, 0x0011) | Out-Null',
          '    } else {',
          '      [Win32]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null',
          '    }',
          '    [Win32]::SetForegroundWindow($h) | Out-Null',
          '    $t.Stop()',
          '  }',
          '})',
          '$t.Start()',
          '$r = $d.ShowDialog($owner)',
          '$t.Stop()',
          "if ($r -eq 'OK') { Write-Output $d.SelectedPath }",
          '$owner.Close()',
        ].join('\r\n');
        const b64 = Buffer.from(script, 'utf16le').toString('base64');
        const { stdout } = await new Promise((resolve, reject) => {
          execFile(
            'powershell.exe',
            ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
            { timeout: 300000, windowsHide: true },
            (err, out) => (err ? reject(err) : resolve({ stdout: out }))
          );
        });
        const picked = String(stdout || '').trim();
        return sendJson(res, 200, { path: picked || null });
      } catch (e) {
        log('文件夹选择器失败:', e?.message || e);
        return sendJson(res, 500, { error: '无法打开文件夹选择器：' + String(e?.message || e) });
      } finally {
        pickingFolder = false;
      }
    }

    // 自定义背景图：上传（base64 JSON）/ 读取 / 删除
    const BG_DIR = path.join(APP_DIR, 'userdata');
    const BG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const bgFile = async () => {
      try {
        for (const f of await fsp.readdir(BG_DIR)) {
          if (f.startsWith('background.') && BG_EXTS.includes(path.extname(f).toLowerCase())) return path.join(BG_DIR, f);
        }
      } catch { /* 目录不存在 */ }
      return null;
    };

    if (p === '/api/background' && req.method === 'POST') {
      const body = await readBody(req, 30 * 1024 * 1024);
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
      if (!m) return sendJson(res, 400, { error: '无效的图片数据' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 20 * 1024 * 1024) return sendJson(res, 413, { error: '图片不能超过 20MB' });
      const ext = m[1] === 'jpeg' ? '.jpg' : '.' + m[1];
      await fsp.mkdir(BG_DIR, { recursive: true });
      const old = await bgFile();
      if (old) await fsp.unlink(old).catch(() => {});
      await fsp.writeFile(path.join(BG_DIR, 'background' + ext), buf);
      return sendJson(res, 200, { ok: true, url: '/api/background?v=' + Date.now() });
    }

    if (p === '/api/background' && req.method === 'GET') {
      const file = await bgFile();
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('no background');
        return;
      }
      const ct =
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
        }[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
      pipeSafe(fs.createReadStream(file), res);
      return;
    }

    if (p === '/api/background' && req.method === 'DELETE') {
      const old = await bgFile();
      if (old) await fsp.unlink(old).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // 封面代理：规避 CDN 的 Referer 防盗链
    if (p === '/api/cover' && (req.method === 'GET' || req.method === 'HEAD')) {
      const cid = u.searchParams.get('albumCid');
      const big = u.searchParams.get('big') === '1';
      const album = catalog.albumMap.get(cid);
      let url = null;
      if (big) {
        const detail = detailCache.get(cid) || (await getAlbumDetail(cid).catch(() => null));
        url = detail?.coverDeUrl || detail?.coverUrl || album?.coverUrl || null;
      } else {
        url = album?.coverUrl || null;
      }
      if (!url) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('no cover');
        return;
      }
      const r = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(30000) });
      if (!r.ok) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('cover fetch failed');
        return;
      }
      res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      pipeSafe(Readable.fromWeb(r.body), res);
      return;
    }

    // 本地歌词：读取 .lrc
    if (p === '/api/lyric' && req.method === 'GET') {
      const albumCid = u.searchParams.get('albumCid');
      const songCid = u.searchParams.get('songCid');
      const ls = local.albums[albumCid];
      const rec = ls?.songs?.[songCid];
      if (rec && rec.lyric) {
        const rootAbs = path.resolve(config.downloadDir);
        const full = path.resolve(rootAbs, ls.dir, rec.lyric);
        if (full.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep)) {
          const text = await fsp.readFile(full, 'utf8').catch(() => null);
          if (text) return sendJson(res, 200, { lyric: text });
        }
      }
      return sendJson(res, 200, { lyric: null });
    }

    // 本地音频播放：支持 Range（seek）与 HEAD
    if (p === '/api/audio' && (req.method === 'GET' || req.method === 'HEAD')) {
      const albumCid = u.searchParams.get('albumCid');
      const songCid = u.searchParams.get('songCid');
      const isHead = req.method === 'HEAD';
      const ls = local.albums[albumCid];
      const rec = ls?.songs?.[songCid];
      if (!rec || !rec.downloaded || !rec.file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not downloaded');
        return;
      }
      const rootAbs = path.resolve(config.downloadDir);
      const full = path.resolve(rootAbs, ls.dir, rec.file);
      if (!full.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      let st;
      try { st = await fsp.stat(full); } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const mime = AUDIO_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        if (isHead) { res.end(); return; }
        pipeSafe(fs.createReadStream(full, { start, end }), res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': st.size,
      });
      if (isHead) { res.end(); return; }
      pipeSafe(fs.createReadStream(full), res);
      return;
    }

    if (p === '/api/events') return sse(req, res);

    // ---------- 静态资源 ----------
    return serveStatic(req, res, p);
  } catch (e) {
    log('请求错误:', p, e?.message || e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

// ---------------------------------------------------------------- 启动
async function listenWithRetry(basePort) {
  for (let port = basePort; port < basePort + 30; port++) {
    try {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return { server, port };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('找不到可用端口');
}

function createServer() {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      log('未捕获请求错误:', e?.message || e);
      try { sendJson(res, 500, { error: String(e?.message || e) }); } catch {}
    });
  });
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  return server;
}

async function main() {
  // 兜底：任何未捕获异常都不让服务退出，只记录日志
  process.on('uncaughtException', (e) => log('未捕获异常（已忽略，服务继续）:', e?.message || e));
  process.on('unhandledRejection', (e) => log('未处理 Promise 拒绝（已忽略）:', e?.message || e));

  await loadConfig();

  // 默认下载目录：用户「音乐」文件夹。若被安全软件限制不可写（EPERM/EACCES），
  // 自动回退到程序所在目录的 downloads/，保证开箱即用。
  // 注意：目录已存在时 mkdir 不会报错，所以要探测「创建子目录」的真实权限。
  let downloadDirReady = false;
  try {
    await fsp.mkdir(config.downloadDir, { recursive: true });
    const probe = path.join(config.downloadDir, '.siren-write-test');
    await fsp.mkdir(probe, { recursive: true });
    await fsp.rmdir(probe).catch(() => {});
    downloadDirReady = true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      const fallback = path.join(APP_DIR, 'downloads');
      log(`默认下载目录不可写（${e.code}，可能被安全软件限制），自动改用：${fallback}`);
      config.downloadDir = fallback;
      await fsp.mkdir(fallback, { recursive: true }).catch((e2) => log('备用下载目录也不可写:', e2.message));
      await saveConfig({ downloadDir: fallback }).catch(() => {});
      downloadDirReady = true;
    } else {
      log('创建下载目录失败:', e.message);
    }
  }
  if (downloadDirReady) await scanLocal();
  loadCatalog();

  const { server, port } = await listenWithRetry(config.port);
  const url = `http://127.0.0.1:${port}`;
  log(`服务已启动: ${url}`);
  log(`下载目录: ${config.downloadDir}`);
  log('按 Ctrl+C 停止');

  if (!process.env.SIREN_NO_OPEN) setTimeout(() => openBrowser(url), 800);

  // 优雅退出：让未完成的任务自然结束（不阻塞）
  process.on('SIGINT', () => {
    log('正在退出…');
    server.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[siren] 启动失败:', e);
  process.exit(1);
});
