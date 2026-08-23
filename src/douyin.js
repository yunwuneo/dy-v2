import { tikhubRequest, TikHubError } from './tikhub.js';
import { config } from './config.js';
import { log } from './logger.js';

const WEB = '/api/v1/douyin/web';

/**
 * 把用户输入的标识符（抖音号/uid/sec_user_id/链接）归一化为可查询的标识。
 */
export async function resolveUser(identifier) {
  if (!identifier) throw new TikHubError('缺少用户标识', 400);
  // 兼容从浏览器复制的脏输入：剥离 URL 查询参数、锚点与首尾空白
  let id = String(identifier).trim().split(/[?#]/)[0];


  if (/^https?:\/\//i.test(id)) {
    // 主页链接 -> sec_user_id
    if (id.includes('/user/')) {
      const r = await tikhubRequest(`${WEB}/get_sec_user_id`, { query: { url: id } });
      const sec = r?.data?.sec_user_id;
      if (sec) return { sec_user_id: sec };
      throw new TikHubError('无法从链接提取 sec_user_id', 400);
    }
    // 视频/分享链接 -> aweme_id
    if (id.includes('/video/') || id.includes('/note/') || id.includes('v.douyin.com') || id.includes('/share/video/')) {
      const r = await tikhubRequest(`${WEB}/get_aweme_id`, { query: { url: id } });
      const awemeId = r?.data?.aweme_id;
      if (awemeId) return { aweme_id: awemeId };
      throw new TikHubError('无法从链接提取 aweme_id', 400);
    }
  }

  if (/^\d+$/.test(id)) return { uid: id };                    // 纯数字 = uid
  if (id.startsWith('MS4wLjAB')) return { sec_user_id: id };    // sec_user_id 特征前缀
  return { unique_id: id };                                     // 其余按抖音号处理
}

/** 获取用户信息（自动识别标识类型） */
export async function getUserInfo(identifier) {
  const id = identifier && typeof identifier === 'object'
    ? identifier
    : await resolveUser(identifier);
  let r;
  if (id.sec_user_id) {
    r = await tikhubRequest(`${WEB}/handler_user_profile`, { query: { sec_user_id: id.sec_user_id } });
  } else if (id.unique_id) {
    r = await tikhubRequest(`${WEB}/handler_user_profile_v2`, { query: { unique_id: id.unique_id } });
  } else if (id.uid) {
    r = await tikhubRequest(`${WEB}/handler_user_profile_v3`, { query: { uid: id.uid } });
  }
  const data = r?.data;
  return data?.user ?? data ?? {};
}

/**
 * 一次性解析用户标识、资料与 sec_user_id，供同一业务流程复用。
 * 已直接提供 sec_user_id 且不需要资料时，不额外请求用户资料接口。
 */
export async function resolveUserContext(identifier, { includeProfile = true } = {}) {
  const resolved = await resolveUser(identifier);
  if (resolved.sec_user_id && !includeProfile) {
    return { resolved, info: {}, secUserId: resolved.sec_user_id };
  }

  const info = await getUserInfo(resolved);
  const secUserId = resolved.sec_user_id
    || info?.sec_user_id
    || info?.sec_uid
    || info?.sec_user?.sec_uid;
  if (!secUserId) throw new TikHubError('未能解析出 sec_user_id，请检查用户标识是否正确', 400);
  return { resolved, info, secUserId };
}

/** 解析出 sec_user_id（作品/点赞列表都需要它） */
export async function resolveSecUserId(identifier) {
  const context = await resolveUserContext(identifier, { includeProfile: false });
  return context.secUserId;
}

export function isTransientTikHubError(error) {
  if (!(error instanceof TikHubError)) return true;
  const code = Number(error.code);
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

function canFallbackToWeb(error) {
  if (isTransientTikHubError(error)) return true;
  const code = Number(error.code);
  return code === 404 || code === 405 || code === 501;
}

/** 通用分页拉取，fetchPage(cursor) 返回 { aweme_list, has_more, max_cursor } */
async function paginate(fetchPage, { limit = Infinity, maxPages = 200, stopAfterPage = null } = {}) {
  const items = [];
  let cursor = 0;
  let hasMore = true;
  let pages = 0;
  while (hasMore && items.length < limit && pages < maxPages) {
    pages += 1;
    const page = await fetchPage(cursor);
    const list = page?.aweme_list || [];
    items.push(...list);
    if (list.length > 0 && stopAfterPage?.(list, { cursor, pages })) break;
    const more = page?.has_more;
    const nextCursor = page?.max_cursor;
    hasMore = !!more && list.length > 0;
    if (nextCursor === undefined || nextCursor === null || Number(nextCursor) === 0) break;
    cursor = nextCursor;
  }
  return Number.isFinite(limit) ? items.slice(0, limit) : items;
}

/** 用户作品列表：优先 App V3（更稳定），失败降级 Web 版 */
export function listPosts(secUserId, { limit = Infinity, filterType = 0, cookie = '', stopAfterPage = null } = {}) {
  const fetchPageApp = async (cursor) => {
    const r = await tikhubRequest('/api/v1/douyin/app/v3/fetch_user_post_videos', {
      query: { sec_user_id: secUserId, max_cursor: cursor, count: config.count },
    });
    return r?.data ?? {};
  };
  const fetchPageWeb = async (cursor) => {
    const r = await tikhubRequest(`${WEB}/fetch_user_post_videos`, {
      query: {
        sec_user_id: secUserId,
        max_cursor: cursor,
        count: config.count,
        filter_type: filterType,
        cookie: cookie || undefined,
      },
    });
    return r?.data ?? {};
  };
  return paginate(async (cursor) => {
    try {
      return await fetchPageApp(cursor);
    } catch (e) {
      if (!canFallbackToWeb(e)) throw e;
      log.warn(`App V3 作品接口失败（${e.message}），降级 Web 版重试`);
      return fetchPageWeb(cursor);
    }
  }, { limit, stopAfterPage });
}

/** 用户点赞列表：优先 App V3（无需 Cookie），失败降级 Web 版 */
export function listLikes(secUserId, { limit = Infinity, cookie = '', stopAfterPage = null } = {}) {
  const fetchPageApp = async (cursor) => {
    const r = await tikhubRequest('/api/v1/douyin/app/v3/fetch_user_like_videos', {
      query: { sec_user_id: secUserId, max_cursor: cursor, counts: config.count },
    });
    return r?.data ?? {};
  };
  const fetchPageWeb = async (cursor) => {
    const r = await tikhubRequest(`${WEB}/fetch_user_like_videos`, {
      method: 'POST',
      body: { sec_user_id: secUserId, max_cursor: cursor, counts: config.count, ...(cookie ? { cookie } : {}) },
    });
    return r?.data ?? {};
  };
  return paginate(async (cursor) => {
    try {
      return await fetchPageApp(cursor);
    } catch (e) {
      if (!canFallbackToWeb(e)) throw e;
      log.warn(`App V3 点赞接口失败（${e.message}），降级 Web 版重试`);
      return fetchPageWeb(cursor);
    }
  }, { limit, stopAfterPage });
}

/** 用户收藏列表（需要用户自己的抖音 Cookie） */
export function listCollection({ limit = Infinity, cookie = '', stopAfterPage = null } = {}) {
  const ck = cookie || config.cookie;
  if (!ck) {
    throw new TikHubError('收藏列表需要用户自己的抖音网页 Cookie（config.json 的 cookie 或 watcher.cookie）', 400);
  }
  return paginate(async (cursor) => {
    const r = await tikhubRequest(`${WEB}/fetch_user_collection_videos`, {
      method: 'POST',
      body: { cookie: ck, max_cursor: cursor, counts: config.count },
    });
    return r?.data ?? {};
  }, { limit, stopAfterPage });
}

/** 获取单个视频的最高画质（无水印）下载地址（该接口偶发瞬时 400，做业务级重试） */
export async function getVideoDownloadUrl(awemeId) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await tikhubRequest(`${WEB}/fetch_video_high_quality_play_url`, {
        query: { aweme_id: awemeId, region: config.region },
        retries: 1,
      });
      return r?.data ?? {};
    } catch (e) {
      lastErr = e;
      if (!isTransientTikHubError(e)) throw e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 获取单个视频的完整数据 */
export async function getSingleVideo(awemeId) {
  const r = await tikhubRequest(`${WEB}/fetch_one_video`, { query: { aweme_id: awemeId } });
  return r?.data ?? {};
}

/** 从列表项中提取稳定的 aweme_id / 标题 / 创建时间 / 类型与图片地址（兼容不同列表项结构） */
export function awemeMeta(item) {
  const aweme = item?.aweme ?? item;
  const awemeId = aweme?.aweme_id ?? item?.aweme_id ?? item?.item_id;
  const desc = String(aweme?.desc ?? item?.desc ?? '').trim();
  const createTime = Number(aweme?.create_time ?? item?.create_time ?? 0);
  const cover = aweme?.video?.cover?.url_list?.[0] ?? '';
  // 图集/图片帖：images 数组非空（通常 media_type=2/42）
  const rawImages = Array.isArray(aweme?.images) ? aweme.images : [];
  const isImagePost = rawImages.length > 0;
  // 每张图挑选最佳 URL：优先非 HEIC 格式（兼容性更好），否则退回第一个
  const imageUrls = rawImages.map((img) => {
    const urls = img?.url_list ?? [];
    return urls.find((u) => !/\.(heic|hif)(\?|$)/i.test(u)) || urls[0] || '';
  });
  return { awemeId, desc, createTime, cover, isImagePost, imageUrls };
}

/**
 * 从原始作品数据提取用于本地归档的元数据 JSON（容错：任何字段缺失都安全跳过）。
 * 只保留对后续管理有意义的稳定字段；CDN 签名地址时效短，除封面外不存原始媒体地址。
 */
export function extractMetadata(item) {
  const aweme = item?.aweme ?? item;
  const base = awemeMeta(item);
  const createTimeMs = base.createTime > 0 ? base.createTime * 1000 : 0;
  const statsSrc = aweme?.statistics ?? aweme?.stats ?? {};
  const author = aweme?.author ?? {};
  const video = aweme?.video ?? {};
  const music = aweme?.music ?? {};

  return {
    aweme_id: base.awemeId,
    desc: base.desc,
    kind: base.isImagePost ? 'album' : 'video',
    create_time: base.createTime > 0 ? base.createTime : undefined,            // Unix 秒
    create_time_iso: createTimeMs ? new Date(createTimeMs).toISOString() : undefined,
    duration_ms: Number(video.duration) > 0 ? Number(video.duration) : undefined, // 视频时长（毫秒），图集无
    is_top: Boolean(aweme?.is_top ?? item?.is_top),                            // 是否置顶（作品列表有效）
    is_image_post: base.isImagePost,
    image_count: base.isImagePost ? base.imageUrls.length : 0,
    image_urls: base.isImagePost ? base.imageUrls : undefined,
    cover: base.cover || undefined,
    author: {
      sec_uid: author.sec_uid || undefined,
      uid: author.uid || undefined,
      unique_id: author.unique_id || undefined,   // 抖音号
      nickname: author.nickname || undefined,
    },
    statistics: {
      digg_count: statsSrc.digg_count,            // 点赞
      comment_count: statsSrc.comment_count,      // 评论
      share_count: statsSrc.share_count,          // 分享
      collect_count: statsSrc.collect_count,      // 收藏
      play_count: statsSrc.play_count,            // 播放（部分接口不返回）
    },
    music: music.title ? { title: music.title, author: music.author || '' } : undefined,
    share_url: aweme?.share_info?.share_url || undefined,
  };
}

export { paginate };
