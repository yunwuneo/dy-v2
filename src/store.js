import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

/**
 * 本地去重存储：记录已下载的 aweme_id，避免轮询时重复下载。
 * 数据结构：{ [userKey]: { [type]: { [awemeId]: timestamp } } }
 */
export class Store {
  constructor(file = path.join(ROOT_DIR, 'data', 'downloaded.json')) {
    this.file = file;
    this.data = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      }
    } catch {
      this.data = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      // 存储失败不应中断下载流程
      console.warn('[WARN] 写入去重记录失败:', e.message);
    }
  }

  has(userKey, type, awemeId) {
    return !!(this.data[userKey]?.[type]?.[String(awemeId)]);
  }

  mark(userKey, type, awemeId) {
    this.data[userKey] ??= {};
    this.data[userKey][type] ??= {};
    this.data[userKey][type][String(awemeId)] = Date.now();
    this._save();
  }

  removeAweme(awemeId) {
    const key = String(awemeId || '');
    if (!key) return false;
    let removed = false;
    for (const user of Object.values(this.data)) {
      for (const records of Object.values(user || {})) {
        if (records?.[key]) {
          delete records[key];
          removed = true;
        }
      }
    }
    if (removed) this._save();
    return removed;
  }
}
