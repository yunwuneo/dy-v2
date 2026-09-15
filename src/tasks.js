import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log, writeErrorReport } from './logger.js';
import {
  getUserInfo,
  resolveUser,
  resolveSecUserId,
  resolveUserContext,
  listPosts,
  listLikes,
  listCollection,
  getVideoDownloadUrl,
  getSingleVideo,
  awemeMeta,
  extractMetadata,
  isTransientTikHubError,
} from './douyin.js';
import { downloadToFile, downloadImageToFile, detectMediaExtension, writeJsonFile, buildTargetPath } from './downloader.js';
import { Store } from './store.js';

export const TYPE_LABEL = { post: '作品', like: '点赞', collect: '收藏' };
export const VALID_TYPES = Object.keys(TYPE_LABEL);

export function normalizeType(type) {
  const t = String(type || 'post').toLowerCase();
  return VALID_TYPES.includes(t) ? t : 'post';
}

/** 是否保存作品元数据 JSON（config.saveMetadata，默认开启） */
function saveMetaEnabled() {
  return config.saveMetadata !== false;
}

/** 计算某作品的元数据 JSON 落盘路径：视频与 .mp4 同名，图集为目录内 metadata.json */
function metadataDestPath(userName, typeLabel, base) {
  const { dir, file } = buildTargetPath(userName, typeLabel, base.awemeId, base.desc);
  return base.isImagePost
    ? path.join(file.replace(/\.[^.]+$/, ''), 'metadata.json')
    : file.replace(/\.mp4$/i, '.json');
}

/**
 * 保存作品元数据 JSON（失败仅告警，绝不中断下载主流程）。
 * rawItem 为 API 返回的原始作品对象；target 传 { file } 或 { dir } 决定落盘位置；
 * local 为附加的本地落盘信息（实际文件路径/大小/时间），便于后续管理。
 * @returns 实际写入路径；未写入返回 null
 */
function saveMetadata(rawItem, target, local = {}) {
  if (!saveMetaEnabled()) return null;
  try {
    const meta = extractMetadata(rawItem);
    if (!meta.aweme_id) return null;
    meta.local = { ...local };
    const dest = target.file
      ? target.file.replace(/\.mp4$/i, '.json')
      : path.join(target.dir, 'metadata.json');
    if (writeJsonFile(dest, meta)) {
      log.ok(`  ↳ 元数据已保存: ${path.basename(dest)}`);
      return dest;
    }
    return null;
  } catch (e) {
    log.warn(`保存元数据失败: ${e.message}`);
    return null;
  }
}

/**
 * 存量回填：为已下载但缺少元数据 JSON 的作品补写（幂等，媒体文件必须真实存在）。
 * @returns true 表示本次实际补写了元数据
 */
function backfillMetadata(rawItem, userName, typeLabel) {
  if (!saveMetaEnabled()) return false;
  try {
    const base = awemeMeta(rawItem);
    if (!base.awemeId) return false;
    const dest = metadataDestPath(userName, typeLabel, base);
    if (fs.existsSync(dest)) return false;

    if (base.isImagePost) {
      const albumDir = path.dirname(dest);
      if (!fs.existsSync(albumDir)) return false; // 仅当图集目录确实存在时才回填，避免生成孤立 JSON
      const files = fs.readdirSync(albumDir)
        .filter((n) => /^img_\d+\./.test(n))
        .sort()
        .map((n) => {
          const p = path.join(albumDir, n);
          return { file: p, size: fs.statSync(p).size };
        });
      log.info(`[回填元数据] ${base.desc || base.awemeId}`);
      return !!saveMetadata(rawItem, { dir: albumDir }, {
        files,
        total_size: files.reduce((s, f) => s + f.size, 0),
        downloaded_at: fs.statSync(albumDir).mtime.toISOString(),
        backfilled_at: new Date().toISOString(),
      });
    }

    if (!fs.existsSync(dest.replace(/\.json$/i, '.mp4'))) return false; // 仅当视频文件存在时才回填
    const file = dest.replace(/\.json$/i, '.mp4');
    log.info(`[回填元数据] ${base.desc || base.awemeId}`);
    return !!saveMetadata(rawItem, { file }, {
      file,
      size: fs.statSync(file).size,
      downloaded_at: fs.statSync(file).mtime.toISOString(),
      backfilled_at: new Date().toISOString(),
    });
  } catch {
    return false; // 回填失败不影响主流程
  }
}

