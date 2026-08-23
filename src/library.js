import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

class LibraryError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function readMetadata(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function encodeId(relativePath) {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeId(id) {
  try {
    return Buffer.from(String(id || ''), 'base64url').toString('utf8');
  } catch {
    throw new LibraryError('无效的媒体 ID', 400);
  }
}

function safeTarget(root, id) {
  const base = path.resolve(root);
  const relative = decodeId(id);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new LibraryError('无效的媒体 ID', 400);
  }
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new LibraryError('媒体路径越界', 400);
  return target;
}

function mediaFilesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function browserCompatibleImage(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(16);
    const length = fs.readSync(fd, header, 0, header.length, 0);
    const bytes = header.subarray(0, length);
    return bytes[0] === 0xff && bytes[1] === 0xd8
      || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      || bytes.subarray(0, 4).toString('ascii') === 'GIF8'
      || bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      || bytes.subarray(0, 2).toString('ascii') === 'BM';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function titleFromName(name) {
  return path.basename(name, path.extname(name)).replace(/_\d{12,}$/, '') || '未命名作品';
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function itemFromTarget(root, target, { includeFallbacks = false } = {}) {
  const stat = fs.statSync(target);
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep);
  const isVideo = stat.isFile() && path.extname(target).toLowerCase() === '.mp4';
  const files = isVideo ? [target] : stat.isDirectory() ? mediaFilesIn(target) : [];
  if (!isVideo && files.length === 0) return null;

  const metadataFile = isVideo ? target.replace(/\.mp4$/i, '.json') : path.join(target, 'metadata.json');
  const metadata = fs.existsSync(metadataFile) ? readMetadata(metadataFile) : {};
  const mediaStats = files.map((file) => fs.statSync(file));
  const size = mediaStats.reduce((sum, fileStat) => sum + fileStat.size, 0);
  const modifiedAt = new Date(Math.max(stat.mtimeMs, ...mediaStats.map((fileStat) => fileStat.mtimeMs))).toISOString();
  const id = encodeId(relative);

  return {
    id,
    title: metadata.desc || titleFromName(target),
    kind: isVideo ? 'video' : 'album',
    user: segments[0] || '未分类',
    type: segments[1] || '未分类',
    awemeId: String(metadata.aweme_id || /_(\d{12,})(?:\.mp4)?$/.exec(target)?.[1] || ''),
    createdAt: metadata.create_time_iso || (metadata.create_time ? new Date(metadata.create_time * 1000).toISOString() : null),
    downloadedAt: metadata.local?.downloaded_at || modifiedAt,
    size,
    fileCount: files.length,
    durationMs: Number(metadata.duration_ms) || 0,
    author: metadata.author?.nickname || '',
    statistics: metadata.statistics || {},
    music: metadata.music || null,
    shareUrl: safeHttpUrl(metadata.share_url),
    mediaUrl: `/api/library/media?id=${encodeURIComponent(id)}&file=0`,
    thumbnailUrl: isVideo ? '' : `/api/library/media?id=${encodeURIComponent(id)}&file=0`,
    thumbnailFallbackUrl: isVideo ? '' : safeHttpUrl(metadata.cover || metadata.image_urls?.[0]),
    media: files.map((_, index) => `/api/library/media?id=${encodeURIComponent(id)}&file=${index}`),
    mediaSupported: isVideo ? [true] : files.map(browserCompatibleImage),
    fallbackMedia: includeFallbacks && !isVideo ? files.map((_, index) => safeHttpUrl(metadata.image_urls?.[index])) : undefined,
  };
}

function walk(root, dir, items, counters) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === 'metadata.json')) {
    const album = itemFromTarget(root, dir);
    if (album) {
      items.push(album);
      return;
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, target, items, counters);
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4') {
      const video = itemFromTarget(root, target);
      if (video) items.push(video);
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json' && entry.name !== 'metadata.json') {
      const mediaPath = target.replace(/\.json$/i, '.mp4');
      if (!fs.existsSync(mediaPath)) counters.orphanMetadata += 1;
    }
  }
}

export function listLibrary(root = config.outputDir) {
  const base = path.resolve(root);
  const items = [];
  const counters = { orphanMetadata: 0 };
  if (fs.existsSync(base)) walk(base, base, items, counters);
  items.sort((a, b) => String(b.downloadedAt).localeCompare(String(a.downloadedAt)));
  return {
    items,
    summary: {
      total: items.length,
      videos: items.filter((item) => item.kind === 'video').length,
      albums: items.filter((item) => item.kind === 'album').length,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
      orphanMetadata: counters.orphanMetadata,
      users: [...new Set(items.map((item) => item.user))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      types: [...new Set(items.map((item) => item.type))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    },
  };
}

export function getLibraryItem(id, root = config.outputDir) {
  const target = safeTarget(root, id);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw new LibraryError('媒体不存在', 404);
  const item = itemFromTarget(path.resolve(root), target, { includeFallbacks: true });
  if (!item) throw new LibraryError('媒体不存在', 404);
  return { item, target };
}

export function getLibraryMedia(id, fileIndex = 0, root = config.outputDir) {
  const { item, target } = getLibraryItem(id, root);
  const files = item.kind === 'video' ? [target] : mediaFilesIn(target);
  const index = Number.parseInt(String(fileIndex), 10);
  if (!Number.isInteger(index) || index < 0 || index >= files.length) throw new LibraryError('媒体文件不存在', 404);
  return files[index];
}

export function deleteLibraryItem(id, root = config.outputDir) {
  const { item, target } = getLibraryItem(id, root);
  if (item.kind === 'video') {
    fs.rmSync(target);
    fs.rmSync(target.replace(/\.mp4$/i, '.json'), { force: true });
  } else {
    fs.rmSync(target, { recursive: true });
  }
  return item;
}

export const libraryInternals = { encodeId, decodeId };
