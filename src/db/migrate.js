/**
 * Migration runner.
 *
 * Applies `db/migrations/*.sql` in filename order over a direct Postgres
 * connection, so an operator supplies a connection string instead of pasting
 * SQL into a dashboard.
 *
 * Safety properties:
 *   - A session advisory lock means several instances booting at once cannot
 *     apply the same migration twice; the others wait, then find nothing to do.
 *   - Each file runs inside its own transaction. A failure rolls that file back
 *     whole, so the schema is never left half-applied.
 *   - Applied files are recorded with a checksum. If a file changes after it
 *     was applied the runner says so rather than silently ignoring it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresClient, parseConnectionString } from './pg.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

// An arbitrary but fixed key, so every DiroxCode instance contends on the same lock.
const ADVISORY_LOCK_KEY = 0x4449524f;   // "DIRO"

const LEDGER = `
create table if not exists schema_migrations (
  filename    text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer not null default 0
)`;

function checksumOf(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 32);
}

export async function readMigrations() {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async filename => {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    return { filename, sql, checksum: checksumOf(sql) };
  }));
}

/**
 * Supabase offers three connection modes and only two can run migrations.
 *
 * The transaction pooler (port 6543) hands out a different backend per
 * statement, so advisory locks and multi-statement transactions do not hold.
 * Detecting that here produces a clear instruction instead of a confusing
 * failure part-way through the schema.
 */
export function checkConnectionMode(config) {
  if (config.port === 6543) {
    throw new AppError(
      'This is the Supabase transaction pooler (port 6543), which cannot run migrations: ' +
      'it gives each statement a different connection, so transactions and locks do not hold. ' +
      'Use the session pooler (port 5432) or the direct connection string instead — ' +
      'Supabase → Project Settings → Database → Connection string → Session pooler.',
      { status: 400, code: 'wrong_pooler_mode' }
    );
  }
  return true;
}

/**
 * Apply every pending migration.
 *
 * @param {string} connectionString
 * @param {{ dryRun?:boolean, onProgress?:Function }} options
 * @returns {Promise<{applied:string[], skipped:string[], drifted:string[], durationMs:number}>}
 */
export async function migrate(connectionString, { dryRun = false, onProgress } = {}) {
  const config = parseConnectionString(connectionString);
  checkConnectionMode(config);

  const files = await readMigrations();
  if (!files.length) throw new AppError('No migration files were found', { status: 500, code: 'no_migrations' });

  const started = Date.now();
  const client = new PostgresClient(config);

  // Migrations legitimately emit a great many notices; only surface problems.
  client.onNotice = notice => {
    if (notice.severity === 'WARNING') logger.warn('migration warning', { message: notice.message });
  };

  await client.connect();

  const applied = [];
  const skipped = [];
  const drifted = [];
  let locked = false;

  try {
    await client.query(LEDGER);

    // Wait for any other instance that is mid-migration.
    await client.query(`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    locked = true;

    const [{ rows }] = await client.query('select filename, checksum from schema_migrations');
    const known = new Map(rows.map(row => [row.filename, row.checksum]));

    for (const file of files) {
      const recorded = known.get(file.filename);

      if (recorded) {
        if (recorded !== file.checksum) {
          drifted.push(file.filename);
          logger.warn('migration file changed after it was applied', { filename: file.filename });
        }
        skipped.push(file.filename);
        continue;
      }

      if (dryRun) { applied.push(file.filename); continue; }

      onProgress?.({ filename: file.filename, state: 'applying' });
      const fileStarted = Date.now();

      // BEGIN and COMMIT wrap the file so a failure leaves nothing behind.
      try {
        await client.query('begin');
        await client.query(file.sql);
        await client.query(
          `insert into schema_migrations (filename, checksum, duration_ms)
           values ('${file.filename.replace(/'/g, "''")}', '${file.checksum}', ${Date.now() - fileStarted})`
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw new AppError(`Migration ${file.filename} failed and was rolled back: ${error.message}`, {
          status: 500, code: 'migration_failed', details: { filename: file.filename, pgCode: error.pgCode, detail: error.detail, hint: error.hint }
        });
      }

      applied.push(file.filename);
      onProgress?.({ filename: file.filename, state: 'applied', durationMs: Date.now() - fileStarted });
    }
  } finally {
    if (locked) await client.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => {});
    await client.end().catch(() => {});
  }

  return { applied, skipped, drifted, durationMs: Date.now() - started };
}

/**
 * What the database looks like without changing it.
 * Used by the health endpoint and by the CLI's status command.
 */
export async function status(connectionString) {
  const config = parseConnectionString(connectionString);
  const files = await readMigrations();
  const client = new PostgresClient(config);
  await client.connect();

  try {
    const [{ rows }] = await client.query(`
      select filename, checksum, applied_at from schema_migrations order by filename
    `).catch(() => [{ rows: [] }]);

    const known = new Map(rows.map(row => [row.filename, row]));
    return {
      total: files.length,
      applied: rows.length,
      pending: files.filter(file => !known.has(file.filename)).map(file => file.filename),
      drifted: files.filter(file => known.has(file.filename) && known.get(file.filename).checksum !== file.checksum)
        .map(file => file.filename),
      history: rows
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Does this database already have the DiroxCode schema? */
export async function isProvisioned(connectionString) {
  const client = new PostgresClient(parseConnectionString(connectionString));
  await client.connect();
  try {
    const row = await client.one(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('profiles','organizations','projects','tasks')
    `);
    return Number(row?.n || 0) === 4;
  } finally {
    await client.end().catch(() => {});
  }
}

export { MIGRATIONS_DIR, ADVISORY_LOCK_KEY, checksumOf };
