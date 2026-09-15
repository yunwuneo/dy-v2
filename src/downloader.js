import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log, writeErrorReport } from './logger.js';

/** 清理文件名中的非法字符 */
export function sanitize(name, maxBytes = 80) {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = Array.from(s).slice(0, -1).join('');
  return s || 'untitled';
}

/** 构建分类保存路径：downloads/<用户>/<类型>/<标题>_<awemeId>.mp4 */
export function buildTargetPath(userName, typeLabel, awemeId, desc) {
  const base = config.outputDir;
  const dir = path.join(base, sanitize(userName, 80), typeLabel ? sanitize(typeLabel, 40) : '');
  const filename = `${sanitize(desc, 100)}_${String(awemeId)}.mp4`;
  return { dir, file: path.join(dir, filename) };
}

/** 从 URL 推断文件扩展名（带默认值） */
export function extFromUrl(url, fallback = '.jpg') {
  const m = /\.(jpe?g|png|webp|heic|gif|bmp|mp4|mov)(?:[?#]|$)/i.exec(String(url));
  return m ? `.${m[1].toLowerCase()}` : fallback;
}

/** 根据响应头和文件头识别实际媒体格式，避免 CDN 无扩展名时误存为 jpg。 */
export function detectMediaExtension(headerBytes, contentType = '', url = '') {
  const bytes = Buffer.isBuffer(headerBytes) ? headerBytes : Buffer.from(headerBytes || []);
  const type = String(contentType).split(';', 1)[0].trim().toLowerCase();
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || type === 'image/jpeg') return '.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary')) || type === 'image/png') return '.png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' || type === 'image/webp') return '.webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return '.avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1' || brand === 'vvic') return '.heic';
  }
  if (/image\/avif/i.test(type)) return '.avif';
  if (/image\/(heic|heif|vvic)/i.test(type)) return '.heic';
  return extFromUrl(url, '');
}

/** 将 JSON 数据原子写入磁盘，失败仅告警不抛出（元数据保存不应中断下载主流程） */
export function writeJsonFile(destPath, data) {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.part`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, destPath);
    return destPath;
  } catch (e) {
    log.warn(`写入 JSON 失败 ${destPath}: ${e.message}`);
    writeErrorReport('metadata-write', e, { destPath });
    return null;
  }
}

/** 将远程视频流式写入本地文件，返回文件字节数 */
export async function downloadToFile(url, destPath, { timeoutMs = 180000, accept = '*/*' } = {}) {
  let res;
  try {
    res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://www.douyin.com/',
      Accept: accept,
    },
    signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    writeErrorReport('download-request', e, { url, destPath, timeoutMs });
    throw new Error(`媒体请求失败: ${e.message}`);
  }

  if (!res.ok || !res.body) {
    const error = new Error(`下载失败 HTTP ${res.status}`);
    writeErrorReport('download-http', error, { url, destPath, status: res.status, headers: Object.fromEntries(res.headers) });
    throw error;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    writeErrorReport('download-write', e, { url, destPath, tmp });
    throw e;
  }
  return fs.statSync(destPath).size;
}

/** 下载图片到临时文件，按实际格式决定最终扩展名。 */
export async function downloadImageToFile(url, albumDir, index, { timeoutMs = 180000, accept = 'image/jpeg,image/png,image/webp,image/avif,image/heic' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://www.douyin.com/',
        Accept: accept,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    writeErrorReport('download-request', e, { url, albumDir, index, timeoutMs });
    throw new Error(`媒体请求失败: ${e.message}`);
  }
  if (!res.ok || !res.body) {
    const error = new Error(`下载失败 HTTP ${res.status}`);
    writeErrorReport('download-http', error, { url, albumDir, index, status: res.status, headers: Object.fromEntries(res.headers) });
    throw error;
  }
  fs.mkdirSync(albumDir, { recursive: true });
  const tmp = path.join(albumDir, `.img_${String(index).padStart(2, '0')}.part`);
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const header = Buffer.alloc(32);
    const fd = fs.openSync(tmp, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const ext = detectMediaExtension(header, res.headers.get('content-type'), url) || '.jpg';
    const file = path.join(albumDir, `img_${String(index).padStart(2, '0')}${ext}`);
    fs.renameSync(tmp, file);
    return { file, size: fs.statSync(file).size, extension: ext };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    writeErrorReport('download-write', e, { url, albumDir, index, tmp });
    throw e;
  }
}

/** 并发下载器（简单实现，带并发上限） */
export async function downloadAll(jobs, concurrency = config.downloadConcurrency) {
  const results = [];
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try {
        const r = await job.run();
        results.push({ ...job, ok: true, result: r });
      } catch (e) {
        results.push({ ...job, ok: false, error: e.message });
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// 避免未使用告警
void log;
