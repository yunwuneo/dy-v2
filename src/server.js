import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log, writeErrorReport } from './logger.js';
import { queryUser, listVideos, lookupVideos, downloadSingle, downloadVideos, VALID_TYPES } from './tasks.js';
import { deleteLibraryItem, getLibraryItem, getLibraryMedia, listLibrary } from './library.js';
import { Store } from './store.js';

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
    'Access-Control-Allow-Origin': '*',
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
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
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
  const limit = Number.parseInt(String(value ?? fallback), 10);
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
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method.toUpperCase();

  try {
    if (method === 'GET' && STATIC_FILES.has(path)) {
      return sendStatic(res, ...STATIC_FILES.get(path));
    }

    if (path === '/health') return sendJson(res, 200, { status: 'ok', time: Date.now() });

    if (method === 'GET' && path === '/api/library') {
      return sendJson(res, 200, { data: listLibrary() });
    }

    if (method === 'GET' && path === '/api/library/item') {
      const id = q.get('id');
      if (!id) return sendJson(res, 400, { error: '缺少媒体 ID' });
      return sendJson(res, 200, { data: getLibraryItem(id).item });
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
      return sendJson(res, 200, { data: await downloadSingle(url) });
    }

    if (method === 'POST' && path === '/api/download') {
      const body = await readBody(req);
      const { identifier, type = 'post', cookie = '', lookupId = '' } = body;
      validateType(type);
      if (!identifier && type !== 'collect') return sendJson(res, 400, { error: '缺少 identifier 字段' });
      const limit = parseLimit(body.limit, Infinity, { allowAll: true });
      const prepared = lookupId ? getCachedLookup(lookupId) : null;
      if (lookupId && !prepared) throw new HttpError('查询结果已过期，请重新查询后再下载', 409);
      return sendJson(res, 200, { data: await downloadVideos({ identifier, type, limit, cookie, prepared }) });
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
        },
      });
    }

    return sendJson(res, 404, { error: '未找到该路由', path });
  } catch (e) {
    writeErrorReport('http-handler', e, { method, path, query: Object.fromEntries(q) });
    return sendJson(res, e.statusCode || 500, { error: e.message });
  }
}

export function startServer(port = 8787, host = '127.0.0.1') {
  const server = http.createServer(handle);
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    log.info(`Web UI 与 HTTP API 已启动: http://127.0.0.1:${actualPort}`);
  });
  return server;
}