/** 查询用户信息，返回归一化字段 */
function normalizeUserInfo(info) {
  return {
    nickname: info?.nickname ?? info?.user?.nickname ?? '',
    unique_id: info?.unique_id ?? info?.user?.unique_id ?? '',
    sec_user_id: info?.sec_user_id ?? info?.sec_uid ?? info?.user?.sec_uid ?? '',
    uid: info?.uid ?? info?.user?.uid ?? '',
    signature: info?.signature ?? '',
    follower_count: info?.follower_count ?? info?.mplatform_followers_count ?? 0,
    following_count: info?.following_count ?? 0,
    aweme_count: info?.aweme_count ?? 0,
    total_favorited: info?.total_favorited ?? 0,
    raw: info,
  };
}

export async function queryUser(identifier) {
  const info = await getUserInfo(identifier);
  return normalizeUserInfo(info);
}

function summarizeVideos(list) {
  return list.map((item) => {
    const meta = awemeMeta(item);
    return {
      aweme_id: meta.awemeId,
      desc: meta.desc,
      create_time: meta.createTime,
      cover: meta.cover,
      is_image_post: meta.isImagePost,
      image_count: meta.imageUrls.length,
    };
  });
}

function embeddedVideoUrl(item) {
  const aweme = item?.aweme ?? item;
  const candidates = [
    ...(aweme?.video?.play_addr?.url_list || []),
    ...(aweme?.video?.download_addr?.url_list || []),
    ...(aweme?.video?.bit_rate || []).flatMap((rate) => rate?.play_addr?.url_list || []),
  ];
  return candidates.find((url) => typeof url === 'string' && /^https?:\/\//i.test(url)) || '';
}

/** 拉取一次可供展示或下载复用的原始批次。 */
export async function prepareVideoBatch({
  identifier,
  type = 'post',
  limit = 20,
  cookie = '',
  userContext = null,
  secUserId: knownSecUserId = '',
  userName: knownUserName = '',
  includeProfile = true,
  knownStore = null,
  stopAtKnown = false,
} = {}) {
  const t = normalizeType(type);
  const ck = cookie || config.cookie || '';
  const label = TYPE_LABEL[t];

  const createBoundaryCheck = (userKey) => {
    if (!stopAtKnown || !knownStore) return { stopAfterPage: null, reached: () => false };
    let boundaryReached = false;
    return {
      stopAfterPage: (pageItems) => {
        boundaryReached = pageItems.some((item) => {
          const awemeId = awemeMeta(item).awemeId;
          return awemeId && knownStore.has(userKey, t, awemeId);
        });
        if (boundaryReached) log.info(`[增量] ${label}已到达本地下载边界，停止继续翻页`);
        return boundaryReached;
      },
      reached: () => boundaryReached,
    };
  };

  if (t === 'collect') {
    const boundary = createBoundaryCheck('self');
    const list = await listCollection({ limit, cookie: ck, stopAfterPage: boundary.stopAfterPage });
    return {
      type: t,
      label,
      secUserId: 'self',
      userName: knownUserName || '我的收藏',
      info: null,
      list,
      stoppedAtKnown: boundary.reached(),
    };
  }

  let context = userContext;
  if (!context && knownSecUserId) {
    context = { secUserId: knownSecUserId, info: {} };
  }
  if (!context) {
    context = knownUserName
      ? { secUserId: await resolveSecUserId(identifier), info: {} }
      : await resolveUserContext(identifier, { includeProfile });
  }

  const boundary = createBoundaryCheck(context.secUserId);
  const list = t === 'post'
    ? await listPosts(context.secUserId, { limit, cookie: ck, stopAfterPage: boundary.stopAfterPage })
    : await listLikes(context.secUserId, { limit, cookie: ck, stopAfterPage: boundary.stopAfterPage });
  const info = context.info || {};
  const userName = knownUserName || info?.nickname || info?.user?.nickname || context.secUserId;
  return {
    type: t,
    label,
    secUserId: context.secUserId,
    userName,
    info,
    list,
    stoppedAtKnown: boundary.reached(),
  };
}

/** Web 查询一次返回资料和列表，并保留可直接下载的原始批次。 */
export async function lookupVideos(options = {}) {
  const prepared = await prepareVideoBatch(options);
  return {
    user: prepared.info ? normalizeUserInfo(prepared.info) : null,
    videos: summarizeVideos(prepared.list),
    prepared,
  };
}

/** 列出某用户某类型的视频/图集（返回元数据列表） */
export async function listVideos({ identifier, type = 'post', limit = 20, cookie = '' } = {}) {
  const prepared = await prepareVideoBatch({ identifier, type, limit, cookie, includeProfile: false });
  return summarizeVideos(prepared.list);
}

/** 下载单个图集的全部图片到目录，返回结果 */
async function downloadAlbum({ awemeId, desc, userName, typeLabel, imageUrls, rawItem = null }) {
  const { dir, file: firstFile } = buildTargetPath(userName, typeLabel, awemeId, desc);
  // 去掉 .mp4 后缀作为图集目录：<用户>/<类型>/<标题>_<awemeId>/
  const albumDir = firstFile.replace(/\.[^.]+$/, '');
  fs.mkdirSync(albumDir, { recursive: true });
  const files = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (!url) continue;
    const prefix = `img_${String(i + 1).padStart(2, '0')}`;
    const existing = fs.readdirSync(albumDir, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.startsWith(`${prefix}.`));
    if (existing) {
      let imgPath = path.join(albumDir, existing.name);
      const fd = fs.openSync(imgPath, 'r');
      const header = Buffer.alloc(32);
      try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      const actualExt = detectMediaExtension(header, '', imgPath);
      const currentExt = path.extname(imgPath).toLowerCase();
      if (actualExt && actualExt !== currentExt) {
        const corrected = path.join(albumDir, `${prefix}${actualExt}`);
        if (!fs.existsSync(corrected)) fs.renameSync(imgPath, corrected);
        imgPath = corrected;
      }
      files.push({ file: imgPath, size: fs.statSync(imgPath).size });
    } else {
      files.push(await downloadImageToFile(url, albumDir, i + 1));
    }
  }
  // 图集元数据保存到图集目录内：metadata.json（与图片同级）
  if (rawItem) {
    const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
    saveMetadata(rawItem, { dir: albumDir }, {
      files: files.map((f) => ({ file: f.file, size: f.size })),
      total_size: totalSize,
      downloaded_at: new Date().toISOString(),
    });
  }
  return { dir: albumDir, files };
}

