import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { config, loadEnv } from '../src/config.js';
import { Store } from '../src/store.js';
import { JobManager } from '../src/jobs.js';
import { LibraryIndex } from '../src/library-index.js';
import { downloadVideos, downloadVideoWithFallback } from '../src/tasks.js';
import { executionSignal, runWithExecution } from '../src/execution.js';
import { redact } from '../src/logger.js';
import { sanitize, buildTargetPath, downloadToFile } from '../src/downloader.js';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-runtime-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(10); }
}
function configure(t, root) {
  const old = { ...config };
  Object.assign(config, { outputDir: path.join(root, 'downloads'), dataDir: path.join(root, 'data'), logDir: path.join(root, 'logs'), errorDir: path.join(root, 'errors'), retry: 2 });
  t.after(() => Object.assign(config, old));
}

test('.env loading preserves shell values and parses quoted values without evaluation', t => {
  const root = temp(t), file = path.join(root, '.env');
  fs.writeFileSync(file, '\uFEFFEXISTING=file\nexport KEY="a#b"\nSIMPLE=value # comment\nLITERAL=$(echo secret)\n');
  const env = { EXISTING: 'shell' };
  loadEnv(file, env);
  assert.deepEqual(env, { EXISTING: 'shell', KEY: 'a#b', SIMPLE: 'value', LITERAL: '$(echo secret)' });
  assert.equal(redact({ cookie: 'private', nested: { authorization: 'secret' } }).nested.authorization, '[REDACTED]');
});

test('store merges independent instances and processes, recovers partial appends and compacts', async t => {
  const root = temp(t), file = path.join(root, 'downloaded.json');
  fs.writeFileSync(file, JSON.stringify({ old: { post: { legacy: 1 } } }));
  const first = new Store(file), second = new Store(file);
  first.mark('a', 'post', 'one'); second.mark('b', 'like', 'two');
  assert.ok(first.has('b', 'like', 'two'));
  const module = new URL('../src/store.js', import.meta.url).href;
  await Promise.all([0, 1, 2].map(index => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {Store} from ${JSON.stringify(module)}; const s=new Store(process.argv[1]); for(let i=0;i<30;i++) s.mark(process.argv[2],'post',String(i));`, file, `worker${index}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.ok(first.has('worker2', 'post', '29'));
  fs.appendFileSync(`${file}.jsonl`, '{"interrupted":');
  second.mark('new', 'post', 'recovered');
  first.compact();
  const recovered = new Store(file);
  assert.ok(recovered.has('new', 'post', 'recovered'));
  assert.ok(recovered.has('old', 'post', 'legacy'));
  assert.equal(Object.keys(recovered.data.worker0.post).length, 30);
  second.removeAweme('one');
  assert.equal(first.has('a', 'post', 'one'), false);
});

test('corrupt legacy records fail visibly instead of discarding download history', t => {
  const file = path.join(temp(t), 'downloaded.json');
  fs.writeFileSync(file, 'broken');
  assert.throws(() => new Store(file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});

test('Windows filenames remain usable and user-supplied IDs cannot escape the output directory', () => {
  assert.equal(sanitize('..'), 'untitled');
  assert.equal(sanitize('CON.txt'), '_CON.txt');
  const target = buildTargetPath('..', '作品', '../../escape', 'title');
  assert.ok(target.file.startsWith(config.outputDir + path.sep));
});

test('media download retries an interrupted response body and publishes only a complete file', async t => {
  const root = temp(t); configure(t, root);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }))
    : new Response('complete-media'));
  const target = path.join(root, 'movie.mp4');
  await downloadToFile('https://media.invalid/movie', target);
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete-media');
  assert.equal(fs.existsSync(target + '.part'), false);
});

test('media transfer uses an idle timeout and resumes a saved partial across runs', async t => {
  const root = temp(t); configure(t, root);
  config.retry = 1;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++;
    if (requests === 1) {
      assert.equal(options.headers.Range, undefined);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('abc'));
          setTimeout(() => controller.error(new Error('connection lost')), 15);
        },
      }), { headers: { 'content-length': '6' } });
    }
    assert.equal(options.headers.Range, 'bytes=3-');
    return new Response(new ReadableStream({
      async start(controller) {
        for (const byte of ['d', 'e', 'f']) {
          await delay(20);
          controller.enqueue(Buffer.from(byte));
        }
        controller.close();
      },
    }), { status: 206, headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' } });
  });
  const file = path.join(root, 'resume.mp4');
  await assert.rejects(downloadToFile('https://media.invalid/video', file, { timeoutMs: 40 }), /connection lost/);
  assert.equal(fs.readFileSync(file + '.part', 'utf8'), 'abc');
  await downloadToFile('https://media.invalid/video', file, { timeoutMs: 40 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  assert.equal(fs.existsSync(file + '.part'), false);
});

