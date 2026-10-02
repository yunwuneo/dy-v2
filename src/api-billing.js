import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicJson, withFileLock } from './persistence.js';

// Reference prices in USD. TikHub applies account-wide daily tiers and may
// change endpoint prices, so these figures are estimates rather than charges.
const REFERENCE_PRICES = {
  '/api/v1/douyin/web/fetch_video_high_quality_play_url': 0.005,
};
const DEFAULT_DOUYIN_PRICE = 0.001;
const BILLING_FILE = 'api-billing.json';

function file() { return path.join(config.dataDir, BILLING_FILE); }
function empty() { return { version: 1, endpoints: {} }; }
function read(filePath) {
  if (!fs.existsSync(filePath)) return empty();
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (data.version !== 1 || !data.endpoints || typeof data.endpoints !== 'object') throw new Error('API 账单格式无效');
  return data;
}
function mutate(fn) {
  const filePath = file();
  return withFileLock(filePath, () => {
    const data = read(filePath);
    fn(data);
    atomicJson(filePath, data);
  });
}
function priceFor(endpoint) {
  if (Object.hasOwn(REFERENCE_PRICES, endpoint)) return REFERENCE_PRICES[endpoint];
  if (endpoint.startsWith('/api/v1/douyin/')) return DEFAULT_DOUYIN_PRICE;
  return null;
}

export function billingSnapshot() {
  const data = read(file());
  const endpoints = Object.entries(data.endpoints).map(([endpoint, row]) => ({
    endpoint,
    requests: row.requests || 0,
    succeeded: row.succeeded || 0,
    failed: row.failed || 0,
    pending: row.pending || 0,
    estimatedCostUsd: row.estimatedCostUsd || 0,
    unpriced: row.unpriced || 0,
    referencePriceUsd: priceFor(endpoint),
  })).sort((a, b) => b.requests - a.requests || a.endpoint.localeCompare(b.endpoint));
  return {
    endpoints,
    totals: endpoints.reduce((total, row) => {
      for (const key of ['requests', 'succeeded', 'failed', 'pending', 'estimatedCostUsd', 'unpriced']) total[key] += row[key];
      return total;
    }, { requests: 0, succeeded: 0, failed: 0, pending: 0, estimatedCostUsd: 0, unpriced: 0 }),
  };
}

export function recordApiStart(endpoint) {
  mutate(data => {
    const row = data.endpoints[endpoint] ||= { requests: 0, succeeded: 0, failed: 0, pending: 0, estimatedCostUsd: 0, unpriced: 0 };
    row.requests++;
    row.pending++;
  });
}

export function recordApiFinish(endpoint, succeeded) {
  mutate(data => {
    const row = data.endpoints[endpoint];
    if (!row) return;
    row.pending = Math.max(0, row.pending - 1);
    row[succeeded ? 'succeeded' : 'failed']++;
    if (succeeded) {
      const price = priceFor(endpoint);
      if (price === null) row.unpriced++;
      else row.estimatedCostUsd = Math.round((row.estimatedCostUsd + price) * 1e6) / 1e6;
    }
  });
}
