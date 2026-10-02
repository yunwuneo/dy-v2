import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { saveSettings } from './settings.js';
import { atomicJson, acquireFileLock } from './persistence.js';
import { cachedName } from './profile-cache.js';
import { log, redact } from './logger.js';

const activeStates = new Set(['queued', 'running', 'cancelling']);
const counters = ['total', 'completed', 'downloaded', 'skipped', 'failed', 'metadata_backfilled'];
const emptyProgress = () => Object.fromEntries(counters.map(key => [key, 0]));
const sumProgress = (a, b) => Object.fromEntries(counters.map(key => [key, (a?.[key] || 0) + (b?.[key] || 0)]));
const pollError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

/** Web-owned scheduler. Every check uses the shared, cancellable download queue. */
export class PollingManager {
  constructor({ jobs, file = path.join(config.dataDir, 'poller-state.json'), clock = { now: Date.now, setTimeout, clearTimeout } }) {
    this.jobs = jobs;
    this.file = file;
    this.clock = clock;
    this.enabled = false;
    this.closed = false;
    this.timer = null;
    this.nextRunAt = null;
    this.current = null;
    this.pending = null;
    this.targets = {};
    this.lastRun = null;
    this.lastError = null;
    this.release = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.targets = saved.targets || {};
      this.lastRun = saved.lastRun || null;
      if (this.lastRun && !this.lastRun.finishedAt) {
        this.lastRun.status = 'interrupted'; this.lastRun.finishedAt = this.iso();
      }
      for (const target of Object.values(this.targets)) {
        if (activeStates.has(target.status)) { target.status = 'interrupted'; target.lastFinishedAt = this.iso(); }
        delete target.activeJobId;
      }
    } catch (error) { if (error.code !== 'ENOENT') log.warn(`轮询历史读取失败: ${error.message}`); }
  }

  iso() { return new Date(this.clock.now()).toISOString(); }
  intervalMs() { return Math.max(5, config.pollIntervalSeconds) * 1000; }
  activeWatchers() { return config.watchers.filter(w => w.enabled !== false); }
  ensureLock() {
    if (!this.release) {
      try { this.release = acquireFileLock(path.join(config.dataDir, 'poller'), { timeoutMs: 0 }); }
      catch (error) { throw pollError(`另一个监听进程正在运行，请先停止它：${error.message}`); }
    }
  }
  clearSchedule() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null; this.nextRunAt = null;
  }
  persist() {
    // Exclude removed targets; no cookies, credentials or raw API responses are stored.
    const targets = Object.fromEntries(config.watchers.filter(w => this.targets[w.id]).map(w => [w.id, this.targets[w.id]]));
    try { atomicJson(this.file, redact({ version: 1, lastRun: this.current?.summary || this.lastRun, targets })); }
    catch (error) { this.lastError = redact(`轮询历史保存失败: ${error.message}`); log.error(this.lastError); }
  }
  assertReady(watchers = this.activeWatchers()) {
    if (this.closed) throw pollError('服务正在关闭', 503);
    if (!watchers.length) throw pollError('请先添加并启用至少一个监控目标', 400);
    if (!config.apiKey || /在此填入|your_tikhub_api_key_here/.test(config.apiKey)) throw pollError('请先配置 TikHub API Key', 400);
    if (this.current?.cancelled) throw pollError('正在停止本轮检查，请稍后再启动');
  }
  enable() {
    this.assertReady(); this.ensureLock();
    try { saveSettings({ fields: { pollerEnabled: true } }); this.configure(); }
    catch (error) { if (!this.enabled && !this.current) { this.release?.(); this.release = null; } throw error; }
    return this.snapshot();
  }
  disable() {
    this.stop();
    try { saveSettings({ fields: { pollerEnabled: false } }); }
    catch (error) {
      config.pollerEnabled = false;
      this.lastError = redact(`监听已停止，但启停状态保存失败: ${error.message}`);
      throw pollError(this.lastError, 500);
    }
    return this.snapshot();
  }
  configure({ resume = false } = {}) {
    if (this.closed) return;
    if (!config.pollerEnabled) { if (this.enabled) this.stop(); return; }
    if (!this.enabled) {
      this.assertReady(); this.ensureLock(); this.enabled = true; this.lastError = null;
      // A service restart preserves the last completion time rather than adding an extra paid check.
      const due = resume && this.lastRun?.finishedAt ? Date.parse(this.lastRun.finishedAt) + this.intervalMs() : this.clock.now();
      if (!this.current) this.schedule(due);
      log.info('Web 轮询监听已启动');
    } else if (!this.current) {
      this.schedule(this.lastRun?.finishedAt ? Date.parse(this.lastRun.finishedAt) + this.intervalMs() : this.clock.now());
    }
    // Pausing/removing the currently running target also cancels its queued or active job.
    if (this.current && !this.current.manualTarget) {
      const watcher = config.watchers.find(w => w.id === this.current.targetId);
      if (!watcher || watcher.enabled === false) this.cancelActiveJob();
    }
  }
  schedule(due = this.clock.now() + this.intervalMs()) {
    this.clearSchedule();
    if (!this.enabled || this.closed || this.current || !this.activeWatchers().length) return;
    this.nextRunAt = new Date(Math.max(this.clock.now(), due)).toISOString();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null; this.nextRunAt = null;
      try { this.runOnce(); }
      catch (error) { this.lastError = redact(error.message); log.error(`轮询检查失败: ${this.lastError}`); this.schedule(); }
    }, Math.max(0, due - this.clock.now()));
  }
  cancelActiveJob() {
    const id = this.current?.jobId;
    if (id && activeStates.has(this.jobs.get(id).status)) this.jobs.cancel(id);
  }
  stop() {
    this.enabled = false; this.clearSchedule();
    if (this.current) { this.current.cancelled = true; this.cancelActiveJob(); }
    else { this.release?.(); this.release = null; }
    log.info('Web 轮询监听已停止');
  }
  runOnce(watcherId = null) {
    if (this.current) throw pollError('本轮检查尚未结束，请等待完成后再检查');
    const watchers = watcherId ? config.watchers.filter(w => w.id === watcherId) : this.activeWatchers();
    if (watcherId && !watchers.length) throw pollError('监听目标不存在', 404);
    this.assertReady(watchers); this.ensureLock(); this.clearSchedule(); this.lastError = null;
    const summary = { id: crypto.randomUUID(), startedAt: this.iso(), finishedAt: null, status: 'running', totalTargets: watchers.length, completedTargets: 0, progress: emptyProgress() };
    this.current = { summary, ids: watchers.map(w => w.id), targetId: null, jobId: null, cancelled: false, manualTarget: Boolean(watcherId) };
    this.persist();
    this.pending = this.execute(this.current).finally(() => { this.pending = null; });
    return this.snapshot();
  }
  async execute(run) {
    let failures = 0;
    try {
      for (const id of run.ids) {
        if (run.cancelled || this.closed) break;
        const watcher = config.watchers.find(w => w.id === id);
        if (!watcher || (!run.manualTarget && watcher.enabled === false)) continue;
        run.targetId = id;
        const target = this.targets[id] = { status: 'queued', lastStartedAt: this.iso(), lastFinishedAt: null, progress: emptyProgress(), error: null, jobIds: [] };
        const input = structuredClone(watcher);
        for (const type of input.types) {
          if (run.cancelled || this.closed) break;
          if (!run.manualTarget && !config.watchers.some(w => w.id === id && w.enabled !== false)) break;
          try {
            const job = this.jobs.submit('batch', {
              identifier: input.identifier, type, cookie: input.cookie, limit: input.limit,
              userName: type === 'collect' ? '' : input.name || cachedName(input.identifier),
            }, `轮询 · ${input.name || cachedName(input.identifier) || input.identifier} · ${type}`, 'poller');
            run.jobId = job.id; target.activeJobId = job.id; target.jobIds.push(job.id);
            this.persist();
            const finished = await this.jobs.waitFor(job.id);
            target.progress = sumProgress(target.progress, finished.progress);
            run.summary.progress = sumProgress(run.summary.progress, finished.progress);
            run.jobId = null; delete target.activeJobId;
            if (finished.status !== 'completed') {
              target.status = finished.status; target.error = finished.error || '检查未完成'; failures++;
              if (finished.status === 'cancelled') break;
            }
          } catch (error) { target.status = 'failed'; target.error = redact(error.message); failures++; }
        }
        if (run.cancelled) target.status = 'cancelled';
        else if (target.status === 'queued') target.status = 'completed';
        target.lastFinishedAt = this.iso();
        run.summary.completedTargets++; run.targetId = null;
        this.persist();
      }
      run.summary.status = run.cancelled ? 'cancelled' : failures ? 'partial' : 'completed';
    } catch (error) { run.summary.status = 'failed'; this.lastError = redact(error.message); log.error(this.lastError); }
    finally {
      run.summary.finishedAt = this.iso(); this.lastRun = run.summary; this.current = null;
      this.persist();
      log.info(`轮询检查结束: ${run.summary.status}，检查 ${run.summary.completedTargets}/${run.summary.totalTargets} 个目标`);
      if (this.enabled && !this.closed) this.schedule();
      else { this.release?.(); this.release = null; }
    }
  }
  snapshot() {
    const run = this.current;
    let progress = run ? run.summary.progress : this.lastRun?.progress || emptyProgress();
    if (run?.jobId) progress = sumProgress(progress, this.jobs.get(run.jobId).progress);
    return redact({
      enabled: this.enabled, desiredEnabled: config.pollerEnabled, status: run ? (run.cancelled ? 'stopping' : 'running') : this.enabled ? 'waiting' : config.pollerEnabled && this.lastError ? 'error' : 'stopped',
      intervalSeconds: this.intervalMs() / 1000, nextRunAt: this.nextRunAt,
      lastStartedAt: run?.summary.startedAt || this.lastRun?.startedAt || null,
      lastFinishedAt: this.lastRun?.finishedAt || null, lastRun: this.lastRun,
      current: run ? { ...run.summary, progress, targetId: run.targetId, jobId: run.jobId } : null,
      progress, error: this.lastError,
      watchers: config.watchers.map(w => {
        const target = this.targets[w.id];
        let job = null;
        try { if (target?.activeJobId) job = this.jobs.get(target.activeJobId); } catch { /* old history was pruned */ }
        return { id: w.id, status: job ? job.status : w.enabled === false ? 'paused' : target?.status || 'idle',
          lastStartedAt: target?.lastStartedAt || null, lastFinishedAt: target?.lastFinishedAt || null,
          nextRunAt: w.enabled !== false ? this.nextRunAt : null, progress: sumProgress(target?.progress, job?.progress),
          error: target?.error || job?.error || null, jobIds: target?.jobIds || [] };
      }),
    });
  }
  async close() {
    this.closed = true; this.stop();
    await this.pending;
    this.release?.(); this.release = null;
  }
}
