import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const context = new AsyncLocalStorage();
export const runWithExecution = (options, fn) => context.run(options, fn);
export const executionSignal = () => context.getStore()?.signal;
export const checkCancelled = () => executionSignal()?.throwIfAborted();
export const sleep = (ms) => delay(ms, undefined, { signal: executionSignal() });

export async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  checkCancelled();
  const controller = new AbortController();
  const parent = executionSignal();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  // Keep the timeout and cancellation active until the response body is consumed.
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, signal: controller.signal, release: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
  } catch (error) {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    throw error;
  }
}

// Media transfers may take hours; only a stalled connection should time out.
export async function fetchWithIdleTimeout(url, options = {}, idleMs = 60000) {
  checkCancelled();
  const controller = new AbortController();
  const parent = executionSignal();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  let timer;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const touch = (delayMs = idleMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new DOMException('媒体连接长时间无数据', 'TimeoutError');
      controller.abort(error);
      rejectTimeout(error);
    }, delayMs);
  };
  const release = () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); };
  const firstByteMs = Math.min(idleMs, 30000);
  touch(firstByteMs);
  try {
    const response = await Promise.race([fetch(url, { ...options, signal: controller.signal }), timeout]);
    touch(firstByteMs);
    return { response, signal: controller.signal, touch, timeout, release };
  } catch (error) {
    release();
    throw error;
  }
}

const locks = new Map();
export async function withKeyLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  try { await previous; checkCancelled(); return await fn(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure;
  const worker = async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { checkCancelled(); results[index] = await fn(items[index], index); }
      catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1))) }, worker));
  if (failure) throw failure;
  return results;
}
