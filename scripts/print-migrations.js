#!/usr/bin/env node
/**
 * Print every migration in order, so the whole schema can be pasted into the
 * Supabase SQL editor in one go.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = 'db/migrations';
const files = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();

if (!files.length) {
  console.error('No migrations found in db/migrations.');
  process.exit(1);
}

for (const file of files) {
  console.log(`\n-- ${'='.repeat(74)}`);
  console.log(`-- ${file}`);
  console.log(`-- ${'='.repeat(74)}\n`);
  console.log(await readFile(join(dir, file), 'utf8'));
}
