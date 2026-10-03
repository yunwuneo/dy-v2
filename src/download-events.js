const listeners = new Set();
export function onVideoDownloaded(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function videoDownloaded(file) { for (const listener of listeners) listener(file); }
