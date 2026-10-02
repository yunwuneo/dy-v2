import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startServer } from '../src/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { setTimeout as delay } from 'node:timers/promises';
import { executionSignal } from '../src/execution.js';

let server;
let baseUrl;
let root;
const oldConfig = { ...config };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-http-test-'));
  Object.assign(config, { outputDir: path.join(root, 'downloads'), dataDir: path.join(root, 'data'), logDir: path.join(root, 'logs'), errorDir: path.join(root, 'errors') });
  fs.mkdirSync(path.join(config.outputDir, 'User', '作品'), { recursive: true });
  fs.writeFileSync(path.join(config.outputDir, 'User', '作品', 'clip_1234567890123.mp4'), '0123456789');
  const jobs = new JobManager({ runner: async () => { await delay(200, undefined, { signal: executionSignal() }); return { existed: false }; } });
  server = startServer(0, '127.0.0.1', { jobs });
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server.shutdown();
  Object.assign(config, oldConfig);
  assert.equal(path.dirname(root), os.tmpdir());
  fs.rmSync(root, { recursive: true, force: true });
});

test('serves the Web UI and its assets', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /抖音下载器/);

  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('reports health and redacts sensitive configuration', async () => {
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');

  const response = await fetch(`${baseUrl}/api/config`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof body.data.configured, 'boolean');
  assert.equal(typeof body.data.cookieConfigured, 'boolean');
  assert.ok(!('apiKey' in body.data));
  assert.ok(!('cookie' in body.data));
  assert.ok(!('watchers' in body.data));
});

test('exposes the local media library summary', async () => {
  const response = await fetch(`${baseUrl}/api/library`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.items));
  assert.equal(typeof body.data.summary.total, 'number');
  assert.equal(typeof body.data.summary.bytes, 'number');
  assert.ok(Array.isArray(body.data.summary.users));
});

test('rejects invalid list limits before making an upstream request', async () => {
  const response = await fetch(`${baseUrl}/api/list?identifier=test&limit=0`);
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /limit/);
});

test('accepts collection requests without a user identifier', async () => {
  const response = await fetch(`${baseUrl}/api/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'collect', limit: 0 }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /limit/);
});

test('returns a local API bill without exposing credentials', async () => {
  const response = await fetch(`${baseUrl}/api/billing`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.endpoints));
  assert.equal(typeof body.data.totals.requests, 'number');
  if (config.apiKey) assert.ok(!JSON.stringify(body).includes(config.apiKey));
});

test('media range supports suffixes and rejects invalid ranges', async () => {
  const library = await fetch(`${baseUrl}/api/library`).then(r => r.json());
  const url = baseUrl + library.data.items[0].mediaUrl;
  const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206); assert.equal(await suffix.text(), '789');
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.headers.get('content-length'), '4'); assert.equal(await head.text(), '');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
});

test('job HTTP API returns immediately, exposes state, cancels and retries', async () => {
  const submit = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'single', url: '123' }) });
  assert.equal(submit.status, 202);
  const job = (await submit.json()).data;
  assert.equal((await fetch(`${baseUrl}/api/jobs/${job.id}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/jobs/${job.id}/cancel`, { method: 'POST' })).status, 200);
  await delay(25);
  const cancelled = (await fetch(`${baseUrl}/api/jobs/${job.id}`).then(r => r.json())).data;
  assert.equal(cancelled.status, 'cancelled');
  const retried = await fetch(`${baseUrl}/api/jobs/${job.id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 202);
  await delay(250);
  const overview = (await fetch(`${baseUrl}/api/console`).then(r => r.json())).data;
  assert.ok(overview.tasks.completed >= 1);
  assert.equal(typeof overview.api.requests, 'number');
  if (config.apiKey) assert.ok(!JSON.stringify(overview).includes(config.apiKey));
});

test('rejects fractional limits, stale lookups and cross-origin mutations', async () => {
  assert.equal((await fetch(`${baseUrl}/api/library?limit=1.2`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/library?offset=-1`)).status, 400);
  const stale = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'test', lookupId: 'expired' }) });
  assert.equal(stale.status, 409);
  const cross = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(cross.status, 403);
});
