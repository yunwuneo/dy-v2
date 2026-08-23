import { config } from './config.js';

export class TikHubError extends Error {
  constructor(message, code = -1, router = '') {
    super(message);
    this.name = 'TikHubError';
    this.code = code;
    this.router = router;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inFlightRequests = new Map();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function assertKey() {
  if (!config.apiKey || config.apiKey.includes('在此填入') || config.apiKey === 'your_tikhub_api_key_here') {
    throw new TikHubError(
      '未配置 TikHub API Key：请在 config.json 中设置 apiKey，或设置环境变量 TIKHUB_API_KEY。',
      401,
    );
  }
}

/**
 * TikHub API 请求封装
 * @param {string} path 接口路径，例如 /api/v1/douyin/web/fetch_one_video
 * @param {object} opts { method, query, body, retries }
 * @returns {Promise<object>} 响应 JSON（含 code/router/data）
 */
async function performRequest(path, { method = 'GET', query = {}, body = null, retries = config.retry } = {}) {
  assertKey();
  const baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'douyin-downloader/1.0',
  };
  let payload;
  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (res.status === 429 || res.status >= 500) {
        lastErr = new TikHubError(`HTTP ${res.status}（第 ${i + 1} 次尝试）`, res.status, path);
        await sleep(1000 * (i + 1));
        continue;
      }

      const json = await res.json().catch(() => ({}));
      // 兼容两种错误格式：{code,message} 与 {detail:{code,message,...}}
      if ((json.detail?.code && Number(json.detail.code) !== 200) || (json.code && Number(json.code) !== 200)) {
        const d = json.detail ?? json;
        throw new TikHubError(
          d.message_zh || d.message || d.msg || `接口返回 code=${d.code}`,
          d.code,
          d.router || path,
        );
      }
      return json;
    } catch (e) {
      if (e instanceof TikHubError) throw e;
      lastErr = e;
      if (i < retries - 1) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr || new TikHubError('请求失败', -1, path);
}

export function tikhubRequest(path, options = {}) {
  const method = options.method || 'GET';
  const query = options.query || {};
  const body = options.body ?? null;
  const retries = options.retries ?? config.retry;
  const key = JSON.stringify([method, path, stableValue(query), stableValue(body), retries]);
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  let tracked;
  tracked = performRequest(path, options).finally(() => {
    if (inFlightRequests.get(key) === tracked) inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, tracked);
  return tracked;
}
