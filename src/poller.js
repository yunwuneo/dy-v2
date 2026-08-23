import { config } from './config.js';
import { log } from './logger.js';
import { downloadVideos } from './tasks.js';
import { resolveSecUserId, resolveUserContext } from './douyin.js';

/** 对单个监听目标执行一次下载检查 */
export async function runWatcherOnce(watcher) {
  const identifier = watcher.identifier;
  if (!identifier) throw new Error('watcher 缺少 identifier');

  const types = watcher.types && watcher.types.length ? watcher.types : ['post'];
  const limit = watcher.limit ?? Infinity;
  const cookie = watcher.cookie || config.cookie || '';
  const needsUser = types.some((type) => type !== 'collect');
  let userContext = null;
  let userName = watcher.name || '';

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

  const intervalMs = Math.max(5, config.pollIntervalSeconds) * 1000;
  let timer = null;
  let stopping = false;
  const schedule = () => {
    timer = setTimeout(async () => {
      await tick();
      if (!stopping) schedule();
    }, intervalMs);
  };
  schedule();

  const shutdown = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
