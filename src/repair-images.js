import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSingleVideo, awemeMeta } from './douyin.js';
import { detectMediaExtension, downloadImageToFile } from './downloader.js';

const onlyId = process.argv.includes('--aweme-id')
  ? process.argv[process.argv.indexOf('--aweme-id') + 1]
  : '';

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(32);
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  return header;
}

function metadataFiles(root) {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === 'metadata.json') result.push(file);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return result;
}

function malformedFiles(metadataPath, metadata) {
  const dir = path.dirname(metadataPath);
  const files = Array.isArray(metadata.local?.files) ? metadata.local.files : [];
  return files.map((entry, index) => {
    const file = entry?.file && fs.existsSync(entry.file) ? entry.file : path.join(dir, `img_${String(index + 1).padStart(2, '0')}${path.extname(entry?.file || '.jpg')}`);
    if (!fs.existsSync(file)) return null;
    const actual = detectMediaExtension(readHeader(file), '', file);
    return actual === '.heic' || (actual && actual !== path.extname(file).toLowerCase())
      ? { file, index } : null;
  }).filter(Boolean);
}

async function repairAlbum(metadataPath) {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata.aweme_id || (onlyId && String(metadata.aweme_id) !== String(onlyId))) return 0;
  const broken = malformedFiles(metadataPath, metadata);
  if (broken.length === 0) return 0;

  const detail = await getSingleVideo(metadata.aweme_id);
  const aweme = detail?.aweme_detail ?? detail?.aweme ?? detail;
  const urls = awemeMeta(aweme).imageUrls;
  let repaired = 0;
  for (const item of broken) {
    const url = urls[item.index];
    if (!url) continue;
    const backup = `${item.file}.vvic-backup`;
    fs.renameSync(item.file, backup);
    try {
      const result = await downloadImageToFile(url, path.dirname(item.file), item.index + 1);
      fs.rmSync(backup, { force: true });
      metadata.local.files[item.index] = { file: result.file, size: result.size };
      repaired += 1;
    } catch (error) {
      fs.renameSync(backup, item.file);
      throw error;
    }
  }
  if (repaired > 0) {
    metadata.local.total_size = metadata.local.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    metadata.local.repaired_at = new Date().toISOString();
    const temp = `${metadataPath}.part`;
    fs.writeFileSync(temp, JSON.stringify(metadata, null, 2));
    fs.renameSync(temp, metadataPath);
  }
  return repaired;
}

let albums = 0;
let files = 0;
for (const metadataPath of metadataFiles(config.outputDir)) {
  try {
    const repaired = await repairAlbum(metadataPath);
    if (repaired) { albums += 1; files += repaired; console.log(`[修复] ${metadataPath}: ${repaired} 张`); }
  } catch (error) {
    console.error(`[失败] ${metadataPath}: ${error.message}`);
  }
}
console.log(`完成：${albums} 个图集，${files} 张图片`);