/** 下载单个作品（视频或图集），awemeId 或分享链接均可 */
export async function downloadSingle(identifier) {
  let awemeId = identifier;
  const resolved = await resolveUser(identifier);
  if (resolved.aweme_id) awemeId = resolved.aweme_id;

  let detail = {};
  try {
    detail = await getSingleVideo(awemeId);
  } catch (error) {
    if (!isTransientTikHubError(error)) throw error;
  }
  const aweme = detail?.aweme_detail ?? detail?.aweme ?? detail ?? {};
  const desc = String(aweme?.desc ?? detail?.desc ?? '').trim();
  const nickname = aweme?.author?.nickname || detail?.author?.nickname || '';
  const meta = awemeMeta(aweme);

  // 图集：从详情中提取全部图片并下载
  if (meta.isImagePost && meta.imageUrls.length > 0) {
    const album = await downloadAlbum({
      awemeId,
      desc,
      userName: nickname || '单视频',
      typeLabel: nickname ? '单视频' : '',
      imageUrls: meta.imageUrls,
      rawItem: aweme,
    });
    const totalSize = album.files.reduce((s, f) => s + f.size, 0);
    return {
      aweme_id: awemeId,
      kind: 'album',
      desc,
      dir: album.dir,
      count: album.files.length,
      files: album.files.map((f) => f.file),
      size: totalSize,
    };
  }

  const { dir, file } = buildTargetPath(nickname || '单视频', nickname ? '单视频' : '', awemeId, desc || awemeId);
  if (fs.existsSync(file)) {
    // 视频已存在：若缺元数据 JSON 则补写，无需再请求高清播放地址。
    const jsonFile = file.replace(/\.mp4$/i, '.json');
    let metadataBackfilled = false;
    if (!fs.existsSync(jsonFile)) {
      metadataBackfilled = !!saveMetadata(aweme, { file }, {
        file,
        size: fs.statSync(file).size,
        downloaded_at: fs.statSync(file).mtime.toISOString(),
        backfilled_at: new Date().toISOString(),
      });
    }
    return { aweme_id: awemeId, kind: 'video', desc, file, dir, size: fs.statSync(file).size, existed: true, metadata_backfilled: metadataBackfilled };
  }

  let info = {};
  let url = '';
  try {
    info = await getVideoDownloadUrl(awemeId);
    url = info?.original_video_url || info?.video_url || info?.url || '';
  } catch (error) {
    url = embeddedVideoUrl(aweme);
    if (!url) throw error;
    log.warn(`[单视频] ${awemeId} 高清地址接口失败，改用详情内播放地址: ${error.message}`);
  }
  if (!url) throw new Error(`未获取到下载地址: ${awemeId}`);
  const size = await downloadToFile(url, file);
  saveMetadata(aweme, { file }, { file, size, downloaded_at: new Date().toISOString() });
  return { aweme_id: awemeId, kind: 'video', desc, file, dir, size, url };
}

