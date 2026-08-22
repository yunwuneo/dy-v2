import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { log } from './logger.js';

/** 清理文件名中的非法字符 */
export function sanitize(name) {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || 'untitled';
}

/** 构建分类保存路径：downloads/<用户>/<类型>/<标题>_<awemeId>.mp4 */
export function buildTargetPath(userName, typeLabel, awemeId, desc) {
  const base = config.outputDir;
  const dir = path.join(base, sanitize(userName), typeLabel);
  const filename = `${sanitize(desc)}_${awemeId}.mp4`;
  return { dir, file: path.join(dir, filename) };
}

/** 从 URL 推断文件扩展名（带默认值） */
export function extFromUrl(url, fallback = '.jpg') {
  const m = /\.(jpe?g|png|webp|heic|gif|bmp|mp4|mov)(?:[?#]|$)/i.exec(String(url));
  return m ? `.${m[1].toLowerCase()}` : fallback;
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
    return null;
  }
}

/** 将远程视频流式写入本地文件，返回文件字节数 */
export async function downloadToFile(url, destPath, { timeoutMs = 180000 } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://www.douyin.com/',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  return fs.statSync(destPath).size;
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
