function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// MCP 模式下 stdout 必须只输出 JSON-RPC，日志改走 stderr
function useStderr() {
  return process.env.LOG_TO_STDERR === '1';
}

export const log = {
  info: (...args) => (useStderr() ? console.error : console.log)(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
  ok: (...args) => (useStderr() ? console.error : console.log)(`[${ts()}] [OK]`, ...args),
};
