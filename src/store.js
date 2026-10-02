import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicJson, withFileLock } from './persistence.js';

/** Legacy downloaded.json is the snapshot; the journal avoids rewriting it per item. */
export class Store {
  constructor(file = path.join(config.dataDir, 'downloaded.json')) {
    this.file = path.resolve(file);
    this.journal = `${this.file}.jsonl`;
    this.data = {};
    this.offset = 0;
    this.snapshotStamp = null;
    this.operations = 0;
    withFileLock(this.file, () => this._refresh());
  }

  _refresh() {
    const stat = fs.existsSync(this.file) ? fs.statSync(this.file) : null;
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : '';
    if (stamp !== this.snapshotStamp) {
      this.data = stat ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
      if (!this.data || Array.isArray(this.data) || typeof this.data !== 'object') throw new Error('下载记录格式损坏');
      this.snapshotStamp = stamp;
      this.offset = 0;
      this.operations = 0;
    }
    if (!fs.existsSync(this.journal)) { this.offset = 0; return; }
    const size = fs.statSync(this.journal).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;
    const fd = fs.openSync(this.journal, 'r');
    const bytes = Buffer.alloc(size - this.offset);
    try { fs.readSync(fd, bytes, 0, bytes.length, this.offset); } finally { fs.closeSync(fd); }
    const last = bytes.lastIndexOf(10);
    if (last < bytes.length - 1) fs.truncateSync(this.journal, this.offset + last + 1);
    for (const line of bytes.subarray(0, last + 1).toString('utf8').split('\n').filter(Boolean)) {
      this._apply(JSON.parse(line));
      this.operations++;
    }
    this.offset += last + 1;
  }

  _apply(op) {
    if (op.action === 'mark') {
      const user = String(op.user), type = String(op.type), id = String(op.id);
      for (const key of [user, type, id]) if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('无效的记录标识');
      this.data[user] ??= {};
      this.data[user][type] ??= {};
      this.data[user][type][id] = op.time;
    } else if (op.action === 'remove') {
      for (const user of Object.values(this.data)) for (const records of Object.values(user || {})) delete records[op.id];
    } else throw new Error('未知的下载记录操作');
  }

  _append(op) {
    const fd = fs.openSync(this.journal, 'a');
    try { fs.writeFileSync(fd, JSON.stringify(op) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this._refresh();
    if (this.operations >= 2000) this._compact();
  }

  _compact() {
    atomicJson(this.file, this.data);
    // Replaying operations after a crash between snapshot and truncation is idempotent.
    fs.writeFileSync(this.journal, '');
    this.snapshotStamp = null;
    this._refresh();
  }

  compact() { withFileLock(this.file, () => { this._refresh(); this._compact(); }); }
  has(user, type, id) {
    return withFileLock(this.file, () => { this._refresh(); return Boolean(this.data[user]?.[type]?.[String(id)]); });
  }
  mark(user, type, id) {
    for (const key of [user, type, id]) if (['__proto__', 'constructor', 'prototype'].includes(String(key))) throw new Error('无效的记录标识');
    withFileLock(this.file, () => {
      this._refresh();
      if (!this.data[user]?.[type]?.[String(id)]) this._append({ action: 'mark', user, type, id: String(id), time: Date.now() });
    });
  }
  removeAweme(id) {
    return withFileLock(this.file, () => {
      this._refresh();
      const found = Object.values(this.data).some(user => Object.values(user || {}).some(records => Object.hasOwn(records, String(id))));
      if (found) this._append({ action: 'remove', id: String(id) });
      return found;
    });
  }
}
