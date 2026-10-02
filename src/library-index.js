import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { atomicJson } from './persistence.js';

export class LibraryIndex {
  constructor({ root = config.outputDir, file = path.join(config.dataDir, 'library-index.json'), ttlMs = Number(config.libraryCacheSeconds) * 1000 || 30000 } = {}) {
    this.root = path.resolve(root);
    this.file = file;
    this.ttlMs = ttlMs;
    this.generation = 0;
    this.scannedAt = 0;
    this.scanCount = 0;
    this.pending = null;
    this.worker = null;
    this.closed = false;
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version === 1 && saved.root === this.root) this.data = saved.data; } catch {}
  }
  invalidate() { this.generation++; this.scannedAt = 0; }
  async refresh() {
    if (this.closed) throw new Error('媒体索引已关闭');
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let generation;
      do {
        generation = this.generation;
        const data = await new Promise((resolve, reject) => {
          const worker = new Worker(new URL('./library-worker.js', import.meta.url), { workerData: { root: this.root }, execArgv: [] });
          this.worker = worker;
          let received = false;
          worker.once('message', result => { received = true; resolve(result); });
          worker.once('error', reject);
          worker.once('exit', code => { if (!received) reject(new Error(`媒体扫描中断 (${code})`)); });
        });
        this.scanCount++;
        if (generation === this.generation) {
          this.data = data;
          this.scannedAt = Date.now();
          atomicJson(this.file, { version: 1, root: this.root, scannedAt: this.scannedAt, data });
        }
      } while (generation !== this.generation && !this.closed);
    })().finally(() => { this.pending = null; this.worker = null; });
    return this.pending;
  }
  async query({ offset = 0, limit = 24, search = '', kind = '', user = '', type = '', refresh = false } = {}) {
    if (refresh) this.invalidate();
    if (!this.data || !this.scannedAt || Date.now() - this.scannedAt >= this.ttlMs) await this.refresh();
    const needle = String(search).toLowerCase();
    const matching = this.data.items.filter(item => (!kind || item.kind === kind) && (!user || item.user === user) && (!type || item.type === type)
      && (!needle || `${item.title} ${item.author} ${item.awemeId} ${item.user} ${item.type}`.toLowerCase().includes(needle)));
    return { items: matching.slice(offset, offset + limit), total: matching.length, offset, limit, hasMore: offset + limit < matching.length, summary: this.data.summary, scannedAt: new Date(this.scannedAt).toISOString() };
  }
  async close() { this.closed = true; await this.worker?.terminate(); await this.pending?.catch(() => {}); }
}
