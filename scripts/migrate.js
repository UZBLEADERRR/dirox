#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   node scripts/migrate.js            apply everything pending
 *   node scripts/migrate.js status     show what is applied and what is not
 *   node scripts/migrate.js --dry-run  list what would be applied
 *
 * Reads DATABASE_URL, or takes a connection string as the last argument.
 */

import { migrate, status } from '../src/db/migrate.js';

const args = process.argv.slice(2);
const command = args.find(arg => !arg.startsWith('-')) || 'up';
const dryRun = args.includes('--dry-run');
const connectionString = args.find(arg => arg.startsWith('postgres')) || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('No connection string. Set DATABASE_URL, or pass one as an argument.\n');
  console.error('  Supabase → Project Settings → Database → Connection string → Session pooler');
  console.error('  It looks like: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n');
  process.exit(1);
}

const redacted = connectionString.replace(/:\/\/([^:]+):[^@]+@/, '://$1:••••@');

try {
  if (command === 'status') {
    const report = await status(connectionString);
    console.log(`\n  ${redacted}\n`);
    console.log(`  applied  ${report.applied} of ${report.total}`);
    if (report.pending.length) {
      console.log(`  pending  ${report.pending.length}`);
      for (const file of report.pending) console.log(`             ${file}`);
    }
    if (report.drifted.length) {
      console.log(`\n  These files changed after they were applied:`);
      for (const file of report.drifted) console.log(`    ! ${file}`);
      console.log('    An applied migration should not be edited. Add a new one instead.');
    }
    if (!report.pending.length && !report.drifted.length) console.log('\n  The schema is up to date.');
    console.log('');
    process.exit(report.drifted.length ? 1 : 0);
  }

  console.log(`\n  ${redacted}`);
  console.log(dryRun ? '  dry run — nothing will be written\n' : '');

  const result = await migrate(connectionString, {
    dryRun,
    onProgress: ({ filename, state, durationMs }) => {
      if (state === 'applying') process.stdout.write(`  … ${filename}`);
      if (state === 'applied') process.stdout.write(`\r  ✓ ${filename} (${durationMs}ms)\n`);
    }
  });

  if (dryRun) {
    if (result.applied.length) {
      console.log('  would apply:');
      for (const file of result.applied) console.log(`    ${file}`);
    } else {
      console.log('  nothing to apply — the schema is up to date');
    }
  } else if (result.applied.length) {
    console.log(`\n  applied ${result.applied.length} migration${result.applied.length === 1 ? '' : 's'} in ${result.durationMs}ms`);
  } else {
    console.log('  the schema is already up to date');
  }

  if (result.drifted.length) {
    console.log('\n  Warning — these files changed after they were applied:');
    for (const file of result.drifted) console.log(`    ! ${file}`);
    console.log('  An applied migration should not be edited. Add a new one instead.');
  }
  console.log('');
} catch (error) {
  console.error(`\n  ✗ ${error.message}\n`);
  if (error.details?.hint) console.error(`  hint: ${error.details.hint}`);
  if (error.details?.detail) console.error(`  detail: ${error.details.detail}`);
  console.error('');
  process.exit(1);
}
