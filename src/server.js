import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, subscribeConfig, watchConfig } from './config.js';
import { log, writeErrorReport, recentLogs, redact } from './logger.js';
import { JobManager } from './jobs.js';
import { PollingManager } from './web-poller.js';
import { LibraryIndex } from './library-index.js';
import { apiMetrics, tikhubRequest } from './tikhub.js';
import { billingSnapshot } from './api-billing.js';
import { acquireFileLock } from './persistence.js';
import { queryUser, listVideos, lookupVideos, downloadSingle, downloadVideos, VALID_TYPES } from './tasks.js';
import { deleteLibraryItem, getLibraryItem, getLibraryMedia } from './library.js';
import { Store } from './store.js';
import { cachedName } from './profile-cache.js';
import { publicSettings, saveSettings, saveWatchers, savedWatcher } from './settings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const LOOKUP_CACHE_LIMIT = 50;
const lookupCache = new Map();

function cacheLookup(prepared) {
  const now = Date.now();
  for (const [id, entry] of lookupCache) {
    if (entry.expiresAt <= now) lookupCache.delete(id);
  }
  while (lookupCache.size >= LOOKUP_CACHE_LIMIT) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
  const id = crypto.randomUUID();
  lookupCache.set(id, { prepared, expiresAt: now + LOOKUP_TTL_MS });
  return id;
}

function getCachedLookup(id) {
  if (!id) return null;
  const entry = lookupCache.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    lookupCache.delete(id);
    return null;
  }
  return entry.prepared;
}

class HttpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendStatic(res, file, contentType) {
  const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function contentTypeFor(file) {
  return {
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  }[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendMedia(req, res, file) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const headers = {
    'Content-Type': contentTypeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  };

  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  const suffix = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffix !== null ? Math.max(0, stat.size - suffix) : match[1] ? Number(match[1]) : 0;
  const end = suffix !== null ? stat.size - 1 : match[2] ? Number(match[2]) : stat.size - 1;
  if ((!match[1] && !match[2]) || suffix === 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  const boundedEnd = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    ...headers,
    'Content-Length': boundedEnd - start + 1,
    'Content-Range': `bytes ${start}-${boundedEnd}/${stat.size}`,
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file, { start, end: boundedEnd }).pipe(res);
}

function parseLimit(value, fallback, { allowAll = false } = {}) {
  if (allowAll && (value === null || value === undefined || value === '')) return Infinity;
  const limit = Number(value ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError('limit 必须是 1 到 200 之间的整数');
  }
  return limit;
}

function validateType(type) {
  if (!VALID_TYPES.includes(type)) throw new HttpError('type 必须是 post、like 或 collect');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError('请求体必须是有效的 JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * HTTP JSON API 处理器。
 * 路由:
 *   GET  /health
 *   GET  /api/user?identifier=xxx
 *   GET  /api/list?identifier=xxx&type=post&limit=20&cookie=
 *   POST /api/lookup          { identifier, type, limit, cookie }
 *   POST /api/download        { identifier, type, limit, cookie }
 *   POST /api/download/single { url }  （分享链接或 aweme_id）
 *   GET  /api/library
 *   GET  /api/library/item?id=
 *   GET  /api/library/media?id=&file=0
 *   DELETE /api/library/item?id=
 */
async function handle(req, res, { jobs, library, poller, startedAt }) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method.toUpperCase();

  try {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError('不接受跨站请求', 403);
    if (method === 'GET' && STATIC_FILES.has(path)) {
      return sendStatic(res, ...STATIC_FILES.get(path));
    }

    if (path === '/health') return sendJson(res, 200, { status: 'ok', time: Date.now() });

    if (method === 'GET' && path === '/api/billing') return sendJson(res, 200, { data: billingSnapshot() });
    if (method === 'GET' && path === '/api/billing/balance') {
      const result = await tikhubRequest('/api/v1/tikhub/user/get_user_info', { retries: 1 });
      const user = result.user_data || result.data?.user_data || result.data || {};
      const value = key => typeof user[key] === 'number' && Number.isFinite(user[key]) ? user[key] : null;
      return sendJson(res, 200, { data: { balance: value('balance'), freeCredit: value('free_credit'), checkedAt: new Date().toISOString() } });
    }

    if (method === 'GET' && path === '/api/console') {
      const media = await library.query({ limit: 1 });
      return sendJson(res, 200, { data: {
        startedAt, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        concurrency: { tasks: config.taskConcurrency, downloads: config.downloadConcurrency },
        api: { ...apiMetrics }, tasks: jobs.list({ limit: 0 }).counts, library: media.summary,
        poller: poller.snapshot(),
        logs: recentLogs(Number(q.get('after')) || 0),
        watchers: publicSettings().watchers.map((w, id) => ({ id, name: w.name || cachedName(w.identifier) || w.identifier, identifier: w.identifier, types: w.types || ['post'], limit: w.limit || 20 })),
      } });
    }
    if (method === 'GET' && path === '/api/poller') return sendJson(res, 200, { data: poller.snapshot() });
    const pollerAction = /^\/api\/poller\/(start|stop|run)$/.exec(path);
    if (method === 'POST' && pollerAction) {
      const state = pollerAction[1] === 'start' ? poller.enable() : pollerAction[1] === 'stop' ? poller.disable() : poller.runOnce();
      return sendJson(res, 202, { data: state });
    }
    if (method === 'GET' && path === '/api/jobs') {
      const offset = Number(q.get('offset') || 0);
      if (!Number.isInteger(offset) || offset < 0) throw new HttpError('offset 必须是非负整数');
      return sendJson(res, 200, { data: jobs.list({ offset, limit: parseLimit(q.get('limit'), 30), status: q.get('status') || '' }) });
    }
    if (method === 'POST' && path === '/api/jobs') {
      const body = await readBody(req);
      if (body.kind === 'single') {
        if (typeof body.url !== 'string' || !body.url.trim()) throw new HttpError('缺少作品链接或 ID');
        return sendJson(res, 202, { data: jobs.submit('single', { url: body.url.trim() }) });
      }
      if (body.kind && body.kind !== 'batch') throw new HttpError('任务类型无效');
      const { identifier = '', type = 'post', cookie = '', lookupId = '' } = body;
      validateType(type);
      if (!identifier && type !== 'collect') throw new HttpError('缺少 identifier 字段');
      const limit = parseLimit(body.limit, Infinity, { allowAll: true });
      const prepared = lookupId ? getCachedLookup(lookupId) : null;
      if (lookupId && !prepared) throw new HttpError('查询结果已过期，请重新查询后再下载', 409);
      if (prepared && prepared.type !== type) throw new HttpError('查询类型已变化，请重新查询', 409);
      return sendJson(res, 202, { data: jobs.submit('batch', { identifier, type, cookie, limit, prepared }, prepared ? `${prepared.userName} · ${prepared.label}` : '') });
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)(?:\/(cancel|retry))?$/.exec(path);
    if (jobMatch) {
      if (method === 'GET' && !jobMatch[2]) return sendJson(res, 200, { data: jobs.get(jobMatch[1]) });
      if (method === 'POST' && jobMatch[2] === 'cancel') return sendJson(res, 200, { data: jobs.cancel(jobMatch[1]) });
      if (method === 'POST' && jobMatch[2] === 'retry') return sendJson(res, 202, { data: jobs.retry(jobMatch[1]) });
    }
    const watcherMatch = /^\/api\/watchers\/(\d+)\/run$/.exec(path);
    if (method === 'POST' && watcherMatch) {
      const watcher = savedWatcher(Number(watcherMatch[1]));
      if (!watcher) throw new HttpError('监听目标不存在', 404);
      return sendJson(res, 202, { data: poller.runOnce(watcher.id) });
    }

    if (method === 'GET' && path === '/api/settings') return sendJson(res, 200, { data: publicSettings() });
    if (method === 'PUT' && path === '/api/settings') {
      try { return sendJson(res, 200, { data: saveSettings(await readBody(req)) }); }
      catch (error) { throw new HttpError(error.message); }
    }
    if (method === 'PUT' && path === '/api/watchers') {
      try { return sendJson(res, 200, { data: saveWatchers((await readBody(req)).watchers) }); }
      catch (error) { throw new HttpError(error.message); }
    }

    if (method === 'GET' && path === '/api/library') {
      const offset = Number(q.get('offset') || 0);
      if (!Number.isInteger(offset) || offset < 0) throw new HttpError('offset 必须是非负整数');
      const result = await library.query({ offset, limit: parseLimit(q.get('limit'), 24), search: q.get('search') || '', kind: q.get('kind') || '', user: q.get('user') || '', type: q.get('type') || '', refresh: q.get('refresh') === '1' });
      result.items = result.items.map(item => ({ ...item, displayUser: cachedName(item.user) || item.author || item.user }));
      result.summary.userNames = Object.fromEntries(result.summary.users.map(user => [user, cachedName(user) || user]));
      return sendJson(res, 200, { data: result });
    }

    if (method === 'GET' && path === '/api/library/item') {
      const id = q.get('id');
      if (!id) return sendJson(res, 400, { error: '缺少媒体 ID' });
      const item = getLibraryItem(id).item;
      return sendJson(res, 200, { data: { ...item, displayUser: cachedName(item.user) || item.author || item.user } });
    }

    if (['GET', 'HEAD'].includes(method) && path === '/api/library/media') {
      const id = q.get('id');
      if (!id) return sendJson(res, 400, { error: '缺少媒体 ID' });
      return sendMedia(req, res, getLibraryMedia(id, q.get('file') || 0));
    }

    if (method === 'DELETE' && path === '/api/library/item') {
      const id = q.get('id');
      if (!id) return sendJson(res, 400, { error: '缺少媒体 ID' });
      const item = deleteLibraryItem(id);
      const storeUpdated = item.awemeId ? new Store().removeAweme(item.awemeId) : false;
      library.invalidate();
      return sendJson(res, 200, { data: { deleted: true, item, storeUpdated } });
    }

    if (method === 'GET' && path === '/api/user') {
      const identifier = q.get('identifier');
      if (!identifier) return sendJson(res, 400, { error: '缺少 identifier 参数' });
      return sendJson(res, 200, { data: await queryUser(identifier) });
    }

    if (method === 'POST' && path === '/api/lookup') {
      const body = await readBody(req);
      const { identifier = '', type = 'post', cookie = '' } = body;
      validateType(type);
      if (!identifier && type !== 'collect') return sendJson(res, 400, { error: '缺少 identifier 字段' });
      const limit = parseLimit(body.limit, 20);
      const result = await lookupVideos({ identifier, type, limit, cookie });
      const lookupId = cacheLookup(result.prepared);
      return sendJson(res, 200, { data: { user: result.user, videos: result.videos, lookupId } });
    }

    if (method === 'GET' && path === '/api/list') {
      const identifier = q.get('identifier');
      const type = q.get('type') || 'post';
      validateType(type);
      const limit = parseLimit(q.get('limit'), 20);
      const cookie = q.get('cookie') || '';
      if (!identifier && type !== 'collect') return sendJson(res, 400, { error: '缺少 identifier 参数' });
      return sendJson(res, 200, { data: await listVideos({ identifier, type, limit, cookie }) });
    }

    if (method === 'POST' && path === '/api/list') {
      const body = await readBody(req);
      const { identifier = '', type = 'post', cookie = '' } = body;
      validateType(type);
      if (!identifier && type !== 'collect') return sendJson(res, 400, { error: '缺少 identifier 字段' });
      const limit = parseLimit(body.limit, 20);
      return sendJson(res, 200, { data: await listVideos({ identifier, type, limit, cookie }) });
    }

    if (method === 'POST' && path === '/api/download/single') {
      const body = await readBody(req);
      const url = body.url;
      if (!url) return sendJson(res, 400, { error: '缺少 url 字段' });
      try { return sendJson(res, 200, { data: await downloadSingle(url) }); }
      finally { library.invalidate(); }
    }

    if (method === 'POST' && path === '/api/download') {
      const body = await readBody(req);
      const { identifier, type = 'post', cookie = '', lookupId = '' } = body;
      validateType(type);
      if (!identifier && type !== 'collect') return sendJson(res, 400, { error: '缺少 identifier 字段' });
      const limit = parseLimit(body.limit, Infinity, { allowAll: true });
      const prepared = lookupId ? getCachedLookup(lookupId) : null;
      if (lookupId && !prepared) throw new HttpError('查询结果已过期，请重新查询后再下载', 409);
      try { return sendJson(res, 200, { data: await downloadVideos({ identifier, type, limit, cookie, prepared }) }); }
      finally { library.invalidate(); }
    }

    if (method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        data: {
          configured: Boolean(config.apiKey && !config.apiKey.includes('在此填入') && config.apiKey !== 'your_tikhub_api_key_here'),
          baseUrl: config.baseUrl,
          region: config.region,
          outputDir: config.outputDir,
          cookieConfigured: Boolean(config.cookie),
          watcherCount: Array.isArray(config.watchers) ? config.watchers.length : 0,
          downloadConcurrency: config.downloadConcurrency,
          taskConcurrency: config.taskConcurrency,
        },
      });
    }

    return sendJson(res, 404, { error: '未找到该路由', path });
  } catch (e) {
    writeErrorReport('http-handler', e, { method, path, query: Object.fromEntries(q) });
    return sendJson(res, e.statusCode || 500, { error: redact(e.message) });
  }
}

export function startServer(port = 8787, host = '127.0.0.1', options = {}) {
  let release;
  try {
    release = acquireFileLock(path.join(config.dataDir, 'server'));
  } catch (error) {
    if (!error.message.startsWith('存储正忙')) throw error;
    let pid = '';
    try { pid = fs.readFileSync(path.join(config.dataDir, 'server.lock'), 'utf8').trim(); } catch { /* lock changed */ }
    throw new Error(`Web 服务已在运行${/^\d+$/.test(pid) ? `（PID ${pid}）` : ''}。请先停止旧服务，再运行 npm run serve。`);
  }
  let library, jobs, poller;
  try {
    library = options.library || new LibraryIndex();
    jobs = options.jobs || new JobManager({ onChange: () => library.invalidate() });
    poller = options.poller || new PollingManager({ jobs });
  } catch (error) { release(); throw error; }
  const services = { library, jobs, poller, startedAt: Date.now() };
  const applyConfig = changed => {
    if (changed.includes('taskConcurrency')) jobs.setConcurrency(config.taskConcurrency);
    if (changed.includes('libraryCacheSeconds')) { library.ttlMs = config.libraryCacheSeconds * 1000; library.invalidate(); }
    if (changed.some(key => ['baseUrl', 'apiKey', 'cookie', 'region', 'count'].includes(key))) lookupCache.clear();
    try { poller.configure(); } catch (error) { poller.lastError = redact(error.message); log.error(`轮询配置生效失败: ${poller.lastError}`); }
  };
  const unsubscribe = subscribeConfig(applyConfig);
  const unwatch = watchConfig(error => log.error(`配置热重载失败，继续使用原设置: ${error.message}`));
  const server = http.createServer((req, res) => handle(req, res, services));
  server.services = services;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    unsubscribe(); unwatch();
    try { await poller.close(); await jobs.close(); await library.close(); } finally { release(); }
  })();
  server.on('close', () => { cleanup().catch(e => log.error(e.message)); });
  server.on('error', error => { cleanup().catch(e => log.error(e.message)); log.error(`服务启动失败: ${error.message}`); });
  server.shutdown = async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await cleanup();
    await closed;
  };
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    log.info(`Web UI 与 HTTP API 已启动: http://127.0.0.1:${actualPort}`);
    try { poller.configure({ resume: true }); } catch (error) { poller.lastError = redact(error.message); log.error(`轮询启动失败: ${poller.lastError}`); }
  });
  return server;
}
