/** Atomic JSON files. A half-written file is worse than a missing one. */

import fs from 'node:fs';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/**
 * A write that coalesces: callers mark dirty as often as they like, the disk
 * sees one write per interval. Returns a flush() for shutdown.
 */
export function debouncedWriter(file, get, ms = 30_000) {
  let dirty = false;
  const flush = () => { if (dirty) { dirty = false; writeJson(file, get()); } };
  const timer = setInterval(flush, ms);
  timer.unref?.();
  return { mark: () => { dirty = true; }, flush };
}
