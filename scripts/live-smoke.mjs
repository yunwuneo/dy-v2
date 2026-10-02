// Explicit opt-in only. Never included in `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { config, ROOT_DIR } from '../src/config.js';

if (!process.argv.includes('--confirm-paid')) throw new Error('Use --confirm-paid to authorize real API requests');
const dir = path.join(ROOT_DIR, 'logs');
fs.mkdirSync(dir, { recursive: true });
await import('./live-budget.mjs');
const ledgerFile = path.join(dir, 'live-budget.json');
const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
const reportFile = path.join(dir, 'live-results.json');
const save = () => fs.writeFileSync(reportFile, JSON.stringify(run, null, 2));
Object.assign(config, { count: 10, retry: 2, timeoutMs: 25000 });
const { lookupVideos, downloadVideos, downloadSingle } = await import('../src/tasks.js');
const { listLibrary, getLibraryMedia } = await import('../src/library.js');
const { awemeMeta } = await import('../src/douyin.js');
const run = { started: new Date().toISOString(), checks: [] };

async function check(name, fn) {
  try { const result = await fn(); run.checks.push({ name, ok: true, result }); console.log(JSON.stringify({ name, ok: true, result })); return result; }
  catch (error) { run.checks.push({ name, ok: false, error: error.message }); console.log(JSON.stringify({ name, ok: false, error: error.message })); }
  finally { save(); }
}
async function balance() {
  const response = await fetch(`${config.baseUrl}/api/v1/tikhub/user/get_user_info`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(25000) });
  const body = await response.json();
  assert.equal(response.status, 200);
  const data = body.user_data || body.data?.user_data || body.data || {};
  return { balance: data.balance, freeCredit: data.free_credit };
}
await check('balance-before', balance);
const batches = process.argv.includes('--reuse') ? JSON.parse(fs.readFileSync(path.join(dir, 'live-fixtures.json'))) : [];
for (const [index, watcher] of (process.argv.includes('--reuse') ? [] : config.watchers).entries()) {
  await check(`lookup-${index + 1}-${watcher.types[0]}`, async () => {
    const lookup = await lookupVideos({ identifier: watcher.identifier, type: watcher.types[0], limit: 10, cookie: watcher.cookie || '' });
    batches.push(lookup.prepared);
    return { count: lookup.videos.length, nickname: lookup.user?.nickname, albums: lookup.videos.filter(v => v.is_image_post).length };
  });
}
fs.writeFileSync(path.join(dir, 'live-fixtures.json'), JSON.stringify(batches));
const selected = [];
for (const kind of ['album', 'video']) {
  for (const batch of [...batches].reverse()) {
    const item = [...batch.list].sort((a,b)=>(a.video?.duration || 0)-(b.video?.duration || 0)).find(item => { const m = awemeMeta(item); return kind === 'album' ? m.isImagePost && m.imageUrls.length <= 15 : !m.isImagePost; });
    if (!item) continue;
    const prepared = { ...batch, list: [item] };

    const downloaded = await check(`download-${kind}`, async () => { const r = await downloadVideos({ prepared }); assert.equal(r.failed, 0); assert.equal(r.downloaded + r.skipped + r.metadata_backfilled, 1); return r; });
    if (!downloaded) break;
    selected.push({ kind, id: awemeMeta(item).awemeId });
    await check(`dedup-${kind}`, async () => { const before = ledger().attempts; const r = await downloadVideos({ prepared }); assert.equal(r.downloaded, 0); assert.equal(ledger().attempts, before); return { skipped: r.skipped, extraApiCalls: ledger().attempts - before }; });
    break;
  }
}
const video = selected.find(s => s.kind === 'video');
if (video) await check('single-video', async () => { const r = await downloadSingle(video.id); assert.ok(r.size > 0); return { kind: r.kind, size: r.size, existed: r.existed }; });
await check('library', async () => { const r = listLibrary(); for (const item of r.items) assert.ok(fs.statSync(getLibraryMedia(item.id)).size > 0); return r.summary; });
if (!config.cookie) run.checks.push({ name: 'collection-live', skipped: true, reason: 'No Douyin cookie configured' });
await check('balance-after', balance);
run.finished = new Date().toISOString();
save();
console.log(JSON.stringify({ attempts: ledger().attempts, reservedUsd: ledger().reservedUsd, passed: run.checks.filter(c => c.ok).length, failed: run.checks.filter(c => c.ok === false).length }));
if (run.checks.some(check => check.ok === false)) process.exitCode = 1;
