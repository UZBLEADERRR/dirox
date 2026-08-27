/**
 * Downloading what the agent produced.
 *
 * A `deliverables` row records that a file was offered; it is not itself a
 * capability to read one. Every download re-derives the path inside the
 * project workspace and re-applies the credential rule, so a row that was
 * written correctly today cannot be turned into an arbitrary file read
 * tomorrow — by a bug elsewhere, or by anyone who reaches the table.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Router, sendJson } from '../../core/http.js';
import { parse, uuid } from '../../core/validate.js';
import { forbidden, notFound } from '../../core/errors.js';
import { resolveInside, isSecretPath } from '../../exec/workspace.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { contentTypeFor, safeName, humanSize } from '../../agent/tools/deliver.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { config } from '../../config/env.js';
import { audit } from '../observability/audit.js';
import { logger } from '../../core/logger.js';

/**
 * Downloads are links, and a link cannot carry an Authorization header.
 *
 * The browser must fetch this itself — a `<a download>` for the progress,
 * the resume and the save dialog people expect, and because reading a 200MB
 * archive into a Blob to trigger a save is not a download, it is a memory
 * leak with a filename. So the grant travels in the URL instead: signed,
 * bound to one deliverable and one user, and valid for five minutes.
 *
 * Issuing it required a full authorization check. Spending it re-checks that
 * the row still exists and still is not a credential file.
 */
const LINK_TTL_MS = 5 * 60_000;

function signDownload(id, userId, expiresAt) {
  return hmacSha256(config.encryptionKey, `deliverable:${id}:${userId}:${expiresAt}`);
}

function verifyDownload(id, token) {
  const [userId, expires, signature] = String(token || '').split('.');
  if (!userId || !expires || !signature) return null;
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return null;
  if (!safeEqual(signature, signDownload(id, userId, expires))) return null;
  return { userId };
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    sizeBytes: Number(row.size_bytes || 0),
    size: humanSize(row.size_bytes),
    contentType: row.content_type,
    sha256: row.sha256,
    taskId: row.task_id,
    projectId: row.project_id,
    downloadCount: row.download_count,
    createdAt: row.created_at,
    url: `/api/deliverables/${row.id}/download`
  };
}

/**
 * A filename in `Content-Disposition` is a header value, and a header value
 * ends at a newline. `filename*` carries the real name for anything non-ASCII.
 */
function disposition(name) {
  const safe = safeName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function deliverableRoutes() {
  const router = new Router();

  /** Everything offered for one task, or across the organization. */
  router.get('/', async ctx => {
    let query = ctx.auth.db.from('deliverables').select('*').eq('org_id', ctx.auth.org.id);
    if (ctx.query.taskId) query = query.eq('task_id', parse(uuid({ required: true }), ctx.query.taskId));
    if (ctx.query.projectId) query = query.eq('project_id', parse(uuid({ required: true }), ctx.query.projectId));

    const rows = await query.order('created_at').limit(Math.min(100, Number(ctx.query.limit) || 30)).all();
    return sendJson(ctx.res, 200, { deliverables: rows.map(shape) });
  }, { auth: true });

  /**
   * A short-lived URL the browser can follow on its own.
   */
  router.get('/:id/link', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const row = await ctx.auth.db.from('deliverables').select('id,expires_at').eq('id', id).first();
    if (!row) throw notFound('That download is no longer available');
    if (!config.encryptionKey) {
      throw forbidden('Downloads need DIROX_ENCRYPTION_KEY to be configured on this deployment.');
    }

    const expiresAt = Date.now() + LINK_TTL_MS;
    const token = `${ctx.auth.user.id}.${expiresAt}.${signDownload(id, ctx.auth.user.id, expiresAt)}`;
    return sendJson(ctx.res, 200, {
      url: `/api/deliverables/${id}/download?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAt).toISOString()
    });
  }, { auth: true });

  router.get('/:id', async ctx => {
    const row = await ctx.auth.db.from('deliverables').select('*')
      .eq('id', parse(uuid({ required: true }), ctx.params.id)).first();
    if (!row) throw notFound('That download is no longer available');
    return sendJson(ctx.res, 200, { deliverable: shape(row) });
  }, { auth: true });

  /**
   * Stream the file.
   *
   * Read through the caller's own client, so row-level security decides
   * whether this organization may see it at all before anything touches disk.
   */
  router.get('/:id/download', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);

    // Either an ordinary authenticated request, or a signed link the browser
    // is following on its own. Never neither.
    const signed = ctx.query.token ? verifyDownload(id, ctx.query.token) : null;
    if (!ctx.auth && !signed) throw forbidden('This download link has expired. Ask for the file again.');

    // A signed link was issued after an authorization check, so it reads
    // through the service client; an ordinary request reads through the
    // caller's own, where row-level security decides.
    const reader = ctx.auth?.db ?? (hasServiceRole() ? serviceClient() : null);
    if (!reader) throw notFound('That download is no longer available');

    const row = await reader.from('deliverables').select('*').eq('id', id).first();
    if (!row) throw notFound('That download is no longer available');

    // A link outlives the check that issued it by up to five minutes, which is
    // long enough for someone to be removed from the organization. Membership
    // is confirmed again rather than assumed from the signature.
    if (signed && !ctx.auth) {
      const member = await serviceClient().from('organization_members')
        .select('user_id').eq('org_id', row.org_id).eq('user_id', signed.userId).first();
      if (!member) throw forbidden('You no longer have access to this file');
    }

    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw notFound('That download has expired');
    }

    // Re-checked here rather than trusted from the row: the guarantee must
    // hold at the moment bytes are served, not only when they were offered.
    if (isSecretPath(row.path)) {
      logger.warn('refused to serve a credential file as a deliverable', { deliverableId: id });
      throw forbidden('That file cannot be downloaded');
    }

    const full = await resolveInside(row.project_id, row.path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) {
      throw notFound('The file is no longer in the workspace. Ask DiroxCode to produce it again.');
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', row.content_type || contentTypeFor(row.name));
    ctx.res.setHeader('Content-Length', info.size);
    ctx.res.setHeader('Content-Disposition', disposition(row.name));
    // A download is per-user data behind an authorization check; a shared
    // cache must never hold one.
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');

    if (hasServiceRole()) {
      serviceClient().from('deliverables').eq('id', id).update({
        download_count: Number(row.download_count || 0) + 1,
        last_download_at: new Date().toISOString()
      }).catch(() => {});
    }

    audit.record({
      orgId: row.org_id,
      actorId: ctx.auth?.user?.id ?? signed?.userId ?? null,
      action: 'deliverable.downloaded',
      resource: 'deliverable', resourceId: id,
      metadata: { name: row.name, bytes: info.size, viaLink: Boolean(signed) }
    });

    await new Promise((done, fail) => {
      const stream = createReadStream(full);
      stream.on('error', fail);
      stream.on('end', done);
      stream.pipe(ctx.res);
    }).catch(() => { if (!ctx.res.writableEnded) ctx.res.end(); });
  }, { auth: 'optional' });

  router.delete('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    await ctx.auth.db.from('deliverables').eq('id', id).remove();
    ctx.res.statusCode = 204;
    ctx.res.end();
  }, { auth: 'write' });

  return router;
}

export { disposition };
