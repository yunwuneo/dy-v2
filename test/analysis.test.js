import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-analysis-test-'));
process.env.DOUYIN_CONFIG = path.join(root, 'config.json');
fs.writeFileSync(process.env.DOUYIN_CONFIG, JSON.stringify({ outputDir: path.join(root, 'downloads'), dataDir: path.join(root, 'data'), logDir: path.join(root, 'logs'), errorDir: path.join(root, 'errors'), pollerEnabled: false }));
const { config, validateField } = await import('../src/config.js');
const { AnalysisManager, normalizeResult } = await import('../src/analysis.js');
const { LibraryIndex } = await import('../src/library-index.js');
const { listLibrary } = await import('../src/library.js');
const { runVideoAnalysis } = await import('../src/analysis-runner.js');
const { saveSettings, publicSettings } = await import('../src/settings.js');
const { startServer } = await import('../src/server.js');
const { videoDownloaded } = await import('../src/download-events.js');
const result = { description: '在海边散步', keywords: ['海边', '散步'], tags: ['旅行'], transcript: '你好' };
let sequence = 0;
function fixture(runner) {
  const dir = path.join(root, String(++sequence));
  fs.mkdirSync(path.join(dir, 'User', '作品'), { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, 'User', '作品', `clip${i}.mp4`), 'video');
  fs.mkdirSync(path.join(dir, 'User', '作品', 'album'));
  fs.writeFileSync(path.join(dir, 'User', '作品', 'album', '1.jpg'), 'image');
  const library = new LibraryIndex({ root: dir, file: path.join(root, `index-${sequence}.json`) });
  const settings = { ...config };
  const manager = new AnalysisManager({ root: dir, file: path.join(root, `analysis-${sequence}.json`), library, settings, runner });
  library.analysisSummary = id => manager.summary(id);
  const items = listLibrary(dir).items.filter(i => i.kind === 'video');
  return { manager, library, settings, items, dir, close: async () => { await manager.close(); await library.close(); } };
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail('timed out');
}
after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

test('batch analyzes only videos, deduplicates, exposes progress and persists results', async () => {
  const f = fixture(async ({ report }) => { report({ stage: 'frames', completed: 1, total: 2 }); await delay(20); return result; });
  try {
    assert.deepEqual(await f.manager.enqueue({ all: true }), { added: 3, skipped: 0, enabled: false });
    assert.equal((await f.manager.enqueue({ all: true })).added, 0);
    f.manager.start();
    await until(() => f.manager.current?.record.stage === 'frames');
    assert.equal(f.manager.snapshot().items.find(i => i.status === 'running').progress.completed, 1);
    await until(() => f.manager.snapshot().counts.completed === 3);
    assert.equal((await f.manager.enqueue({ all: true })).added, 0);
    const restored = new AnalysisManager({ root: f.dir, file: f.manager.file, library: f.library });
    assert.equal(restored.get(f.items[0].id).result.transcript, '你好');
    assert.equal(restored.snapshot().items[0].result.transcript, undefined);
    await restored.close();
  } finally { await f.close(); }
});

test('stop interrupts current work, retains queue, resumes without overlapping workers, cancel skips work', async () => {
  let running = 0, max = 0;
  const f = fixture(async ({ signal }) => { running++; max = Math.max(max, running); try { await delay(80, null, { signal }); return result; } finally { running--; } });
  try {
    await f.manager.enqueue({ all: true }); f.manager.start();
    f.manager.stop(); f.manager.start(); // resume while prior process is still exiting
    await until(() => f.manager.snapshot().counts.completed === 3);
    assert.equal(max, 1);
    await f.manager.enqueue({ ids: [f.items[0].id], force: true });
    f.manager.cancel(f.items[0].id);
    await until(() => f.manager.get(f.items[0].id).status === 'cancelled');
    assert.equal(f.manager.get(f.items[0].id).result.description, result.description);
    await f.manager.enqueue({ ids: [f.items[1].id], force: true });
    f.manager.stop(); await until(() => !f.manager.current);
    assert.equal(f.manager.get(f.items[1].id).status, 'queued');
    await delay(90); assert.equal(f.manager.get(f.items[1].id).status, 'queued');
  } finally { await f.close(); }
});

