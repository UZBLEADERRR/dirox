/**
 * Files a person sends in.
 *
 * The other direction from deliverables. A logo, a screenshot, a design, a
 * CSV — something the user has and the agent needs. Images used to be dropped
 * with a note saying they were not passed to the model, which made "add this
 * logo to the repo" unanswerable.
 *
 * The body is the file, not a multipart envelope. Multipart exists so a form
 * can send several fields at once; this sends one file, and hand-rolling a
 * multipart parser to carry a filename that fits in a header would be work
 * done for its own sake.
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { Router, sendJson, readBody } from '../../core/http.js';
import { parse, t, uuid } from '../../core/validate.js';
import { badRequest, notConfigured, notFound, payloadTooLarge } from '../../core/errors.js';
import { putObject, getObject, deleteObject, hasStorage, PROJECT_BUCKET } from '../../db/storage.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { contentTypeFor, safeName, humanSize } from '../../agent/tools/deliver.js';
import { config } from '../../config/env.js';
import { audit } from '../observability/audit.js';
import { logger } from '../../core/logger.js';

/** Big enough for a design export, small enough not to be a storage strategy. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** An avatar is small by definition; anything larger is a mistake. */
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

/**
 * Images only, for anything that will be rendered in a browser as an image.
 *
 * A file is trusted for what it is, not for what it claims: the declared type
 * has to match the bytes, or an "avatar" could be an HTML document served
 * from our own origin.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

const MAGIC = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
];

function sniff(buffer) {
  for (const entry of MAGIC) {
    if (entry.bytes.every((byte, index) => buffer[index] === byte)) return entry.type;
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes || 0),
    size: humanSize(row.size_bytes),
    purpose: row.purpose,
    projectId: row.project_id,
    taskId: row.task_id,
    placedPath: row.placed_path,
    createdAt: row.created_at
  };
}

export function uploadRoutes() {
  const router = new Router();

  /**
   * Take a file.
   *
   * The name arrives in a header because the body is the file. It is
   * sanitised the same way a download name is: it will become a path segment
   * and, later, a filename in a repository.
   */
  router.post('/', async ctx => {
    if (!hasStorage() || !hasServiceRole()) throw notConfigured('file uploads (object storage)');

    const declared = String(ctx.req.headers['content-type'] || '').split(';')[0].trim();
    const name = safeName(decodeURIComponent(String(ctx.req.headers['x-upload-name'] || 'upload')), 'upload');
    const purpose = ['attachment', 'asset'].includes(String(ctx.query.purpose)) ? String(ctx.query.purpose) : 'attachment';

    const body = await readBody(ctx.req, MAX_UPLOAD_BYTES);
    if (!body.length) throw badRequest('The upload is empty');

    const projectId = ctx.query.projectId ? parse(uuid({ required: true }), ctx.query.projectId) : null;
    if (projectId) {
      const project = await ctx.auth.db.from('projects').select('id').eq('id', projectId).first();
      if (!project) throw notFound('Project not found');
    }

    // The extension is the more reliable signal for the many types we do not
    // sniff; the sniff overrides it for images, where being wrong matters.
    const contentType = sniff(body) || (IMAGE_TYPES.has(declared) ? declared : contentTypeFor(name));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const key = `uploads/${ctx.auth.org.id}/${sha256.slice(0, 16)}/${name}`;

    await putObject(key, body, { contentType });

    const row = await serviceClient().insert('uploads', {
      org_id: ctx.auth.org.id,
      user_id: ctx.auth.user.id,
      project_id: projectId,
      task_id: ctx.query.taskId ? parse(uuid({ required: true }), ctx.query.taskId) : null,
      name,
      content_type: contentType,
      size_bytes: body.length,
      sha256,
      storage_key: key,
      bucket: PROJECT_BUCKET,
      purpose
    });

    logger.info('upload received', { uploadId: row.id, name, bytes: body.length, contentType });
    return sendJson(ctx.res, 201, { upload: shape(row) });
  }, { auth: 'write', rateLimit: 'upload' });

  router.get('/', async ctx => {
    let query = ctx.auth.db.from('uploads').select('*').eq('org_id', ctx.auth.org.id);
    if (ctx.query.taskId) query = query.eq('task_id', parse(uuid({ required: true }), ctx.query.taskId));
    if (ctx.query.projectId) query = query.eq('project_id', parse(uuid({ required: true }), ctx.query.projectId));

    const rows = await query.order('created_at').limit(Math.min(100, Number(ctx.query.limit) || 30)).all();
    return sendJson(ctx.res, 200, { uploads: rows.map(shape) });
  }, { auth: true });

  /** The bytes back, for a preview. */
  router.get('/:id/content', async ctx => {
    const row = await ctx.auth.db.from('uploads').select('*')
      .eq('id', parse(uuid({ required: true }), ctx.params.id)).first();
    if (!row) throw notFound('That upload is no longer available');

    const content = await getObject(row.storage_key);
    if (!content) throw notFound('That upload is no longer available');

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', row.content_type);
    ctx.res.setHeader('Content-Length', content.length);
    // Never rendered as a document on this origin, whatever the type says.
    ctx.res.setHeader('Content-Disposition', `inline; filename="${safeName(row.name)}"`);
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Cache-Control', 'private, max-age=300');
    ctx.res.end(content);
  }, { auth: true });

  router.delete('/:id', async ctx => {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const row = await ctx.auth.db.from('uploads').select('storage_key').eq('id', id).first();
    if (row) await deleteObject(row.storage_key).catch(() => {});
    await ctx.auth.db.from('uploads').eq('id', id).remove();
    ctx.res.statusCode = 204;
    ctx.res.end();
  }, { auth: 'write' });

  return router;
}

/**
 * A profile picture.
 *
 * Mounted under /me rather than /uploads because it is a property of the
 * account, not a file in a workspace: uploading one replaces the old one.
 */
export function avatarRoute(router) {
  router.post('/avatar', async ctx => {
    if (!hasStorage() || !hasServiceRole()) throw notConfigured('avatar uploads (object storage)');

    const body = await readBody(ctx.req, MAX_AVATAR_BYTES);
    if (!body.length) throw badRequest('The image is empty');
    if (body.length > MAX_AVATAR_BYTES) throw payloadTooLarge('That image is larger than 4MB');

    // Sniffed, never trusted: an avatar URL ends up in an <img>, and a file
    // that claims to be a PNG and is actually markup is a stored XSS waiting
    // for somewhere that renders it.
    const contentType = sniff(body);
    if (!contentType) {
      throw badRequest('That file is not a PNG, JPEG, GIF or WebP image.');
    }

    const key = `avatars/${ctx.auth.user.id}${extname(`x.${contentType.split('/')[1]}`)}`;
    await putObject(key, body, { contentType, bucket: AVATAR_BUCKET });

    const url = `${config.supabase.url}/storage/v1/object/public/${AVATAR_BUCKET}/${key}?v=${Date.now()}`;
    const [profile] = await ctx.auth.db.from('profiles').eq('id', ctx.auth.user.id).update({ avatar_url: url });

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'profile.avatar_updated',
      resource: 'profile', resourceId: ctx.auth.user.id, metadata: { bytes: body.length, contentType }
    });

    return sendJson(ctx.res, 200, { avatarUrl: profile?.avatar_url ?? url });
  }, { auth: true, rateLimit: 'upload' });

  return router;
}

/** Avatars are shown in an <img>, which cannot send an Authorization header. */
export const AVATAR_BUCKET = 'public-assets';

export { MAX_UPLOAD_BYTES, MAX_AVATAR_BYTES, sniff };
