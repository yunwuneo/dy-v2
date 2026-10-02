import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.part`;
  try {
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// Serializes short local disk mutations across CLI, HTTP and watcher processes.
export function acquireFileLock(file, { timeoutMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        }
      } catch (probe) { if (probe.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error(`存储正忙，请稍后重试: ${path.basename(file)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  let released = false;
  return () => { if (!released) { released = true; fs.closeSync(fd); fs.unlinkSync(lock); } };
}

export function withFileLock(file, fn) {
  const release = acquireFileLock(file);
  try { return fn(); } finally { release(); }
}
