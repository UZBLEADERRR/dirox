/**
 * Object storage.
 *
 * The workspace lives on the container's local disk, and on a platform like
 * Railway that disk is gone on the next deploy, restart or crash. For a
 * project cloned from GitHub that is survivable — the remote is the source of
 * truth. For a project created inside DiroxCode it is not: the workspace is
 * the only copy, and losing it destroys the work.
 *
 * So the workspace is a cache and this is the source of truth. Files written
 * by the agent are mirrored here, and a workspace that has been wiped is
 * rebuilt from here rather than mourned.
 *
 * Supabase Storage over plain fetch: no SDK, no new dependency, and binary
 * content stays binary instead of being base64'd through PostgREST.
 */

import { config } from '../config/env.js';
import { AppError, notConfigured, upstreamFailed } from '../core/errors.js';
import { logger } from '../core/logger.js';

/** Private. Nothing here is ever served to a browser directly. */
export const PROJECT_BUCKET = 'project-files';

const REQUEST_TIMEOUT_MS = 60_000;

let bucketReady = null;

function base() {
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw notConfigured('object storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
  }
  return `${config.supabase.url}/storage/v1`;
}

export function hasStorage() {
  return Boolean(config.supabase.url && config.supabase.serviceKey);
}

/**
 * Each path segment is encoded, but the separators are not: the key really is
 * a path, and flattening it would collide `a/b` with `a%2Fb`.
 */
function encodeKey(key) {
  return String(key).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function call(path, { method = 'GET', body, headers = {}, raw = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base()}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: config.supabase.serviceKey,
        Authorization: `Bearer ${config.supabase.serviceKey}`,
        ...headers
      },
      body
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let details = null;
      try { details = JSON.parse(text); } catch { details = text || null; }
      throw new AppError(details?.message || details?.error || `Storage request failed (${response.status})`, {
        status: response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status,
        code: response.status === 404 ? 'not_found' : 'storage_error',
        retryable: response.status >= 500
      });
    }

    if (raw) return Buffer.from(await response.arrayBuffer());
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') throw upstreamFailed('Storage request timed out');
    throw upstreamFailed('Could not reach object storage', { reason: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create the bucket if it is not there.
 *
 * Once per process: the answer cannot change while we are running, and every
 * write would otherwise pay for the check.
 */
export async function ensureBucket(bucket = PROJECT_BUCKET) {
  bucketReady ??= (async () => {
    try {
      await call(`/bucket/${encodeURIComponent(bucket)}`);
      return true;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    await call('/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false })
    }).catch(error => {
      // A concurrent boot may have created it between the check and the create.
      if (error.status !== 409) throw error;
    });

    logger.info('created the project file bucket', { bucket });
    return true;
  })().catch(error => {
    bucketReady = null;            // let a later call try again
    throw error;
  });

  return bucketReady;
}

/**
 * @param {string} key      object key, e.g. "<projectId>/src/index.js"
 * @param {Buffer|string} content
 */
export async function putObject(key, content, { contentType = 'application/octet-stream', bucket = PROJECT_BUCKET } = {}) {
  await ensureBucket(bucket);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

  await call(`/object/${encodeURIComponent(bucket)}/${encodeKey(key)}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      // Writing a file twice is the normal case, not a conflict.
      'x-upsert': 'true',
      'Cache-Control': 'no-store'
    },
    body
  });

  return { key, bytes: body.length };
}

/** @returns {Promise<Buffer|null>} null when the object is not there. */
export async function getObject(key, { bucket = PROJECT_BUCKET } = {}) {
  await ensureBucket(bucket);
  try {
    return await call(`/object/${encodeURIComponent(bucket)}/${encodeKey(key)}`, { raw: true });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function deleteObject(key, { bucket = PROJECT_BUCKET } = {}) {
  await ensureBucket(bucket);
  try {
    await call(`/object/${encodeURIComponent(bucket)}/${encodeKey(key)}`, { method: 'DELETE' });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/**
 * Every object under a prefix.
 *
 * Storage lists one page at a time and one directory level at a time, so this
 * walks: a project's tree is nested, and a partial list would silently restore
 * a partial workspace, which is worse than restoring none.
 */
export async function listObjects(prefix, { bucket = PROJECT_BUCKET, pageSize = 1000, maxObjects = 20_000 } = {}) {
  await ensureBucket(bucket);

  const found = [];
  const queue = [String(prefix).replace(/\/+$/, '')];

  while (queue.length && found.length < maxObjects) {
    const directory = queue.shift();

    for (let offset = 0; ; offset += pageSize) {
      const page = await call(`/object/list/${encodeURIComponent(bucket)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: directory ? `${directory}/` : '', limit: pageSize, offset })
      });

      const entries = Array.isArray(page) ? page : [];
      for (const entry of entries) {
        const key = directory ? `${directory}/${entry.name}` : entry.name;
        // A folder placeholder has no id and no metadata.
        if (entry.id === null || entry.id === undefined) queue.push(key);
        else found.push({ key, size: entry.metadata?.size ?? 0, updatedAt: entry.updated_at });
      }

      if (entries.length < pageSize) break;
    }
  }

  return found;
}

/** Remove everything under a prefix. Used when a project is deleted. */
export async function deletePrefix(prefix, { bucket = PROJECT_BUCKET } = {}) {
  const objects = await listObjects(prefix, { bucket });
  if (!objects.length) return 0;

  // The bulk endpoint takes plain keys, not encoded ones.
  await call(`/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: objects.map(object => object.key) })
  });

  return objects.length;
}

export { encodeKey };
