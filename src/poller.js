import path from 'node:path';
import { config, subscribeConfig, watchConfig } from './config.js';
import { log } from './logger.js';
import { downloadVideos } from './tasks.js';
import { resolveSecUserId, resolveUserContext } from './douyin.js';
import { cachedName } from './profile-cache.js';
import { acquireFileLock } from './persistence.js';
import { runWithExecution, checkCancelled } from './execution.js';

/** 对单个监听目标执行一次下载检查 */
export async function runWatcherOnce(watcher) {
  const identifier = watcher.identifier;
  if (!identifier) throw new Error('watcher 缺少 identifier');

  const types = watcher.types && watcher.types.length ? watcher.types : ['post'];
  const limit = watcher.limit ?? Infinity;
  const cookie = watcher.cookie || config.cookie || '';
  const needsUser = types.some((type) => type !== 'collect');
  let userContext = null;
  let userName = watcher.name || cachedName(identifier) || '';

  if (needsUser) {
    if (userName) {
      userContext = { secUserId: await resolveSecUserId(identifier), info: {} };
    } else {
      userContext = await resolveUserContext(identifier);
      userName = userContext.info?.nickname || userContext.info?.user?.nickname || identifier;
    }
  } else {
    userName = userName || '我的收藏';
  }

  const results = {};
  for (const t of types) {
    try {
      results[t] = await downloadVideos({
        identifier,
        type: t,
        limit,
        cookie,
        userContext,
        userName: t === 'collect' ? '' : userName,
      });
    } catch (e) {
      checkCancelled();
      results[t] = { error: e.message };
      log.error(`监听目标 [${userName}] 类型 [${t}] 出错: ${e.message}`);
    }
  }
  return { identifier, userName, results };
}

/** 启动轮询监听主循环 */
export async function startPoller({ once = false } = {}) {
  if (config.watchers.length === 0) {
    log.warn('config.json 未配置 watchers，轮询将无所事事。请编辑 config.json 添加监听目标。');
    if (once) return;
  }

  const release = acquireFileLock(path.join(config.dataDir, 'poller'), { timeoutMs: 0 });
  log.info(`开始轮询监听：${config.watchers.length} 个目标，间隔 ${config.pollIntervalSeconds}s`);
  const controller = new AbortController();
  let timer = null, pending = null, stopping = false, lastFinishedAt = null;
  let unwatch = () => {}, unsubscribe = () => {};

  const tick = async () => {
    // Reloaded targets are picked up at the next tick.
    for (const w of config.watchers.filter(w => w.enabled !== false)) {
      if (stopping) break;
      try {
        await runWatcherOnce(w);
      } catch (e) {
        if (controller.signal.aborted) break;
        log.error(`监听目标 ${w.identifier || '(未知)'} 出错: ${e.message}`);
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    if (stopping) return;
    const delay = Math.max(0, (lastFinishedAt || Date.now()) + Math.max(5, config.pollIntervalSeconds) * 1000 - Date.now());
    timer = setTimeout(async () => {
      timer = null;
      pending = runWithExecution({ signal: controller.signal }, tick);
      await pending; pending = null; lastFinishedAt = Date.now();
      if (!stopping) schedule();
    }, delay);
  };
  const shutdown = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    controller.abort(); unwatch(); unsubscribe();
    await pending; release();
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
  };
  if (!once) {
    unwatch = watchConfig(error => log.error(`配置热重载失败，继续使用原设置: ${error.message}`));
    unsubscribe = subscribeConfig(changed => { if (timer && changed.includes('pollIntervalSeconds')) schedule(); });
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }
  try {
    pending = runWithExecution({ signal: controller.signal }, tick);
    await pending; pending = null; lastFinishedAt = Date.now();
    if (once) release(); else schedule();
  } catch (error) { await shutdown(); throw error; }
}
