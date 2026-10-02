import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log, writeErrorReport } from './logger.js';
import { checkCancelled, executionSignal, fetchWithIdleTimeout, sleep } from './execution.js';

/** 清理文件名中的非法字符 */
export function sanitize(name, maxBytes = 80) {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = `_${s}`;
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = Array.from(s).slice(0, -1).join('');
  return s || 'untitled';
}

/** 构建分类保存路径：downloads/<用户>/<类型>/<标题>_<awemeId>.mp4 */
export function buildTargetPath(userName, typeLabel, awemeId, desc) {
  const base = config.outputDir;
  const dir = path.join(base, sanitize(userName, 80), typeLabel ? sanitize(typeLabel, 40) : '');
  const filename = `${sanitize(desc, 100)}_${sanitize(awemeId, 80)}.mp4`;
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

function partialSize(tmp) {
  try { return fs.statSync(tmp).size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

/** Retry stalled CDN transfers from the last saved byte. */
async function downloadMedia(url, tmp, { timeoutMs, accept, retries }) {
  const attempts = Math.max(1, Math.min(5, Number(retries ?? config.retry)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let request;
    try {
      checkCancelled();
      const offset = partialSize(tmp);
      request = await fetchWithIdleTimeout(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Referer: 'https://www.douyin.com/', Accept: accept,
          'Accept-Encoding': 'identity',
          ...(offset ? { Range: `bytes=${offset}-` } : {}),
        },
      }, timeoutMs);
      const res = request.response;
      if (offset && res.status === 416) {
        const total = Number(/^bytes \*\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]);
        await res.body?.cancel();
        if (total === offset) return res.headers.get('content-type');
        fs.rmSync(tmp, { force: true });
        throw new Error('CDN 拒绝续传，重新下载');
      }
      if (![200, 206].includes(res.status) || !res.body) {
        await res.body?.cancel();
        const error = new Error(`下载失败 HTTP ${res.status}`);
        error.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        throw error;
      }
      const range = res.status === 206
        ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '')
        : null;
      if (res.status === 206 && (!range || Number(range[1]) !== offset)) {
        await res.body.cancel();
        fs.rmSync(tmp, { force: true });
        throw new Error('CDN 返回的续传范围不匹配，重新下载');
      }
      const append = offset > 0 && res.status === 206;
      const contentLength = Number(res.headers.get('content-length')) || null;
      const expected = range && range[3] !== '*' ? Number(range[3])
        : contentLength === null ? null : (append ? offset + contentLength : contentLength);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      const heartbeat = new Transform({ transform(chunk, _encoding, callback) {
        if (chunk.length) request.touch();
        callback(null, chunk);
      } });
      const output = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
      try {
        await Promise.race([pipeline(Readable.fromWeb(res.body), heartbeat, output, { signal: request.signal }), request.timeout]);
      } catch (error) {
        output.destroy(error);
        throw error;
      }
      const size = partialSize(tmp);
      if (!size) throw new Error('媒体响应为空');
      if (expected !== null && size !== expected) throw new Error(`媒体传输不完整：${size}/${expected} 字节`);
      return res.headers.get('content-type');
    } catch (error) {
      if (executionSignal()?.aborted) {
        fs.rmSync(tmp, { force: true });
        checkCancelled();
      }
      if (error.retryable === false || attempt === attempts) {
        writeErrorReport('download-request', error, { url, tmp, attempt, savedBytes: partialSize(tmp) });
        throw error;
      }
      log.warn(`媒体下载重试 ${attempt}/${attempts}，已保存 ${partialSize(tmp)} 字节: ${error.message}`);
      await sleep(300 * attempt);
    } finally { request?.release(); }
  }
}

/** Stream to a temporary file; only publish complete downloads. */
export async function downloadToFile(url, destPath, { timeoutMs = config.timeoutMs, accept = '*/*', partialSuffix = '.part', retries } = {}) {
  const tmp = `${destPath}${partialSuffix}`;
  try {
    await downloadMedia(url, tmp, { timeoutMs, accept, retries });
    checkCancelled();
    fs.renameSync(tmp, destPath);
    return fs.statSync(destPath).size;
  } catch (error) {
    if (executionSignal()?.aborted) fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export async function downloadImageToFile(url, albumDir, index, { timeoutMs = config.timeoutMs, accept = 'image/jpeg,image/png,image/webp,image/avif,image/heic' } = {}) {
  const tmp = path.join(albumDir, `.img_${String(index).padStart(2, '0')}.part`);
  try {
    const contentType = await downloadMedia(url, tmp, { timeoutMs, accept });
    checkCancelled();
    const header = Buffer.alloc(32);
    const fd = fs.openSync(tmp, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const ext = detectMediaExtension(header, contentType, url) || '.jpg';
    const file = path.join(albumDir, `img_${String(index).padStart(2, '0')}${ext}`);
    fs.renameSync(tmp, file);
    return { file, size: fs.statSync(file).size, extension: ext };
  } finally { fs.rmSync(tmp, { force: true }); }
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
