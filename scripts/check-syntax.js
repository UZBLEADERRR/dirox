#!/usr/bin/env node
/**
 * Syntax-check every source file.
 *
 * Cheap insurance for a project with no build step: a typo in a lazily-imported
 * page would otherwise only surface when a user navigated to it.
 */

import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'web', 'tests', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'workspaces']);

async function walk(dir, files = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return files; }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (extname(entry.name) === '.js') files.push(full);
  }
  return files;
}

const files = (await Promise.all(ROOTS.map(root => walk(root)))).flat();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, error: (result.stderr || '').split('\n').slice(0, 3).join(' ') });
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure.file}\n  ${failure.error}`);
  console.error(`\n${failures.length} of ${files.length} files failed to parse.`);
  process.exit(1);
}

console.log(`✓ ${files.length} files parse cleanly.`);
