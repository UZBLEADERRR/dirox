/**
 * Handing a file back to the person who asked for it.
 *
 * Everything the agent produced — a zip, a report, a compiled binary, a
 * generated document — stayed inside the project workspace, reachable only by
 * another tool call. There was no way to give it to anyone. This is the
 * handover: the agent registers a file, and the chat offers it as a download.
 *
 * What is registered is a permission, not a copy. The bytes stay in the
 * workspace and are streamed on request, so a large artefact never goes into
 * the database and a deliverable cannot outlive the workspace it names.
 *
 * The refusals matter more than the feature. A tool that turns a workspace
 * path into a download link is, if it is careless, an exfiltration primitive:
 * "send me .env" would hand over every provider key the project holds.
 */

import { basename, extname } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { t } from '../../core/validate.js';
import { RISK } from '../permissions.js';
import { badRequest, forbidden, notFound, payloadTooLarge } from '../../core/errors.js';
import { resolveInside, isSecretPath } from '../../exec/workspace.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';

/** Anything larger is a mistake rather than a deliverable. */
const MAX_DELIVERABLE_BYTES = 200 * 1024 * 1024;

/** Hashing a very large file to prove identity is not worth the read. */
const HASH_LIMIT_BYTES = 32 * 1024 * 1024;

const CONTENT_TYPES = {
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.ipa': 'application/octet-stream',
  '.jar': 'application/java-archive',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

export function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

/**
 * The download name.
 *
 * Rebuilt from the basename rather than sanitised in place: the name reaches a
 * browser's save dialog, an HTTP header and a filesystem, and slashes, quotes
 * and control characters have meaning in all three.
 */
export function safeName(path, fallback = 'download') {
  const name = basename(String(path || ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')   // control characters mean things in a header
    .replace(/[/\\?%*:|"'<>]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return name || fallback;
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const deliverTools = [
  {
    name: 'deliver_file',
    // A write in the sense that it creates something the user can act on, but
    // it publishes nothing outside the account, so it does not need approval.
    risk: RISK.WRITE,
    description:
      'Offer a file from the workspace to the user as a download. Use it for anything they asked to be given: an archive, a report, a build output, an exported document. Build the file first with the terminal, then deliver it by path.',
    schema: t.object({
      path: t.string({ required: true, max: 400, description: 'Path inside the project workspace' }),
      label: t.string({ max: 200, description: 'One line saying what this file is' })
    }),
    async run({ path, label }, ctx) {
      if (!ctx.projectId) throw badRequest('Files are delivered from a project workspace; open a project first.');

      // Credentials are never a deliverable, whatever the file is called or
      // however the request was phrased.
      if (isSecretPath(path)) {
        throw forbidden('That file may contain credentials and cannot be sent. Deliver the code or the build output instead.');
      }

      const full = await resolveInside(ctx.projectId, path);
      const info = await stat(full).catch(() => null);
      if (!info) throw notFound(`Nothing exists at ${path}. Create the file first, then deliver it.`);
      if (info.isDirectory()) {
        throw badRequest(`${path} is a directory. Archive it first — for example \`zip -r out.zip ${path}\` — and deliver the archive.`);
      }
      if (!info.isFile()) throw badRequest(`${path} is not a regular file.`);
      if (info.size === 0) throw badRequest(`${path} is empty; there is nothing to send.`);
      if (info.size > MAX_DELIVERABLE_BYTES) {
        throw payloadTooLarge(`${path} is ${humanSize(info.size)}, over the ${humanSize(MAX_DELIVERABLE_BYTES)} limit for a download.`);
      }

      const name = safeName(path);
      const sha256 = info.size <= HASH_LIMIT_BYTES
        ? createHash('sha256').update(await readFile(full)).digest('hex')
        : null;

      if (!hasServiceRole()) {
        return { ok: false, output: 'Downloads are unavailable on this deployment (no service role configured).' };
      }

      const row = await serviceClient().insert('deliverables', {
        org_id: ctx.orgId ?? null,
        project_id: ctx.projectId,
        task_id: ctx.taskId ?? null,
        user_id: ctx.userId ?? null,
        path: String(path).replace(/^[/\\]+/, ''),
        name,
        content_type: contentTypeFor(name),
        size_bytes: info.size,
        sha256,
        label: label ? String(label).slice(0, 200) : null
      });

      logger.info('deliverable offered', { projectId: ctx.projectId, taskId: ctx.taskId, name, bytes: info.size });

      const deliverable = {
        id: row.id, name, sizeBytes: info.size,
        contentType: contentTypeFor(name), label: label || null
      };
      ctx.onDeliverable?.(deliverable);

      return {
        output: `Ready to download: ${name} (${humanSize(info.size)}).${label ? ` ${label}` : ''}\nThe user can save it from this message.`,
        metadata: { deliverable }
      };
    }
  }
];

export { MAX_DELIVERABLE_BYTES };