test('a media response that never sends its first byte times out', async t => {
  const root = temp(t); configure(t, root); config.retry = 1;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start() {} })));
  const target = path.join(root, 'stalled.mp4');
  await assert.rejects(downloadToFile('https://media.invalid/stalled', target, { timeoutMs: 35 }), /abort|timeout|超时|无数据/i);
  assert.equal(fs.existsSync(target), false);
});

test('media timeout completes even if the HTTP client ignores abort', async t => {
  const root = temp(t); configure(t, root); config.retry = 1;
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  await assert.rejects(downloadToFile('https://media.invalid/hung', path.join(root, 'hung.mp4'), { timeoutMs: 35 }), /无数据/);
});

test('ignored range restarts cleanly and unavailable original uses a backup URL', async t => {
  const root = temp(t); configure(t, root);
  config.retry = 1;
  const file = path.join(root, 'backup.mp4');
  fs.writeFileSync(file + '.part', 'old');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    if (url.includes('original')) {
      assert.equal(options.headers.Range, 'bytes=3-');
      return new Response('denied', { status: 403 });
    }
    return new Response('new-file', { headers: { 'content-length': '8' } });
  });
  const result = await downloadVideoWithFallback({ original_video_url: 'https://media.invalid/original', video_url: 'https://media.invalid/backup' }, {}, file, 'test');
  assert.equal(result.fallback, true);
  assert.equal(requests, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new-file');
  assert.equal(fs.existsSync(file + '.part'), false);

  const other = path.join(root, 'range-ignored.mp4');
  fs.writeFileSync(other + '.part', 'old');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=3-');
    return new Response('complete', { headers: { 'content-length': '8' } });
  });
  await downloadToFile('https://media.invalid/ignored', other);
  assert.equal(fs.readFileSync(other, 'utf8'), 'complete');
});

test('video fallback rotates through distinct embedded CDN hosts', async t => {
  const root = temp(t); configure(t, root);
  const attempted = [];
  t.mock.method(globalThis, 'fetch', async url => {
    attempted.push(new URL(url).host);
    return new URL(url).host === 'usable.invalid'
      ? new Response('backup-media')
      : new Response('unavailable', { status: 403 });
  });
  const item = { video: { play_addr: { url_list: [
    'https://bad.invalid/a', 'https://bad.invalid/b', 'https://usable.invalid/c',
  ] } } };
  const target = path.join(root, 'fallback.mp4');
  const result = await downloadVideoWithFallback({ original_video_url: 'https://original.invalid/o' }, item, target, 'test');
  assert.equal(result.fallback, true);
  assert.deepEqual(attempted, ['original.invalid', 'bad.invalid', 'usable.invalid']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'backup-media');
});

test('batch downloads obey concurrency, report progress and skip duplicate work', async t => {
  const root = temp(t); configure(t, root);
  let active = 0, peak = 0, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++; active++; peak = Math.max(peak, active);
    await delay(25); active--;
    return new Response(Buffer.from([255, 216, 255, 224]));
  });
  const items = Array.from({ length: 7 }, (_, i) => ({ aweme_id: String(i), desc: `album${i}`, images: [{ url_list: ['https://media.invalid/a.jpg'] }] }));
  const prepared = { type: 'post', label: '作品', secUserId: 'user', userName: 'User', list: [...items, items[0]] };
  const progress = [];
  const r = await downloadVideos({ prepared, concurrency: 3, onProgress: p => progress.push(p.completed) });
  assert.equal(peak, 3); assert.equal(requests, 7);
  assert.equal(r.downloaded, 7); assert.equal(r.skipped, 1); assert.equal(r.completed, 8);
  assert.equal(progress.at(-1), 8);
  const again = await downloadVideos({ prepared });
  assert.equal(again.skipped, 8); assert.equal(requests, 7);
});

