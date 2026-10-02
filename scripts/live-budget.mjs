// Opt-in preload for this debugging session: node --import ./scripts/live-budget.mjs ...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT_DIR } from '../src/config.js';
import { atomicJson, withFileLock } from '../src/persistence.js';

const file = path.join(ROOT_DIR, 'logs', 'live-budget.json');
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.origin !== new URL(config.baseUrl).origin) return original(url, options);
  const id = crypto.randomUUID();
  withFileLock(file, () => {
    const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { attempts: 0, requests: [], runs: [] };
    if (ledger.attempts >= 60) throw new Error('本轮真实测试已达 60 次请求上限');
    ledger.attempts++;
    ledger.reservedUsd = Number((ledger.attempts * 0.01).toFixed(2));
    ledger.requests.push({ id, path: parsed.pathname, time: new Date().toISOString() });
    atomicJson(file, ledger);
  });
  const record = result => withFileLock(file, () => {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(ledger.requests.find(r => r.id === id), result);
    atomicJson(file, ledger);
  });
  try { const response = await original(url, options); record({ status: response.status }); return response; }
  catch (error) { record({ error: error.cause?.code || error.name }); throw error; }
};
