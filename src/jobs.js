import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { atomicJson } from './persistence.js';
import { downloadSingle, downloadVideos } from './tasks.js';
import { runWithExecution, checkCancelled, withKeyLock } from './execution.js';
import { log, redact } from './logger.js';

const activeStates = new Set(['queued', 'running', 'cancelling']);
const retryStates = new Set(['failed', 'partial', 'cancelled', 'interrupted']);
const taskError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

function safeRetryInput(kind, options, label) {
  if (kind !== 'batch' || options.cookie || !['post', 'like'].includes(options.type)) return null;
  const identifier = String(options.identifier || '').trim();
  const limit = Number(options.limit);
  if (!identifier || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) return null;
  return { kind: 'batch', options: { identifier, type: options.type, limit }, label };
}

function recoverLegacyInput(job) {
  // Older jobs did not persist inputs. A sec_user_id plus list size is enough to retry posts/likes.
  const match = /^(MS4wLjAB[A-Za-z0-9_-]+) · (post|like)$/.exec(job.label || '');
  return match ? safeRetryInput('batch', { identifier: match[1], type: match[2], limit: job.progress?.total }, job.label) : null;
}

export class JobManager {
  constructor({ file = path.join(config.dataDir, 'jobs.json'), concurrency = config.taskConcurrency, runner, onChange = () => {} } = {}) {
    this.file = file;
    this.concurrency = concurrency;
    this.runner = runner || (async (kind, options, report) => kind === 'single'
      ? withKeyLock(`single:${options.url}`, () => downloadSingle(options.url))
      : downloadVideos({ ...options, onProgress: report }));
    this.onChange = onChange;
    this.jobs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(this.jobs)) throw new Error('任务历史格式损坏');
    this.inputs = new Map();
    for (const job of this.jobs) {
      const input = job.retryInput || recoverLegacyInput(job);
      if (input) this.inputs.set(job.id, input);
      job.canRetry = retryStates.has(job.status) && Boolean(input);
      if (activeStates.has(job.status)) {
        job.status = 'interrupted';
        job.error = '服务重启中断了任务，请重新提交下载。';
        job.finishedAt = new Date().toISOString();
        job.canRetry = Boolean(input);
      }
    }
    this.running = new Map();
    this.closed = false;
    this.timer = null;
    this.listeners = new Set();
  }

  setConcurrency(value) { this.concurrency = value; this.pump(); }
  notify(job) { for (const listener of this.listeners) listener(job); }
  waitFor(id) {
    const job = this.get(id);
    if (!activeStates.has(job.status)) return Promise.resolve(structuredClone(job));
    return new Promise(resolve => {
      const listener = changed => {
        if (changed.id === id && !activeStates.has(changed.status)) {
          this.listeners.delete(listener); resolve(structuredClone(changed));
        }
      };
      this.listeners.add(listener);
    });
  }

  persist() { atomicJson(this.file, redact(this.jobs)); }
  schedulePersist() {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; try { this.persist(); } catch (e) { log.error(`任务进度保存失败: ${e.message}`); } }, 200);
  }
  list({ offset = 0, limit = 30, status = '' } = {}) {
    const all = [...this.jobs].reverse().filter(j => !status || j.status === status);
    const counts = {};
    for (const job of this.jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    return { items: all.slice(offset, offset + limit).map(j => structuredClone(j)), total: all.length, counts };
  }
  get(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw taskError('任务不存在', 404);
    return job;
  }
  submit(kind, options, label = '', source = 'manual') {
    if (this.closed) throw taskError('服务正在关闭', 503);
    if (!['batch', 'single'].includes(kind)) throw taskError('任务类型无效', 400);
    if (this.jobs.filter(j => activeStates.has(j.status)).length >= 50) throw taskError('待处理任务已达上限', 429);
    while (this.jobs.length >= 200) {
      const index = this.jobs.findIndex(j => !activeStates.has(j.status));
      if (index < 0) break;
      this.inputs.delete(this.jobs[index].id);
      this.jobs.splice(index, 1);
    }
    const job = {
      id: crypto.randomUUID(), kind, label: redact(label || (kind === 'single' ? '单个作品下载' : `${options.identifier || '我的收藏'} · ${options.type || 'post'}`)),
      status: 'queued', source, createdAt: new Date().toISOString(), canRetry: false,
      progress: { total: null, completed: 0, active: 0, downloaded: 0, skipped: 0, failed: 0, metadata_backfilled: 0 },
    };
    job.retryInput = safeRetryInput(kind, options, job.label);
    this.jobs.push(job);
    this.inputs.set(job.id, { kind, options, label: job.label });
    try { this.persist(); } catch (error) { this.jobs.pop(); this.inputs.delete(job.id); throw error; }
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }
  pump() {
    if (this.closed) return;
    while (this.running.size < this.concurrency) {
      const job = this.jobs.find(j => j.status === 'queued');
      if (!job) break;
      const controller = new AbortController();
      this.running.set(job.id, { controller });
      const promise = this.execute(job, controller);
      this.running.get(job.id).promise = promise;
    }
  }
  async execute(job, controller) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.schedulePersist();
    log.info(`任务开始: ${job.label}`);
    try {
      const input = this.inputs.get(job.id);
      const result = await runWithExecution({ signal: controller.signal }, async () => {
        const result = await this.runner(input.kind, input.options, (stats) => {
          job.progress = Object.fromEntries(['total', 'completed', 'active', 'downloaded', 'skipped', 'failed', 'metadata_backfilled'].map(k => [k, stats[k] || 0]));
          this.schedulePersist();
        });
        checkCancelled();
        return result;
      });
      if (job.kind === 'single') job.progress = { total: 1, completed: 1, active: 0, downloaded: result.existed ? 0 : 1, skipped: result.existed ? 1 : 0, failed: 0 };
      job.status = result.failed ? (result.downloaded || result.skipped ? 'partial' : 'failed') : 'completed';
      job.errors = redact(result.errors || []);
      if (result.failed) job.error = `${result.failed} 个作品下载失败`;
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = controller.signal.aborted ? '任务已取消，已完成文件保留。' : redact(error.message);
    } finally {
      job.progress.active = 0;
      job.finishedAt = new Date().toISOString();
      job.canRetry = retryStates.has(job.status) && this.inputs.has(job.id);
      this.running.delete(job.id);
      try { this.persist(); } catch (e) { log.error(`任务历史保存失败: ${e.message}`); }
      try { this.onChange(job); } catch (e) { log.error(e.message); }
      this.notify(job);
      log.info(`任务结束: ${job.label} (${job.status})`);
      this.pump();
    }
  }
  cancel(id) {
    const job = this.get(id);
    if (job.status === 'queued') {
      job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); job.canRetry = true;
    } else if (job.status === 'running' || job.status === 'cancelling') {
      job.status = 'cancelling';
      this.running.get(id)?.controller.abort(new DOMException('用户取消任务', 'AbortError'));
    } else throw taskError('任务已结束');
    this.persist();
    this.notify(job);
    return structuredClone(job);
  }
  retry(id) {
    const job = this.get(id), input = this.inputs.get(id);
    if (!retryStates.has(job.status) || !input) throw taskError('该任务不能重试，请重新查询并提交下载');
    return this.submit(input.kind, input.options, input.label, job.source);
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs) if (activeStates.has(job.status)) this.cancel(job.id);
    await Promise.allSettled([...this.running.values()].map(r => r.promise));
    clearTimeout(this.timer);
    this.timer = null;
    if (this.jobs.length) this.persist();
  }
}