test('cancel aborts an in-flight media stream without marking it downloaded', async t => {
  const root = temp(t); configure(t, root);
  const controller = new AbortController();
  let streamCancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([255, 216, 255, 224])); },
    cancel() { streamCancelled = true; },
  })));
  const prepared = { type: 'post', label: '作品', secUserId: 'user', userName: 'User', list: [{ aweme_id: 'cancel', desc: 'cancel', images: [{ url_list: ['https://media.invalid/a.jpg'] }] }] };
  const promise = runWithExecution({ signal: controller.signal }, () => downloadVideos({ prepared }));
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(promise, /abort/i);
  assert.ok(streamCancelled);
  assert.equal(new Store().has('user', 'post', 'cancel'), false);
  const dir = path.join(config.outputDir, 'User', '作品', 'cancel_cancel');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('job queue persists history, cancels queued/running jobs, retries and recovers restart', async t => {
  const root = temp(t); configure(t, root);
  const file = path.join(root, 'jobs.json');
  let calls = 0;
  const manager = new JobManager({ file, concurrency: 1, runner: async () => {
    calls++;
    await delay(calls === 1 ? 2000 : 20, undefined, { signal: executionSignal() });
    return { existed: false };
  } });
  const first = manager.submit('single', { url: 'one', cookie: 'must-not-persist' });
  const queued = manager.submit('single', { url: 'two' });
  manager.cancel(queued.id);
  await until(() => manager.get(first.id).status === 'running');
  manager.cancel(first.id);
  await until(() => manager.get(first.id).status === 'cancelled');
  assert.equal(calls, 1);
  const retried = manager.retry(first.id);
  await until(() => manager.get(retried.id).status === 'completed');
  await manager.close();
  assert.ok(!fs.readFileSync(file, 'utf8').includes('must-not-persist'));
  const history = JSON.parse(fs.readFileSync(file, 'utf8'));
  history.push({ id: 'interrupted', status: 'running', progress: {} });
  fs.writeFileSync(file, JSON.stringify(history));
  const restarted = new JobManager({ file });
  assert.equal(restarted.get('interrupted').status, 'interrupted');
  assert.equal(restarted.get(retried.id).status, 'completed');
  assert.throws(() => restarted.retry(first.id), /重新查询/);
  await restarted.close();
});

test('failed batch jobs keep non-secret retry inputs across restarts, including older sec_user_id jobs', async t => {
  const root = temp(t), file = path.join(root, 'jobs.json');
  const first = new JobManager({ file, runner: async () => { throw new Error('transient'); } });
  const submitted = first.submit('batch', { identifier: 'MS4wLjABexampleuser', type: 'post', limit: 10, cookie: '' });
  await until(() => first.get(submitted.id).status === 'failed');
  await first.close();
  const persisted = fs.readFileSync(file, 'utf8');
  assert.ok(persisted.includes('MS4wLjABexampleuser'));
  assert.ok(!persisted.includes('secret-cookie'));
  const history = JSON.parse(persisted);
  history.push({ id: 'legacy', kind: 'batch', label: 'MS4wLjABlegacyuser · post', status: 'partial', progress: { total: 10 } });
  fs.writeFileSync(file, JSON.stringify(history));
  const seen = [];
  const restarted = new JobManager({ file, runner: async (_kind, options) => { seen.push(options.identifier); return { failed: 0 }; } });
  assert.equal(restarted.get(submitted.id).canRetry, true);
  assert.equal(restarted.get('legacy').canRetry, true);
  const retried = restarted.retry('legacy');
  await until(() => restarted.get(retried.id).status === 'completed');
  assert.deepEqual(seen, ['MS4wLjABlegacyuser']);
  await restarted.close();
});

test('large library scans off-thread, paginates, filters, caches and indexes albums without metadata', async t => {
  const root = temp(t), mediaRoot = path.join(root, 'media');
  const user = path.join(mediaRoot, 'User', '作品'); fs.mkdirSync(user, { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(user, `video_${String(1000000000000 + i)}.mp4`), 'media');
  const album = path.join(user, 'album_2000000000000'); fs.mkdirSync(album);
  fs.writeFileSync(path.join(album, 'img_01.jpg'), Buffer.from([255, 216, 255, 224]));
  const index = new LibraryIndex({ root: mediaRoot, file: path.join(root, 'index.json'), ttlMs: 60000 });
  t.after(() => index.close());
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const start = performance.now();
  const first = await index.query({ limit: 24 }); clearInterval(timer);
  const scanMs = Math.round(performance.now() - start);
  assert.ok(ticks > 0);
  assert.equal(first.total, 10001); assert.equal(first.items.length, 24); assert.ok(first.hasMore);
  const cachedStart = performance.now();
  const second = await index.query({ offset: 24, limit: 24 });
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 48);
  const albums = await index.query({ kind: 'album', search: 'album' });
  assert.equal(albums.total, 1); assert.equal(albums.items[0].media, undefined);
  assert.equal(index.scanCount, 1);
  console.log(JSON.stringify({ benchmark: '10001-media-library', scanMs, cachedQueriesMs: Number((performance.now() - cachedStart).toFixed(2)), eventLoopTicks: ticks, pageBytes: Buffer.byteLength(JSON.stringify(first)) }));
  fs.writeFileSync(path.join(user, 'new_3000000000000.mp4'), 'new');
  index.invalidate(); assert.equal((await index.query()).total, 10002);
});
