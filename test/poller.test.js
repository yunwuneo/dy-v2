import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-poller-test-'));
process.env.DOUYIN_CONFIG = path.join(root, 'config.json');
process.env.TIKHUB_API_KEY = '';
fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify({ apiKey: 'test-key', watchers: [] }));
const { config, reloadConfig } = await import('../src/config.js');
const { saveSettings, saveWatchers, publicSettings } = await import('../src/settings.js');
const { JobManager } = await import('../src/jobs.js');
const { PollingManager } = await import('../src/web-poller.js');
const { executionSignal } = await import('../src/execution.js');
const { startServer } = await import('../src/server.js');
const { acquireFileLock } = await import('../src/persistence.js');
after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });

async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await delay(5); }
  throw new Error('timed out');
}
class FakeClock {
  constructor() { this.time = 1790884800000; this.timers = new Map(); this.id = 0; }
  now = () => this.time;
  setTimeout = (fn, ms) => { const id = ++this.id; this.timers.set(id, { fn, due: this.time + ms }); return id; };
  clearTimeout = id => this.timers.delete(id);
  advance(ms) {
    this.time += ms;
    for (const [id, task] of [...this.timers]) if (task.due <= this.time) { this.timers.delete(id); task.fn(); }
  }
}
function setup(t, runner, { concurrency = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  Object.assign(config, { dataDir: path.join(dir, 'data'), outputDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs'), errorDir: path.join(dir, 'errors') });
  fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify({
    dataDir: config.dataDir, outputDir: config.outputDir, logDir: config.logDir, errorDir: config.errorDir,
    apiKey: 'test-key', taskConcurrency: concurrency, pollerEnabled: false, pollIntervalSeconds: 300,
    watchers: [{ id: 'one', identifier: 'user-one', name: 'One', types: ['post'], limit: 20, cookie: 'private-cookie' },
      { id: 'two', identifier: 'user-two', name: 'Two', types: ['post'], limit: 20 }],
  }));
  reloadConfig();
  const jobs = new JobManager({ runner, concurrency });
  const clock = new FakeClock();
  const poller = new PollingManager({ jobs, clock });
  t.after(async () => { await poller.close(); await jobs.close(); });
  return { jobs, poller, clock, dir };
}
const success = (_kind, _options, report) => {
  const result = { total: 3, completed: 3, downloaded: 1, skipped: 2, failed: 0 };
  report(result); return result;
};

test('manual checks expose live progress, reject overlap, record history and leave automation stopped', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { poller, jobs } = setup(t, async (_kind, _input, report) => {
    report({ total: 3, completed: 1, downloaded: 1, active: 1 });
    await gate; return success(_kind, _input, report);
  });
  poller.runOnce('one');
  await until(() => poller.snapshot().progress.completed === 1);
  assert.equal(poller.snapshot().status, 'running');
  assert.equal(poller.snapshot().watchers[0].status, 'running');
  assert.throws(() => poller.runOnce(), /尚未结束/);
  release(); await poller.pending;
  const state = poller.snapshot();
  assert.equal(state.status, 'stopped'); assert.equal(state.nextRunAt, null);
  assert.equal(state.progress.downloaded, 1); assert.equal(state.lastRun.completedTargets, 1);
  assert.ok(state.watchers[0].lastStartedAt); assert.ok(state.watchers[0].lastFinishedAt);
  assert.equal(jobs.list().items[0].source, 'poller');
  assert.ok(!fs.readFileSync(poller.file, 'utf8').includes('private-cookie'));
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'poller.lock')));
});

test('hot changes reschedule the timer and subsequent checks use latest target settings', async t => {
  const seen = [];
  const { poller, clock } = setup(t, (kind, options, report) => { seen.push({ ...options }); return success(kind, options, report); });
  poller.enable(); clock.advance(0); await poller.pending;
  assert.equal(seen.length, 2);
  assert.equal(Date.parse(poller.snapshot().nextRunAt), clock.now() + 300000);
  saveSettings({ fields: { pollIntervalSeconds: 10 } }); poller.configure();
  assert.equal(Date.parse(poller.snapshot().nextRunAt), clock.now() + 10000);
  saveWatchers(publicSettings().watchers.map(w => ({ ...w, limit: 999, enabled: w.id === 'one', types: ['like'] })));
  poller.configure(); clock.advance(9999); assert.equal(seen.length, 2);
  clock.advance(1); await poller.pending;
  assert.equal(seen.length, 3); assert.equal(seen[2].limit, 999); assert.equal(seen[2].type, 'like');
  assert.equal(seen[2].cookie, 'private-cookie');
  saveWatchers(publicSettings().watchers.map(w => ({ ...w, enabled: false }))); poller.configure();
  assert.equal(poller.snapshot().nextRunAt, null);
  poller.stop(); clock.advance(600000); assert.equal(seen.length, 3);
});

test('stop cancels owned jobs, preserves ordinary downloads and prevents remaining targets', async t => {
  const seen = [];
  const { poller, jobs } = setup(t, async (_kind, input, report) => {
    seen.push(input.identifier || input.url);
    report({ total: 5, completed: 1, downloaded: 1 });
    await delay(input.url ? 80 : 10000, undefined, { signal: executionSignal() });
    return input.url ? { existed: false } : { failed: 0 };
  }, { concurrency: 2 });
  const ordinary = jobs.submit('single', { url: 'ordinary' });
  poller.runOnce(); await until(() => poller.snapshot().watchers[0].status === 'running');
  poller.disable(); await poller.pending;
  assert.equal(poller.snapshot().lastRun.status, 'cancelled');
  assert.equal(poller.snapshot().watchers[0].status, 'cancelled');
  assert.ok(!seen.includes('user-two'));
  assert.equal((await jobs.waitFor(ordinary.id)).status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(process.env.DOUYIN_CONFIG)).pollerEnabled, false);
});

