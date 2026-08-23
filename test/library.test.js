import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { deleteLibraryItem, getLibraryMedia, libraryInternals, listLibrary } from '../src/library.js';
import { Store } from '../src/store.js';

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-library-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('scans videos and albums while reporting orphan metadata', () => {
  const root = tempDir();
  const typeDir = path.join(root, '测试用户', '作品');
  const albumDir = path.join(typeDir, '图集_1234567890123');
  fs.mkdirSync(albumDir, { recursive: true });
  fs.writeFileSync(path.join(typeDir, '视频_9876543210987.mp4'), 'video');
  fs.writeFileSync(path.join(typeDir, '视频_9876543210987.json'), JSON.stringify({
    aweme_id: '9876543210987',
    desc: '测试视频',
    local: { downloaded_at: '2026-08-22T10:00:00.000Z' },
  }));
  fs.writeFileSync(path.join(albumDir, 'img_01.jpg'), 'image-one');
  fs.writeFileSync(path.join(albumDir, 'img_02.png'), 'image-two');
  fs.writeFileSync(path.join(albumDir, 'metadata.json'), JSON.stringify({ aweme_id: '1234567890123', desc: '测试图集' }));
  fs.writeFileSync(path.join(typeDir, '孤立_1111111111111.json'), '{}');

  const library = listLibrary(root);
  assert.equal(library.summary.total, 2);
  assert.equal(library.summary.videos, 1);
  assert.equal(library.summary.albums, 1);
  assert.equal(library.summary.orphanMetadata, 1);
  assert.deepEqual(library.summary.users, ['测试用户']);
  assert.equal(library.items.find((item) => item.kind === 'album').fileCount, 2);
});

test('resolves media and deletes only the selected item', () => {
  const root = tempDir();
  const typeDir = path.join(root, '用户', '点赞');
  fs.mkdirSync(typeDir, { recursive: true });
  const video = path.join(typeDir, '待删_9876543210987.mp4');
  const metadata = video.replace(/\.mp4$/, '.json');
  fs.writeFileSync(video, 'video-content');
  fs.writeFileSync(metadata, JSON.stringify({ aweme_id: '9876543210987' }));

  const item = listLibrary(root).items[0];
  assert.equal(getLibraryMedia(item.id, 0, root), video);
  assert.throws(() => getLibraryMedia(libraryInternals.encodeId('../outside.mp4'), 0, root), /无效|越界/);

  const deleted = deleteLibraryItem(item.id, root);
  assert.equal(deleted.awemeId, '9876543210987');
  assert.equal(fs.existsSync(video), false);
  assert.equal(fs.existsSync(metadata), false);
});

test('removes an aweme id from all download records', () => {
  const root = tempDir();
  const file = path.join(root, 'downloaded.json');
  fs.writeFileSync(file, JSON.stringify({
    userA: { post: { target: 1, keep: 2 } },
    userB: { like: { target: 3 } },
  }));
  const store = new Store(file);
  assert.equal(store.removeAweme('target'), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.userA.post.target, undefined);
  assert.equal(saved.userB.like.target, undefined);
  assert.equal(saved.userA.post.keep, 2);
});