test('restart restores interrupted tasks; invalid/empty outputs fail and retry preserves prior result', async () => {
  const f = fixture(async () => ({ description: 'invalid' }));
  try {
    await f.manager.enqueue({ ids: [f.items[0].id] });
    f.manager.get(f.items[0].id).status = 'running'; f.manager.save();
    const restored = new AnalysisManager({ root: f.dir, file: f.manager.file, library: f.library });
    assert.equal(restored.get(f.items[0].id).status, 'queued'); await restored.close();
    f.manager.get(f.items[0].id).status = 'queued'; f.manager.start();
    await until(() => f.manager.get(f.items[0].id).status === 'failed');
    assert.equal(f.manager.get(f.items[0].id).result, null);
    f.manager.runner = async () => result;
    await f.manager.enqueue({ ids: [f.items[0].id] });
    await until(() => f.manager.get(f.items[0].id).status === 'completed');
    f.manager.runner = async () => { throw new Error('provider failed'); };
    await f.manager.enqueue({ ids: [f.items[0].id], force: true });
    await until(() => f.manager.get(f.items[0].id).status === 'failed');
    assert.equal(f.manager.get(f.items[0].id).result.description, result.description);
    assert.throws(() => normalizeResult({ ...result, tags: [] }), /tags/);
  } finally { await f.close(); }
});

test('search ranks keywords/tags ahead of descriptions and titles before pagination', async () => {
  const f = fixture(async () => result);
  try {
    await f.manager.enqueue({ all: true });
    const [a, b, c] = f.items;
    f.manager.get(a.id).result = { ...result, description: '猫在院子里', keywords: ['院子'], tags: ['动物'] };
    f.manager.get(b.id).result = { ...result, description: '宠物活动', keywords: ['猫'], tags: ['动物'] };
    f.manager.get(c.id).result = { ...result, description: '家中', keywords: ['日常'], tags: ['生活'] };
    fs.writeFileSync(path.join(f.dir, Buffer.from(c.id, 'base64url').toString()).replace('.mp4', '.json'), JSON.stringify({ desc: '猫的日常' }));
    const first = await f.library.query({ search: '猫', limit: 1, refresh: true });
    assert.equal(first.total, 3); assert.equal(first.items[0].id, b.id);
    assert.equal((await f.library.query({ search: '猫', offset: 1, limit: 1 })).items[0].id, a.id);
    assert.equal((await f.library.query({ search: '猫', user: 'missing' })).total, 0);
    assert.equal((await f.library.query({ search: '动物' })).total, 2);
    assert.equal((await f.library.query({ search: 'nothing' })).total, 0);
  } finally { await f.close(); }
});

test('queue validates containment and albums before mutations, automatic enqueue obeys its own switch', async () => {
  const f = fixture(async () => result);
  try {
    await assert.rejects(f.manager.enqueue({ ids: [f.items[0].id, Buffer.from('../escape.mp4').toString('base64url')] }), /无效|越界/);
    assert.equal(f.manager.records.size, 0);
    const album = listLibrary(f.dir).items.find(i => i.kind === 'album');
    await assert.rejects(f.manager.enqueue({ ids: [album.id] }), /仅支持视频/);
    const file = path.join(f.dir, Buffer.from(f.items[0].id, 'base64url').toString());
    f.manager.downloaded(file); assert.equal(f.manager.records.size, 0);
    f.settings.analysisAuto = true;
    f.manager.downloaded(file); f.manager.downloaded(file);
    assert.equal(f.manager.records.size, 1); assert.equal(f.manager.enabled, false);
    f.manager.start(); await until(() => f.manager.snapshot().counts.completed === 1);
    await f.manager.remove(f.items[0].id); assert.equal(f.manager.records.size, 0);
  } finally { await f.close(); }
});