test('pausing a running target cancels it and the cycle continues with other targets', async t => {
  const seen = [];
  const { poller, clock } = setup(t, async (kind, input, report) => {
    seen.push(input.identifier);
    if (input.identifier === 'user-one') await delay(10000, undefined, { signal: executionSignal() });
    return success(kind, input, report);
  });
  poller.enable(); clock.advance(0);
  await until(() => poller.snapshot().watchers[0].status === 'running');
  saveWatchers(publicSettings().watchers.map(w => ({ ...w, enabled: w.id !== 'one' }))); poller.configure();
  await poller.pending;
  assert.deepEqual(seen, ['user-one', 'user-two']);
  assert.equal(poller.snapshot().watchers[0].status, 'paused');
  assert.equal(poller.snapshot().watchers[1].status, 'completed');
  assert.ok(poller.snapshot().nextRunAt);
});

test('persisted enabled state and last completion schedule survive service restart', async t => {
  const { poller, clock, jobs } = setup(t, success);
  poller.enable(); clock.advance(0); await poller.pending;
  const previousNext = poller.snapshot().nextRunAt;
  await poller.close();
  assert.equal(config.pollerEnabled, true);
  const recovered = new PollingManager({ jobs, clock }); t.after(() => recovered.close());
  recovered.configure({ resume: true });
  assert.equal(recovered.snapshot().nextRunAt, previousNext);
  assert.equal(recovered.snapshot().watchers[0].progress.downloaded, 1);
  assert.equal(recovered.snapshot().lastRun.status, 'completed');
});

test('a conflicting CLI or Web listener cannot start a second paid check', async t => {
  const { poller, jobs } = setup(t, success);
  const release = acquireFileLock(path.join(config.dataDir, 'poller'));
  try { assert.throws(() => poller.runOnce(), /另一个监听/); assert.equal(jobs.list().total, 0); }
  finally { release(); }
});

test('stop still cancels a running check when an invalid config prevents saving enabled state', async t => {
  const { poller } = setup(t, async () => { await delay(10000, undefined, { signal: executionSignal() }); return { failed: 0 }; });
  poller.runOnce(); await until(() => poller.snapshot().watchers[0].status === 'running');
  fs.writeFileSync(process.env.DOUYIN_CONFIG, '{');
  assert.throws(() => poller.disable(), /监听已停止.*保存失败/);
  await poller.pending;
  assert.equal(poller.snapshot().status, 'stopped');
  assert.equal(poller.snapshot().lastRun.status, 'cancelled');
  assert.equal(poller.snapshot().nextRunAt, null);
});

test('changing queue concurrency takes effect under load without interrupting active jobs', async t => {
  const gates = [];
  const { jobs } = setup(t, () => new Promise(resolve => gates.push(() => resolve({ existed: false }))));
  const a = jobs.submit('single', { url: 'a' });
  const b = jobs.submit('single', { url: 'b' });
  const c = jobs.submit('single', { url: 'c' });
  await until(() => gates.length === 1);
  jobs.setConcurrency(2); await until(() => gates.length === 2);
  jobs.setConcurrency(1);
  assert.equal(jobs.get(a.id).status, 'running'); assert.equal(jobs.get(b.id).status, 'running');
  gates[0](); await jobs.waitFor(a.id);
  assert.equal(jobs.get(c.id).status, 'queued');
  gates[1](); await until(() => gates.length === 3);
  gates[2](); assert.equal((await jobs.waitFor(c.id)).status, 'completed');
});

test('Web APIs control polling, hot-reload queue/cache settings and keep directory changes pending', async t => {
  const { jobs } = setup(t, async (kind, options, report) => { await delay(70, undefined, { signal: executionSignal() }); return success(kind, options, report); });
  const server = startServer(0, '127.0.0.1', { jobs });
  t.after(() => server.shutdown());
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, method = 'GET', body) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, ...(await res.json()) };
  };
  assert.equal((await call('/api/poller')).data.status, 'stopped');
  assert.equal((await call('/api/poller/start', 'POST')).status, 202);
  await until(() => server.services.poller.current);
  assert.equal((await call('/api/poller/run', 'POST')).status, 409);
  await until(() => server.services.poller.lastRun?.status === 'completed');
  const beforeDir = config.outputDir;
  const settings = await call('/api/settings', 'PUT', { fields: { pollIntervalSeconds: 20, taskConcurrency: 2, libraryCacheSeconds: 12, outputDir: path.join(root, 'pending-media') } });
  assert.equal(settings.status, 200); assert.deepEqual(settings.data.restartFields, ['outputDir']);
  assert.equal(config.outputDir, beforeDir); assert.equal(jobs.concurrency, 2); assert.equal(server.services.library.ttlMs, 12000);
  const state = (await call('/api/poller')).data;
  assert.equal(Date.parse(state.nextRunAt) - Date.parse(state.lastFinishedAt), 20000);
  assert.equal((await call('/api/poller/stop', 'POST')).status, 202);
  assert.equal((await call('/api/watchers/0/run', 'POST')).status, 202);
  await until(() => !server.services.poller.current);
  assert.equal((await call('/api/poller')).data.enabled, false);
  assert.ok(!JSON.stringify((await call('/api/console')).data).includes('private-cookie'));
  // External atomic config edits are detected without a restart.
  const saved = JSON.parse(fs.readFileSync(process.env.DOUYIN_CONFIG)); saved.taskConcurrency = 3;
  fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify(saved));
  await until(() => jobs.concurrency === 3);
});
