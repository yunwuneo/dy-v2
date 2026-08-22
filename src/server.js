import http from 'node:http';
import { config } from './config.js';
import { log } from './logger.js';
import { queryUser, listVideos, downloadSingle, downloadVideos } from './tasks.js';

function sendJson(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
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
 *   POST /api/download        { identifier, type, limit, cookie }
 *   POST /api/download/single { url }  （分享链接或 aweme_id）
 */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method.toUpperCase();

  try {
    if (path === '/health') return sendJson(res, 200, { status: 'ok', time: Date.now() });

    if (method === 'GET' && path === '/api/user') {
      const identifier = q.get('identifier');
      if (!identifier) return sendJson(res, 400, { error: '缺少 identifier 参数' });
      return sendJson(res, 200, { data: await queryUser(identifier) });
    }

    if (method === 'GET' && path === '/api/list') {
      const identifier = q.get('identifier');
      const type = q.get('type') || 'post';
      const limit = parseInt(q.get('limit') || '20', 10);
      const cookie = q.get('cookie') || '';
      if (!identifier) return sendJson(res, 400, { error: '缺少 identifier 参数' });
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
      const { identifier, type = 'post', limit = Infinity, cookie = '' } = body;
      if (!identifier) return sendJson(res, 400, { error: '缺少 identifier 字段' });
      return sendJson(res, 200, { data: await downloadVideos({ identifier, type, limit, cookie }) });
    }

    if (method === 'GET' && path === '/api/config') {
      const { apiKey, ...safe } = config;
      return sendJson(res, 200, { data: safe });
    }

    return sendJson(res, 404, { error: '未找到该路由', path });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

export function startServer(port = 8787) {
  const server = http.createServer(handle);
  server.listen(port, () => {
    log.info(`HTTP API 已启动: http://127.0.0.1:${port}`);
    log.info('  示例:');
    log.info(`    curl "http://127.0.0.1:${port}/api/user?identifier=抖音号"`);
    log.info(`    curl -X POST "http://127.0.0.1:${port}/api/download" -H "Content-Type: application/json" -d '{"identifier":"抖音号","type":"post","limit":10}'`);
  });
  return server;
}
