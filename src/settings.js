import fs from 'node:fs';
import path from 'node:path';
import { config, configPath, ROOT_DIR, SETTINGS, RESTART_FIELDS, validateField, normalizeWatchers, reloadConfig, configStatus } from './config.js';
import { atomicJson, withFileLock } from './persistence.js';
import { cachedName } from './profile-cache.js';

export { SETTINGS };

function read() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function publicSettings() {
  let saved = {};
  try { if (!configStatus.reloadError) saved = read(); } catch (error) { configStatus.reloadError = error.message; }
  const fields = {};
  for (const key of Object.keys(SETTINGS)) fields[key] = saved[key] ?? config[key];
  const restartFields = RESTART_FIELDS.filter(key => path.resolve(ROOT_DIR, String(fields[key])) !== config[key]);
  return {
    fields,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyFromEnv: Boolean(process.env.TIKHUB_API_KEY),
    cookieConfigured: Boolean(config.cookie),
    watchers: config.watchers.map(({ cookie, ...watcher }) => ({ ...watcher, cachedName: cachedName(watcher.identifier), cookieConfigured: Boolean(cookie) })),
    restartRequired: restartFields.length > 0, restartFields,
    reloadError: configStatus.reloadError,
  };
}

export function saveSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
  if (input.fields && (typeof input.fields !== 'object' || Array.isArray(input.fields))) throw new Error('设置格式无效');
  const fields = Object.fromEntries(Object.entries(input.fields || {}).map(([key, value]) => [key, validateField(key, value)]));
  for (const key of ['apiKey', 'cookie']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 10000)) throw new Error(`${key} 格式无效`);
  if (input.clearApiKey && input.apiKey) throw new Error('不能同时填写并清除 API Key');
  if (input.clearCookie && input.cookie) throw new Error('不能同时填写并清除 Cookie');
  withFileLock(configPath, () => {
    const saved = read();
    Object.assign(saved, fields);
    for (const key of ['apiKey', 'cookie']) if (input[key]) saved[key] = input[key];
    if (input.clearApiKey) delete saved.apiKey;
    if (input.clearCookie) delete saved.cookie;
    atomicJson(configPath, saved);
  });
  reloadConfig();
  return publicSettings();
}

export function saveWatchers(input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('监听目标格式无效或数量过多');
  const pending = input.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('监听目标格式无效');
    const identifier = String(item.identifier || '').trim();
    const name = String(item.name || '').trim();
    const types = item.types;
    const limit = Number(item.limit);
    if (!identifier || identifier.length > 512 || name.length > 100) throw new Error('目标标识不能为空，名称不能超过 100 字');
    if (!Array.isArray(types) || !types.length || types.some(type => !['post', 'like', 'collect'].includes(type))) throw new Error('请选择有效的内容类型');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('目标数量必须是 1 到 10000');
    const cookie = typeof item.cookie === 'string' ? item.cookie : '';
    if (cookie.length > 10000) throw new Error('Cookie 过长');
    if (item.clearCookie && cookie) throw new Error('不能同时填写并清除目标 Cookie');
    return { id: item.id, identifier, name, types: [...new Set(types)], limit, enabled: item.enabled, cookie, clearCookie: Boolean(item.clearCookie) };
  });
  withFileLock(configPath, () => {
    const saved = read();
    const previous = normalizeWatchers(saved.watchers ?? config.watchers);
    pending.forEach((item) => {
      const old = previous.find(old => item.id ? old.id === item.id : old.identifier === item.identifier);
      item.id ||= old?.id;
      if (!item.cookie && !item.clearCookie) item.cookie = old?.cookie || '';
      delete item.clearCookie;
    });
    saved.watchers = normalizeWatchers(pending);
    atomicJson(configPath, saved);
  });
  reloadConfig();
  return publicSettings();
}

export function savedWatcher(index) { return config.watchers[index]; }
