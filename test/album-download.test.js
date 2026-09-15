import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { buildTargetPath } from '../src/downloader.js';
import { Store } from '../src/store.js';
import { downloadVideos } from '../src/tasks.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function setup(t, saveMetadata = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-album-test-'));
  const original = { ...config };
  Object.assign(config, {
    outputDir: path.join(root, 'downloads'),
    logDir: path.join(root, 'logs'),
    errorDir: path.join(root, 'errors'),
    saveMetadata,
  });
  t.after(() => {
    Object.assign(config, original);
    if (!Object.hasOwn(original, 'saveMetadata')) delete config.saveMetadata;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  });
  const item = {
    aweme_id: '7685396004203476963',
    desc: 'album #title',
    images: [1, 2].map((i) => ({ url_list: [`https://cdn.example/image-${i}`] })),
  };
  const prepared = {
    type: 'like', label: 'likes', secUserId: 'test-user', userName: 'Neo', list: [item],
  };
  const store = new Store(path.join(root, 'downloaded.json'));
  const { file } = buildTargetPath(prepared.userName, prepared.label, item.aweme_id, item.desc);
  const albumDir = file.replace(/\.mp4$/, '');
  return { root, calls, store, albumDir, run: () => downloadVideos({ prepared, store }) };
}

for (const saveMetadata of [true, false]) {
  test(`downloads a new album with missing parents (metadata=${saveMetadata})`, async (t) => {
    const { root, calls, store, albumDir, run } = setup(t, saveMetadata);
    assert.equal(fs.existsSync(config.outputDir), false);
    const result = await run();
    assert.equal(result.failed, 0);
    assert.equal(result.downloaded, 1);
    assert.equal(result.files[0].count, 2);
    assert.equal(result.files[0].size, jpeg.length * 2);
    assert.equal(calls.length, 2);
    for (const index of ['01', '02']) {
      assert.deepEqual(fs.readFileSync(path.join(albumDir, `img_${index}.jpg`)), jpeg);
    }
    const metadataPath = path.join(albumDir, 'metadata.json');
    assert.equal(fs.existsSync(metadataPath), saveMetadata);
    if (saveMetadata) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      assert.equal(metadata.local.files.length, 2);
      assert.equal(metadata.local.total_size, jpeg.length * 2);
    }
    assert.equal(store.has('test-user', 'like', '7685396004203476963'), true);
    assert.equal(fs.existsSync(path.join(root, 'errors')), false);
  });
}

test('resumes an album, corrects existing image extensions and ignores partial files', async (t) => {
  const { calls, albumDir, run } = setup(t);
  fs.mkdirSync(albumDir, { recursive: true });
  fs.writeFileSync(path.join(albumDir, 'img_01.webp'), jpeg);
  fs.writeFileSync(path.join(albumDir, 'img_02.jpg.part'), 'incomplete');
  const result = await run();
  assert.equal(result.failed, 0);
  assert.equal(result.downloaded, 1);
  assert.deepEqual(calls, ['https://cdn.example/image-2']);
  assert.equal(fs.existsSync(path.join(albumDir, 'img_01.webp')), false);
  assert.deepEqual(fs.readFileSync(path.join(albumDir, 'img_01.jpg')), jpeg);
  assert.deepEqual(fs.readFileSync(path.join(albumDir, 'img_02.jpg')), jpeg);
});

test('reports directory errors other than ENOENT without marking the album downloaded', async (t) => {
  const { root, calls, store, albumDir, run } = setup(t);
  fs.mkdirSync(path.dirname(albumDir), { recursive: true });
  fs.writeFileSync(albumDir, 'not a directory');
  const result = await run();
  assert.equal(result.failed, 1);
  assert.equal(result.downloaded, 0);
  assert.equal(calls.length, 0);
  assert.equal(store.has('test-user', 'like', '7685396004203476963'), false);
  const reportDir = path.join(root, 'errors');
  const reports = fs.readdirSync(reportDir);
  assert.equal(reports.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(reportDir, reports[0]), 'utf8'));
  assert.equal(report.error.code, 'ENOTDIR');
});
