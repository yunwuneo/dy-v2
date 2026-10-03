import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './logger.js';

const bridge = fileURLToPath(new URL('../scripts/analyze-video.py', import.meta.url));

// Resolve only after the entire process has exited, so stop/start cannot overlap workers.
export function runVideoAnalysis({ target, settings, signal, report, executable = settings.analysisPython, args = ['-u', bridge] }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-analysis-'));
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let buffer = '', stderr = '', result, failure, timedOut = false;
    let killer;
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        // Python may be waiting for FFmpeg; terminate its descendants as well.
        killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    const timeout = setTimeout(() => { timedOut = true; kill(); }, settings.analysisTimeoutSeconds * 1000);
    const parseLine = line => {
      if (!line.startsWith('DY_ANALYSIS:')) return;
      try {
        const event = JSON.parse(line.slice(12));
        if (event.type === 'progress') report(event);
        if (event.type === 'result') result = event.result;
        if (event.type === 'error') failure = new Error(redact(event.message));
      } catch (error) { failure = error; }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) { parseLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 2e6) { failure = new Error('分析输出过大'); kill(); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {}); // spawn failure / early exit may close stdin.
    child.once('error', error => { failure = new Error(`无法启动分析 Python：${error.message}。请安装 video-analyzer 并在设置中选择对应 Python。`); });
    child.once('close', code => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', kill);
      // This exact directory was allocated above; never delete a path supplied by the child.
      if (path.dirname(path.resolve(workDir)) === path.resolve(os.tmpdir()) && path.basename(workDir).startsWith('dy-analysis-')) {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* locked files can be reclaimed from OS temp */ }
      }
      if (buffer) parseLine(buffer);
      if (signal.aborted) return reject(signal.reason);
      if (timedOut) return reject(new Error('分析超时，可调整分析超时后重试'));
      if (failure) return reject(failure);
      if (code !== 0 || !result) return reject(new Error(redact(`分析进程失败 (${code})：${stderr || '未返回结果'}`)));
      resolve(result);
    });
    // Secrets travel through stdin, never through process arguments or a temporary config.
    child.stdin.end(JSON.stringify({ target, settings, workDir }));
  });
}
