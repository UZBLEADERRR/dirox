/**
 * The user's own Supabase project.
 *
 * DiroxCode can write an application. Until now it could not give that
 * application a database: the agent would produce a migration file and a
 * person would paste it into a dashboard, once per iteration, forever. That
 * is not automation — it is the part of the work we left undone.
 *
 * Two credentials, because a Supabase project has two doors and they open
 * different things:
 *
 *   service key      the REST API. Reads and writes rows, respects nothing.
 *   connection URL   the database. Runs DDL, which is what a migration is.
 *
 * Both are optional and stored encrypted. A connection with only the first can
 * read and change data; only the second can change the shape of it.
 */

import { withConnection, parseConnectionString } from '../../db/pg.js';
import { encryptSecret, decryptSecret } from '../../core/crypto.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { badRequest, notConfigured, upstreamFailed } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const PROVIDER = 'supabase';
const REQUEST_TIMEOUT_MS = 20_000;

/** `https://abcdefgh.supabase.co` → `abcdefgh`. */
export function projectRef(url) {
  const match = String(url || '').match(/^https:\/\/([a-z0-9-]+)\.supabase\.(co|in|net)/i);
  return match ? match[1] : null;
}

/**
 * Check the credentials before storing them.
 *
 * Storing something that does not work and finding out three tool calls later
 * is a bad trade for one HTTP request.
 */
export async function verifyProject({ projectUrl, serviceKey }) {
  const url = String(projectUrl || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)$/i.test(url)) {
    throw badRequest('That does not look like a Supabase project URL. It should be https://<ref>.supabase.co');
  }
  if (!serviceKey) return { url, ref: projectRef(url), reachable: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw badRequest('Supabase rejected that key. Check you copied the service role key, not the anon key.');
    }
    if (!response.ok) throw upstreamFailed(`Supabase answered ${response.status}`);
    return { url, ref: projectRef(url), reachable: true };
  } catch (error) {
    if (error?.name === 'AbortError') throw upstreamFailed('Supabase did not answer in time');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Confirm a connection string opens before it is stored. */
export async function verifyDatabase(connectionString) {
  const parsed = parseConnectionString(connectionString);
  // `query` returns one entry per statement; a single statement means one.
  const [result] = await withConnection(parsed, client =>
    client.query('select current_database() as name, version() as version'));
  const row = result?.rows?.[0] || {};
  return { database: row.name, version: String(row.version || '').split(' ').slice(0, 2).join(' '), host: parsed.host };
}

export async function saveConnection(userId, { projectUrl, serviceKey, anonKey, connectionString }) {
  if (!hasServiceRole()) throw notConfigured('integrations (SUPABASE_SERVICE_ROLE_KEY)');

  const verified = await verifyProject({ projectUrl, serviceKey });
  const database = connectionString ? await verifyDatabase(connectionString) : null;

  await serviceClient().insert('user_integrations', {
    user_id: userId,
    provider: PROVIDER,
    external_id: verified.ref,
    account_login: verified.ref,
    account_name: verified.ref,
    // The keys are secrets; the URL and the anon key are not — the anon key is
    // published in every browser that talks to the project.
    access_token_enc: serviceKey ? encryptSecret(serviceKey) : encryptSecret('unset'),
    secondary_token_enc: connectionString ? encryptSecret(connectionString) : null,
    metadata: {
      projectUrl: verified.url,
      ref: verified.ref,
      anonKey: anonKey || null,
      hasServiceKey: Boolean(serviceKey),
      hasDatabase: Boolean(connectionString),
      database: database?.database ?? null,
      host: database?.host ?? null
    },
    scopes: [serviceKey ? 'rest' : null, connectionString ? 'sql' : null].filter(Boolean),
    revoked_at: null
  }, { upsert: true, onConflict: 'user_id,provider', returning: false });

  logger.info('supabase project connected', { userId, ref: verified.ref, sql: Boolean(connectionString) });
  return { ref: verified.ref, projectUrl: verified.url, database };
}

export async function getConnection(userId) {
  if (!hasServiceRole()) return null;
  const row = await serviceClient().from('user_integrations')
    .select('metadata,access_token_enc,secondary_token_enc,scopes,created_at')
    .eq('user_id', userId).eq('provider', PROVIDER).is('revoked_at', 'null').first()
    .catch(() => null);
  if (!row) return null;

  return {
    ...row.metadata,
    scopes: row.scopes || [],
    connectedAt: row.created_at,
    /** Decrypted only at the point of use, never in a list. */
    serviceKey: () => {
      const value = decryptSecret(row.access_token_enc);
      return value === 'unset' ? null : value;
    },
    connectionString: () => (row.secondary_token_enc ? decryptSecret(row.secondary_token_enc) : null)
  };
}

export async function revokeConnection(userId) {
  if (!hasServiceRole()) return false;
  await serviceClient().from('user_integrations')
    .eq('user_id', userId).eq('provider', PROVIDER)
    .update({ revoked_at: new Date().toISOString() });
  return true;
}

/**
 * Run SQL against the connected project.
 *
 * The connection is opened and closed per call. A pooled connection held open
 * across an agent run would be a connection held open across an agent run —
 * cheap for us, and one of the user's own limited slots.
 */
export async function runSql(userId, sql) {
  const connection = await getConnection(userId);
  if (!connection) throw badRequest('No Supabase project is connected. Connect one in Settings → Developer.');

  const connectionString = connection.connectionString();
  if (!connectionString) {
    throw badRequest('This Supabase connection has no database URL, so SQL cannot run. Add the connection string in Settings → Developer.');
  }

  const parsed = parseConnectionString(connectionString);
  return withConnection(parsed, client => client.query(sql));
}

/** The tables, columns and row counts a person would ask about. */
export async function describeSchema(userId, { schema = 'public' } = {}) {
  const [result] = await runSql(userId, `
    select c.table_name,
           c.column_name,
           c.data_type,
           c.is_nullable,
           c.column_default
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = '${String(schema).replace(/'/g, "''")}'
       and t.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position
  `);

  const tables = new Map();
  for (const row of result.rows || []) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    tables.get(row.table_name).push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      default: row.column_default
    });
  }
  return tables;
}

export { PROVIDER };
