import { config } from './config.js';
import { log } from './logger.js';
import { downloadVideos, queryUser } from './tasks.js';

/** 对单个监听目标执行一次下载检查 */
export async function runWatcherOnce(watcher) {
  const identifier = watcher.identifier;
  if (!identifier) throw new Error('watcher 缺少 identifier');

  const info = await queryUser(identifier).catch(() => ({}));
  const userName = watcher.name || info.nickname || identifier;
  const types = watcher.types && watcher.types.length ? watcher.types : ['post'];
  const limit = watcher.limit ?? Infinity;
  const cookie = watcher.cookie || config.cookie || '';

  const results = {};
  for (const t of types) {
    try {
      results[t] = await downloadVideos({ identifier, type: t, limit, cookie });
    } catch (e) {
      results[t] = { error: e.message };
      log.error(`监听目标 [${userName}] 类型 [${t}] 出错: ${e.message}`);
    }
  }
  return { identifier, userName, results };
}

/** 启动轮询监听主循环 */
export async function startPoller({ once = false } = {}) {
  const watchers = config.watchers || [];
  if (watchers.length === 0) {
    log.warn('config.json 未配置 watchers，轮询将无所事事。请编辑 config.json 添加监听目标。');
    if (once) return;
  }

  log.info(`开始轮询监听：${watchers.length} 个目标，间隔 ${config.pollIntervalSeconds}s`);

  const tick = async () => {
    for (const w of watchers) {
      try {
        await runWatcherOnce(w);
      } catch (e) {
        log.error(`监听目标 ${w.identifier || '(未知)'} 出错: ${e.message}`);
      }
    }
  };

  await tick();
  if (once) return;

  const timer = setInterval(tick, Math.max(5, config.pollIntervalSeconds) * 1000);
  const shutdown = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
