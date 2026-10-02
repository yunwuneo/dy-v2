import { config } from './config.js';
import { log, writeErrorReport } from './logger.js';
import { checkCancelled, executionSignal, fetchWithTimeout, sleep } from './execution.js';
import { recordApiStart, recordApiFinish } from './api-billing.js';

export class TikHubError extends Error {
  constructor(message, code = -1, router = '', details = {}) {
    super(message);
    this.name = 'TikHubError';
    this.code = code;
    this.router = router;
    Object.assign(this, details);
  }
}

const inFlightRequests = new Map();
export const apiMetrics = { requests: 0, succeeded: 0, failed: 0 };

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
  retries = Math.max(1, retries);
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
    let request;
    let billingStarted = false;
    let billingSucceeded = false;
    try {
      checkCancelled();
      try { recordApiStart(path); billingStarted = true; }
      catch (error) { log.warn(`API 账单写入失败: ${error.message}`); }
      apiMetrics.requests++;
      request = await fetchWithTimeout(url, {
        method,
        headers,
        body: payload,
      }, config.timeoutMs);
      const res = request.response;

      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        apiMetrics.failed++;
        lastErr = new TikHubError(`HTTP ${res.status}（第 ${i + 1} 次尝试）`, res.status, path, { httpStatus: res.status, query });
        writeErrorReport('tikhub-http', lastErr, { method, path, query, attempt: i + 1, status: res.status });
        await sleep(1000 * (i + 1));
        continue;
      }

      const json = await res.json();
      // 兼容两种错误格式：{code,message} 与 {detail:{code,message,...}}
      if (!res.ok || (json.detail?.code && Number(json.detail.code) !== 200) || (json.code && Number(json.code) !== 200)) {
        const d = json.detail ?? json;
        const err = new TikHubError(
          d.message_zh || d.message || d.msg || `接口返回 code=${d.code}`,
          d.code || res.status,
          d.router || path,
          { requestId: json.request_id, docs: json.docs, support: json.support, cacheUrl: json.cache_url, response: json },
        );
        // TikHub uses business code 400 for a transient upstream failure. Deterministic
        // validation errors (for example "invalid aweme_id") must remain single-shot.
        const retryable = Number(err.code) === 408 || Number(err.code) === 425 || Number(err.code) === 429 || Number(err.code) >= 500
          || /请求失败，请重试|request failed.*retry/i.test(err.message);
        writeErrorReport('tikhub-response', err, { method, path, query, attempt: i + 1, response: json, retryable });
        if (retryable && i < retries - 1) {
          apiMetrics.failed++;
          lastErr = err;
          log.warn(`TikHub ${path} 返回可重试错误（第 ${i + 1}/${retries} 次）: ${err.message}`);
          await sleep(1000 * (i + 1));
          continue;
        }
        throw err;
      }
      apiMetrics.succeeded++;
      billingSucceeded = true;
      return json;
    } catch (e) {
      apiMetrics.failed++;
      checkCancelled();
      if (e instanceof TikHubError) throw e;
      lastErr = e;
      writeErrorReport('tikhub-network', e, { method, path, query, attempt: i + 1 });
      if (i < retries - 1) await sleep(1000 * (i + 1));
    } finally {
      request?.release();
      if (billingStarted) {
        try { recordApiFinish(path, billingSucceeded); }
        catch (error) { log.warn(`API 账单写入失败: ${error.message}`); }
      }
    }
  }
  throw lastErr || new TikHubError('请求失败', -1, path);
}

export function tikhubRequest(path, options = {}) {
  // A cancellable task must own its request instead of aborting another caller's request.
  if (executionSignal()) return performRequest(path, options);
  const method = options.method || 'GET';
  const query = options.query || {};
  const body = options.body ?? null;
  const retries = options.retries ?? config.retry;
  const key = JSON.stringify([config.baseUrl, config.apiKey, method, path, stableValue(query), stableValue(body), retries]);
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  let tracked;
  tracked = performRequest(path, options).finally(() => {
    if (inFlightRequests.get(key) === tracked) inFlightRequests.delete(key);
  });
  inFlightRequests.set(key, tracked);
  return tracked;
}
