import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

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
    fs.writeFileSync(file, JSON.stringify({ time: new Date().toISOString(), kind: safeKind, error: serializeError(error), ...details }, null, 2));
    return file;
  } catch { return null; }
}

export const log = {
  info: (...args) => { writeLog('INFO', args); (useStderr() ? console.error : console.log)(`[${ts()}] [INFO]`, ...args); },
  warn: (...args) => { writeLog('WARN', args); console.warn(`[${ts()}] [WARN]`, ...args); },
  error: (...args) => { writeLog('ERROR', args); console.error(`[${ts()}] [ERROR]`, ...args); },
  ok: (...args) => { writeLog('OK', args); (useStderr() ? console.error : console.log)(`[${ts()}] [OK]`, ...args); },
};
