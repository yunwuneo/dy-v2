import fs from 'node:fs';
import path from 'node:path';
import { config, configSecrets } from './config.js';

const recent = [];
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /cookie|authorization|api.?key|token|password|secret/i.test(key) ? '[REDACTED]' : redact(entry)]));
  if (typeof value !== 'string') return value;
  let result = value;
  for (const secret of [...configSecrets, config.apiKey, config.cookie, config.analysisApiKey, config.analysisAudioApiKey, ...(config.watchers || []).map(w => w.cookie)].filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/([?&](?:cookie|token|api_key|signature)=)[^&\s]+/gi, '$1[REDACTED]');
}
export const recentLogs = (after = 0) => recent.filter(entry => entry.id > after);
let logId = 0;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// MCP 模式下 stdout 必须只输出 JSON-RPC，日志改走 stderr
function useStderr() {
  return process.env.LOG_TO_STDERR === '1';
}

function serializeError(error) {
  if (!error) return null;
  return { name: error.name, message: error.message, code: error.code, router: error.router, stack: error.stack, cause: error.cause?.message };
}

function writeLog(level, args) {
  args = redact(args);
  recent.push({ id: ++logId, time: new Date().toISOString(), level, message: args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ') });
  if (recent.length > 200) recent.shift();
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.appendFileSync(path.join(config.logDir, 'app.log'), `${new Date().toISOString()} [${level}] ${args.map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(' ')}\n`);
  } catch { /* logging must never break the task */ }
}

export function writeErrorReport(kind, error, details = {}) {
  try {
    fs.mkdirSync(config.errorDir, { recursive: true });
    const safeKind = String(kind || 'error').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'error';
    const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(config.errorDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${suffix}_${safeKind}.json`);
    fs.writeFileSync(file, JSON.stringify(redact({ time: new Date().toISOString(), kind: safeKind, error: serializeError(error), ...details }), null, 2));
    return file;
  } catch { return null; }
}

export const log = {
  info: (...args) => { writeLog('INFO', args); (useStderr() ? console.error : console.log)(`[${ts()}] [INFO]`, ...redact(args)); },
  warn: (...args) => { writeLog('WARN', args); console.warn(`[${ts()}] [WARN]`, ...redact(args)); },
  error: (...args) => { writeLog('ERROR', args); console.error(`[${ts()}] [ERROR]`, ...redact(args)); },
  ok: (...args) => { writeLog('OK', args); (useStderr() ? console.error : console.log)(`[${ts()}] [OK]`, ...redact(args)); },
};
