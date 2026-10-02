import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicJson, withFileLock } from './persistence.js';

function file() { return path.join(config.dataDir, 'user-names.json'); }
function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function cachedName(identifier) {
  const key = String(identifier || '').trim();
  if (!key) return '';
  return read()[key]?.nickname || '';
}

export function rememberUser(info, aliases = []) {
  const user = info?.user || info;
  const nickname = String(user?.nickname || '').trim().slice(0, 100);
  if (!nickname) return;
  const keys = [user?.sec_user_id, user?.sec_uid, user?.uid, user?.unique_id, ...aliases]
    .map(value => String(value || '').trim()).filter(value => value && value.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value));
  if (!keys.length) return;
  withFileLock(file(), () => {
    const data = read();
    for (const key of keys) data[key] = { nickname, updatedAt: Date.now() };
    atomicJson(file(), data);
  });
}
