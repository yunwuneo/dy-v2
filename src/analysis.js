import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicJson } from './persistence.js';
import { getLibraryItem } from './library.js';
import { runVideoAnalysis } from './analysis-runner.js';
import { redact, log } from './logger.js';

const now = () => new Date().toISOString();
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const active = new Set(['queued', 'running', 'stopping']);

export function normalizeResult(raw) {
  if (!raw || typeof raw.description !== 'string' || !raw.description.trim()) throw new Error('分析未返回有效描述');
  const labels = key => {
    if (!Array.isArray(raw[key])) throw new Error(`分析未返回 ${key}`);
    const values = [...new Set(raw[key].filter(v => typeof v === 'string').map(v => v.trim().replace(/^#+/, '').slice(0, 80)).filter(Boolean))].slice(0, 30);
    if (!values.length) throw new Error(`分析返回空 ${key}`);
    return values;
  };
  return { description: raw.description.slice(0, 50000), keywords: labels('keywords'), tags: labels('tags'),
    transcript: typeof raw.transcript === 'string' ? raw.transcript.slice(0, 100000) : '',
    transcriptLanguage: typeof raw.transcriptLanguage === 'string' ? raw.transcriptLanguage.slice(0, 100) : null,
    transcriptRequestedLanguage: typeof raw.transcriptRequestedLanguage === 'string' ? raw.transcriptRequestedLanguage.slice(0, 10) : 'auto',
    transcriptProvider: ['local', 'cloud'].includes(raw.transcriptProvider) ? raw.transcriptProvider : null,
    transcriptModel: typeof raw.transcriptModel === 'string' ? raw.transcriptModel.slice(0, 1000) : null,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(v => typeof v === 'string').slice(0, 10) : [],
    frames: Number(raw.frames) || 0 };
}

export class AnalysisManager {
  constructor({ library, root = config.outputDir, file = path.join(config.dataDir, 'analysis.json'), settings = config, runner = runVideoAnalysis } = {}) {
    this.library = library;
    this.root = root;
    this.file = file;
    this.settings = settings;
    this.runner = runner;
    this.records = new Map();
    this.enabled = false;
    this.closed = false;
    this.current = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.root === path.resolve(root)) for (const record of saved.items) {
        if (active.has(record.status)) { record.status = 'queued'; record.stage = 'queued'; record.error = '服务重启，等待重新分析'; }
        this.records.set(record.id, record);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`分析记录读取失败：${error.message}`); }
  }
  save() { atomicJson(this.file, { version: 1, root: path.resolve(this.root), items: [...this.records.values()] }); }
  get(id) { return this.records.get(id) || null; }
  summary(id) {
    const record = this.get(id);
    if (!record) return null;
    const { transcript, ...result } = record.result || {};
    return { status: record.status, stage: record.stage, error: record.error, progress: record.progress, completedAt: record.completedAt, ...result };
  }
  snapshot({ offset = 0, limit = 30, status = '' } = {}) {
    const all = [...this.records.values()];
    const counts = Object.fromEntries(['queued', 'running', 'stopping', 'completed', 'failed', 'cancelled'].map(s => [s, all.filter(r => r.status === s).length]));
    const matching = all.filter(r => !status || r.status === status).sort((a, b) => Number(active.has(b.status)) - Number(active.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
    return { enabled: this.enabled, auto: this.settings.analysisAuto, stopping: Boolean(this.current?.controller.signal.aborted), counts,
      total: matching.length, offset, limit, hasMore: offset + limit < matching.length,
      items: matching.slice(offset, offset + limit).map(({ result, ...r }) => ({ ...r, result: result ? { ...result, transcript: undefined } : null })) };
  }
  enqueueItems(items, { force = false, retry = true } = {}) {
    if (this.closed) throw fail('分析服务已关闭', 503);
    let added = 0, skipped = 0;
    for (const item of items) {
      const previous = this.get(item.id);
      if (item.kind !== 'video' || (previous && (active.has(previous.status) || (!force && (previous.result || !retry))))) { skipped++; continue; }
      const record = { id: item.id, title: item.title, status: 'queued', stage: 'queued', progress: { completed: 0, total: 0 },
        updatedAt: now(), queuedAt: now(), result: previous?.result || null, error: null };
      this.records.set(item.id, record);
      added++;
    }
    if (added) { this.save(); this.pump(); }
    return { added, skipped, enabled: this.enabled };
  }
  async enqueue({ ids, all = false, force = false, filters = {} } = {}) {
    if (typeof all !== 'boolean' || typeof force !== 'boolean') throw fail('all / force 必须是布尔值');
    if (all && ids !== undefined) throw fail('不能同时提交 all 和 ids');
    let items;
    if (all) {
      if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.entries(filters).some(([k, v]) => !['search', 'user', 'type'].includes(k) || typeof v !== 'string')) throw fail('分析筛选条件无效');
      items = (await this.library.query({ ...filters, kind: 'video', limit: Number.MAX_SAFE_INTEGER, refresh: true })).items;
    } else {
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw fail('请选择 1–1000 个视频，或使用 all 批量分析');
      // Validate the entire request before mutating the queue.
      items = [...new Set(ids)].map(id => getLibraryItem(id, this.root).item);
      if (items.some(item => item.kind !== 'video')) throw fail('分析仅支持视频');
    }
    return this.enqueueItems(items, { force });
  }
  downloaded(file) {
    if (!this.settings.analysisAuto || this.closed) return;
    const id = Buffer.from(path.relative(this.root, file)).toString('base64url');
    try { this.enqueueItems([getLibraryItem(id, this.root).item], { retry: false }); }
    catch (error) { log.error(`自动分析入队失败：${error.message}`); }
  }
  configure() {
    if (this.settings.analysisEnabled) this.start(); else this.stop();
  }
  start() { if (!this.closed) { this.enabled = true; this.pump(); } }
  stop() {
    this.enabled = false;
    if (this.current && !this.current.controller.signal.aborted) {
      this.current.record.status = 'stopping'; this.current.record.stage = 'stopping';
      this.current.controller.abort(new Error('分析已停止'));
      this.save();
    }
  }
  cancel(id) {
    const record = this.get(id);
    if (!record) throw fail('分析任务不存在', 404);
    if (this.current?.record === record) {
      this.current.cancelled = true;
      record.status = 'stopping'; record.stage = 'stopping';
      this.current.controller.abort(new Error('任务已取消'));
    } else if (record.status === 'queued') { record.status = 'cancelled'; record.stage = 'cancelled'; }
    record.updatedAt = now(); this.save();
  }
  async remove(id) {
    if (this.current?.record.id === id) { this.cancel(id); await this.current?.promise; }
    this.records.delete(id); this.save();
  }
  pump() {
    if (!this.enabled || this.closed || this.current) return;
    const record = [...this.records.values()].find(r => r.status === 'queued');
    if (!record) return;
    const current = { record, controller: new AbortController(), cancelled: false };
    this.current = current;
    current.promise = this.execute(current).finally(() => { this.current = null; this.pump(); });
    current.promise.catch(error => { this.enabled = false; log.error(`分析队列保存失败：${error.message}`); });
  }
  async execute(current) {
    const { record, controller } = current;
    const settings = Object.fromEntries(Object.entries(this.settings).filter(([key]) => key.startsWith('analysis')));
    try {
      const { target } = getLibraryItem(record.id, this.root);
      record.status = 'running'; record.stage = 'loading'; record.startedAt = now(); record.updatedAt = now(); record.error = null;
      record.model = settings.analysisModel; record.client = settings.analysisClient;
      this.save();
      const raw = await this.runner({ target, settings, signal: controller.signal, report: event => {
        if (controller.signal.aborted) return;
        record.stage = String(event.stage || 'running').slice(0, 100);
        record.progress = { completed: Math.max(0, Number(event.completed) || 0), total: Math.max(0, Number(event.total) || 0) };
        record.updatedAt = now();
      } });
      if (controller.signal.aborted) throw controller.signal.reason;
      getLibraryItem(record.id, this.root); // Do not publish a result after external deletion.
      record.result = { ...normalizeResult(raw), model: settings.analysisModel, client: settings.analysisClient, completedAt: now() };
      record.status = 'completed'; record.stage = 'completed'; record.completedAt = now();
    } catch (error) {
      record.status = controller.signal.aborted ? (current.cancelled ? 'cancelled' : 'queued') : 'failed';
      record.stage = record.status;
      record.error = redact(error.message);
    } finally { record.updatedAt = now(); this.save(); }
  }
  async close() { this.closed = true; this.stop(); await this.current?.promise; }
}