/** 下载某用户某类型的全部（或前 N 个）作品，自动区分视频与图集 */
export async function downloadVideos({
  identifier,
  type = 'post',
  limit = Infinity,
  cookie = '',
  prepared = null,
  userContext = null,
  secUserId = '',
  userName = '',
  store: providedStore = null,
} = {}) {
  const store = providedStore || new Store();
  let batch;
  try {
    batch = prepared || await prepareVideoBatch({
      identifier,
      type,
      limit,
      cookie,
      userContext,
      secUserId,
      userName,
      knownStore: store,
      stopAtKnown: true,
    });
  } catch (e) {
    throw new Error(`解析用户失败: ${e.message}`);
  }

  const t = batch.type;
  const label = batch.label;
  secUserId = batch.secUserId;
  userName = batch.userName;

  const userKey = secUserId || 'self';

  const list = batch.list;

  const stats = {
    type: t,
    label,
    total: list.length,
    downloaded: 0,
    skipped: 0,
    metadata_backfilled: 0,
    failed: 0,
    stopped_at_known: Boolean(batch.stoppedAtKnown),
    files: [],
  };

  for (const item of list) {
    const meta = awemeMeta(item);
    if (!meta.awemeId) continue;

    // 已下载在案：增量跳过；若发现缺少元数据 JSON 则顺带补写（存量回填）
    if (store.has(userKey, t, meta.awemeId)) {
      if (backfillMetadata(item, userName, label)) stats.metadata_backfilled += 1;
      else stats.skipped += 1;
      continue;
    }

    try {
      if (meta.isImagePost) {
        // ── 图集/图片帖：直接下载列表里的图片地址，不产生额外 API 费用 ──
        if (meta.imageUrls.length === 0) throw new Error('图集无可用图片地址');

        const album = await downloadAlbum({
          awemeId: meta.awemeId,
          desc: meta.desc,
          userName,
          typeLabel: label,
          imageUrls: meta.imageUrls,
          rawItem: item,
        });
        store.mark(userKey, t, meta.awemeId);
        stats.downloaded += 1;
        const totalSize = album.files.reduce((s, f) => s + f.size, 0);
        stats.files.push({ aweme_id: meta.awemeId, kind: 'album', desc: meta.desc, dir: album.dir, count: album.files.length, size: totalSize });
        log.ok(`[图集] ${meta.desc || meta.awemeId}  (${album.files.length} 张图片)`);
        continue;
      }

      // ── 普通视频 ──
      let info = {};
      let url = '';
      try {
        info = await getVideoDownloadUrl(meta.awemeId);
        url = info?.original_video_url || info?.video_url || info?.url || '';
      } catch (error) {
        url = embeddedVideoUrl(item);
        if (!url) throw error;
        log.warn(`[${label}] ${meta.awemeId} 高清地址接口失败，改用列表内播放地址: ${error.message}`);
      }
      if (!url) { stats.failed += 1; log.warn(`[${label}] ${meta.awemeId} 无下载地址`); continue; }

      const { file, dir } = buildTargetPath(userName, label, meta.awemeId, meta.desc);
      if (fs.existsSync(file)) {
        saveMetadata(item, { file }, { file, size: fs.statSync(file).size, downloaded_at: fs.statSync(file).mtime.toISOString() });
        store.mark(userKey, t, meta.awemeId);
        stats.skipped += 1;
        continue;
      }
      const size = await downloadToFile(url, file);
      saveMetadata(item, { file }, { file, size, downloaded_at: new Date().toISOString() });
      store.mark(userKey, t, meta.awemeId);
      stats.downloaded += 1;
      stats.files.push({ aweme_id: meta.awemeId, kind: 'video', desc: meta.desc, file, size });
      log.ok(`[视频] ${meta.desc || meta.awemeId}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (e) {
      stats.failed += 1;
      const report = writeErrorReport('item-download', e, { label, awemeId: meta.awemeId, desc: meta.desc, userName, type: t });
      log.error(`[${label}] ${meta.awemeId} 下载失败: ${e.message}${report ? `（详情: ${report}）` : ''}`);
    }
  }

  return stats;
}