test('child-process protocol passes independent config, reports progress and handles exit/abort/timeout', async () => {
  const worker = `let input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => { const p=JSON.parse(input); console.log('DY_ANALYSIS:'+JSON.stringify({type:'progress',stage:'frames',completed:1,total:1})); console.log('DY_ANALYSIS:'+JSON.stringify({type:'result',result:{description:p.settings.analysisModel,keywords:['k'],tags:['t'],temp:p.workDir}})); });`;
  const events = [];
  const settings = { ...config, analysisModel: 'independent-model', analysisTimeoutSeconds: 3 };
  const output = await runVideoAnalysis({ target: 'sample.mp4', settings, signal: new AbortController().signal, report: e => events.push(e), executable: process.execPath, args: ['-e', worker] });
  assert.equal(output.description, 'independent-model'); assert.equal(events[0].completed, 1); assert.equal(fs.existsSync(output.temp), false);
  const controller = new AbortController();
  const pending = runVideoAnalysis({ target: 'x', settings, signal: controller.signal, report() {}, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  setTimeout(() => controller.abort(new Error('stopped')), 100);
  await assert.rejects(pending, /stopped/);
  await assert.rejects(runVideoAnalysis({ target: 'x', settings: { ...settings, analysisTimeoutSeconds: 0.1 }, signal: new AbortController().signal, report() {}, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }), /超时/);
  await assert.rejects(runVideoAnalysis({ target: 'x', settings, signal: new AbortController().signal, report() {}, executable: path.join(root, 'missing-python') }), /无法启动分析 Python/);
});

test('analysis settings validate URLs and keep independent secrets out of responses', () => {
  saveSettings({ analysisApiKey: 'test-analysis-secret', fields: { analysisModel: 'custom', analysisUrl: 'http://localhost:11434', analysisAuto: true } });
  assert.equal(config.analysisModel, 'custom'); assert.equal(publicSettings().analysisApiKeyConfigured, true);
  assert.ok(!JSON.stringify(publicSettings()).includes('test-analysis-secret'));
  saveSettings({ analysisApiKey: '' }); assert.equal(config.analysisApiKey, 'test-analysis-secret');
  saveSettings({ clearAnalysisApiKey: true }); assert.equal(config.analysisApiKey, '');
  for (const url of ['ftp://host', 'http://key:secret@host', 'https://host/?key=secret', 'bad']) assert.throws(() => validateField('analysisUrl', url));
  assert.throws(() => validateField('analysisMaxFrames', 201));
  assert.throws(() => validateField('analysisClient', 'invalid'));
});

test('transcription settings preserve defaults, validate cloud configuration atomically and redact separate keys', async () => {
  const { redact } = await import('../src/logger.js');
  assert.equal(config.analysisLanguage, 'auto');
  assert.equal(config.analysisAudioProvider, 'local');
  const before = fs.readFileSync(process.env.DOUYIN_CONFIG, 'utf8');
  assert.throws(() => saveSettings({ fields: { analysisAudioProvider: 'cloud' } }), /URL 和语音模型/);
  assert.equal(fs.readFileSync(process.env.DOUYIN_CONFIG, 'utf8'), before);
  for (const language of ['auto', 'zh', 'en', 'ja', 'yue']) assert.equal(validateField('analysisLanguage', language), language);
  for (const language of ['', 'zh-CN', 'unknown', null]) assert.throws(() => validateField('analysisLanguage', language));
  assert.throws(() => validateField('analysisAudioProvider', 'unknown'));
  for (const url of ['ftp://host', 'https://secret@host', 'https://host/?key=secret']) assert.throws(() => validateField('analysisAudioUrl', url));
  saveSettings({ analysisAudioApiKey: 'voice-test-secret', fields: { analysisAudioProvider: 'cloud', analysisAudioUrl: 'https://voice.example/v1', analysisAudioModel: 'voice-model', analysisLanguage: 'zh' } });
  assert.equal(config.analysisLanguage, 'zh');
  assert.equal(config.analysisAudioModel, 'voice-model');
  assert.equal(publicSettings().analysisAudioApiKeyConfigured, true);
  assert.ok(!JSON.stringify(publicSettings()).includes('voice-test-secret'));
  assert.equal(redact('voice-test-secret'), '[REDACTED]');
  saveSettings({ analysisAudioApiKey: '' }); assert.equal(config.analysisAudioApiKey, 'voice-test-secret');
  saveSettings({ analysisAudioApiKey: 'new-voice-secret' });
  assert.equal(redact('voice-test-secret new-voice-secret'), '[REDACTED] [REDACTED]');
  assert.throws(() => saveSettings({ clearAnalysisAudioApiKey: true, analysisAudioApiKey: 'conflict' }));
  saveSettings({ clearAnalysisAudioApiKey: true, fields: { analysisAudioProvider: 'local', analysisLanguage: 'auto' } });
  assert.equal(config.analysisAudioApiKey, '');
  const normalized = normalizeResult({ ...result, transcriptLanguage: 'zh', transcriptRequestedLanguage: 'auto', transcriptProvider: 'cloud', transcriptModel: 'voice-model' });
  assert.equal(normalized.transcriptLanguage, 'zh'); assert.equal(normalized.transcriptProvider, 'cloud');
});

test('HTTP analysis controls persist, consume download events, expose results and delete safely', async () => {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const file = path.join(config.outputDir, 'sample.mp4'); fs.writeFileSync(file, 'video');
  const id = Buffer.from('sample.mp4').toString('base64url');
  const library = new LibraryIndex();
  const manager = new AnalysisManager({ library, runner: async ({ signal }) => { await delay(25, null, { signal }); return result; } });
  const server = startServer(0, '127.0.0.1', { library, analysis: manager });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/analysis/queue', { ids: [id] })).status, 202);
    assert.equal((await post('/api/analysis/start')).status, 202);
    await until(() => manager.get(id).status === 'completed');
    assert.equal(config.analysisEnabled, true);
    const item = await fetch(base + `/api/library/item?id=${id}`).then(r => r.json());
    assert.equal(item.data.analysis.result.description, result.description);
    assert.equal((await fetch(base + '/api/library?search=旅行').then(r => r.json())).data.total, 1);
    assert.equal((await post('/api/analysis/stop')).status, 202); assert.equal(config.analysisEnabled, false);
    const second = path.join(config.outputDir, 'auto.mp4'); fs.writeFileSync(second, 'video'); videoDownloaded(second);
    assert.equal(manager.snapshot().counts.queued, 1);
    assert.equal((await post('/api/analysis/queue', { all: true, ids: [] })).status, 400);
    assert.equal((await post('/api/analysis/queue', null)).status, 400);
    await post('/api/analysis/queue', { ids: [id], force: true }); await post('/api/analysis/start');
    assert.equal((await fetch(base + `/api/library/item?id=${id}`, { method: 'DELETE' })).status, 200);
    assert.equal(manager.get(id), null); assert.equal(fs.existsSync(file), false);
    // A bad config must not prevent the emergency stop from killing running work.
    const valid = fs.readFileSync(process.env.DOUYIN_CONFIG, 'utf8'); fs.writeFileSync(process.env.DOUYIN_CONFIG, '{');
    await post('/api/analysis/stop'); assert.equal(manager.enabled, false);
    fs.writeFileSync(process.env.DOUYIN_CONFIG, valid);
    await post('/api/analysis/stop');
  } finally { await server.shutdown(); }
});
