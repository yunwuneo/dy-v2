import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(__dirname, '..');

// Shell variables take precedence over .env; never evaluate its contents as code.
export function loadEnv(file = path.join(ROOT_DIR, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)?$/.exec(line);
    if (!match || env[match[1]] !== undefined) continue;
    let value = (match[2] || '').trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    env[match[1]] = value;
  }
}
loadEnv();

const DEFAULTS = {
  baseUrl: 'https://api.tikhub.io',
  region: 'CN',               // 请求出口地区，CN 走国内 CDN 下载更快
  outputDir: './downloads',   // 视频保存目录
  count: 20,                  // 每页数量（建议 ≤ 20）
  downloadConcurrency: 3,     // 每个任务的并发作品数
  taskConcurrency: 1,         // 同时执行的后台任务数
  dataDir: './data',
  libraryCacheSeconds: 30,
  pollIntervalSeconds: 300,   // 轮询间隔（秒）
  pollerEnabled: false,       // Web 轮询启停状态
  retry: 3,                   // 请求重试次数
  timeoutMs: 60000,           // 单次请求超时（毫秒）
  logDir: './logs',            // 运行日志目录
  errorDir: './errors',        // 结构化错误报告目录
  cookie: '',                 // 全局抖音 Cookie（收藏列表必须）
  saveMetadata: true,        // 保存作品元数据
  watchers: [],               // 轮询监听目标
};

export const configPath = path.resolve(process.env.DOUYIN_CONFIG || path.join(ROOT_DIR, 'config.json'));

export const SETTINGS = {
  baseUrl: 'string', region: 'region', outputDir: 'string', dataDir: 'string',
  logDir: 'string', errorDir: 'string', count: 'count',
  downloadConcurrency: 'concurrency', taskConcurrency: 'concurrency',
  libraryCacheSeconds: 'positive', pollIntervalSeconds: 'positive', pollerEnabled: 'boolean',
  retry: 'retry', timeoutMs: 'positive', saveMetadata: 'boolean',
};
export const RESTART_FIELDS = ['outputDir', 'dataDir'];
export const configSecrets = new Set();
export const configStatus = { reloadedAt: null, reloadError: null };
const listeners = new Set();

export function validateField(key, value) {
  const kind = SETTINGS[key];
  if (!kind) throw new Error(`未知设置项: ${key}`);
  if (kind === 'boolean') { if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`); return value; }
  if (kind === 'string' || kind === 'region') {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`${key} 不能为空或过长`);
    if (kind === 'region' && !/^[A-Za-z]{2,8}$/.test(value)) throw new Error('region 格式无效');
    if (key === 'baseUrl' && !/^https:\/\//i.test(value)) throw new Error('baseUrl 必须是 HTTPS 地址');
    return value.trim();
  }
  if (!Number.isInteger(value) || value < 0 || value > 86400000) throw new Error(`${key} 必须是有效整数`);
  if (kind === 'concurrency' && (value < 1 || value > 8)) throw new Error(`${key} 必须是 1 到 8`);
  if (kind === 'count' && (value < 1 || value > 200)) throw new Error('count 必须是 1 到 200');
  if (kind === 'positive' && value < 1) throw new Error(`${key} 必须大于 0`);
  if (kind === 'retry' && value > 20) throw new Error('retry 不能超过 20');
  return value;
}

export function normalizeWatchers(input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('监听目标格式无效或数量过多');
  const ids = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('监听目标格式无效');
    const identifier = String(item.identifier || '').trim();
    const name = String(item.name || '').trim();
    const types = item.types?.length ? item.types : ['post'];
    const limit = Number(item.limit ?? 20);
    if (!identifier || identifier.length > 512 || name.length > 100) throw new Error('目标标识不能为空，名称不能超过 100 字');
    if (!Array.isArray(types) || types.some(type => !['post', 'like', 'collect'].includes(type))) throw new Error('请选择有效的内容类型');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('目标数量必须是 1 到 10000');
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('目标启用状态必须是布尔值');
    if (item.cookie !== undefined && (typeof item.cookie !== 'string' || item.cookie.length > 10000)) throw new Error('Cookie 格式无效');
    // Stable IDs for pre-existing config files without rewriting them at startup.
    const id = item.id || crypto.createHash('sha256').update(`${identifier}\0${types.join(',')}\0${index}`).digest('hex').slice(0, 24);
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) throw new Error('目标 ID 格式无效或重复');
    ids.add(id);
    return { id, identifier, name, types: [...new Set(types)], limit, enabled: item.enabled !== false, cookie: item.cookie || '' };
  });
}

function loadConfig() {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      throw new Error(`配置文件解析失败 ${configPath}: ${e.message}`);
    }
  }

  const apiKey = process.env.TIKHUB_API_KEY || userConfig.apiKey || '';
  const merged = { ...DEFAULTS, ...userConfig, apiKey };
  for (const key of Object.keys(SETTINGS)) merged[key] = validateField(key, merged[key]);
  for (const key of ['apiKey', 'cookie']) if (typeof merged[key] !== 'string' || merged[key].length > 10000) throw new Error(`${key} 格式无效`);
  merged.watchers = normalizeWatchers(merged.watchers);
  merged.outputDir = path.resolve(ROOT_DIR, merged.outputDir || DEFAULTS.outputDir);
  merged.logDir = path.resolve(ROOT_DIR, merged.logDir || DEFAULTS.logDir);
  merged.errorDir = path.resolve(ROOT_DIR, merged.errorDir || DEFAULTS.errorDir);
  merged.dataDir = path.resolve(ROOT_DIR, merged.dataDir || DEFAULTS.dataDir);
  for (const secret of [merged.apiKey, merged.cookie, ...merged.watchers.map(w => w.cookie)].filter(Boolean)) configSecrets.add(secret);
  return merged;
}

export const config = loadConfig();

export function subscribeConfig(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function reloadConfig() {
  try {
    const next = loadConfig();
    const changed = [];
    for (const key of [...Object.keys(SETTINGS), 'apiKey', 'cookie', 'watchers']) {
      if (!RESTART_FIELDS.includes(key) && JSON.stringify(next[key]) !== JSON.stringify(config[key])) {
        config[key] = next[key]; changed.push(key);
      }
    }
    configStatus.reloadedAt = new Date().toISOString();
    configStatus.reloadError = null;
    if (changed.length) for (const listener of listeners) listener(changed);
    return changed;
  } catch (error) { configStatus.reloadError = error.message; throw error; }
}

export function watchConfig(onError = () => {}) {
  const listener = () => { try { reloadConfig(); } catch (error) { onError(error); } };
  fs.watchFile(configPath, { interval: 1000, persistent: false }, listener);
  return () => fs.unwatchFile(configPath, listener);
}
