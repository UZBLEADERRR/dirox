/**
 * Looking at what the agent built.
 *
 * The dev server has always run — sandboxed, bound to 127.0.0.1 inside the
 * container — and the agent could fetch pages from it. Nobody else could. So
 * "build me a landing page" ended with a description of a landing page.
 *
 * This proxies it. Every request is authorised first, rewritten onto the
 * loopback server, and returned with headers that make it safe to put in an
 * iframe on our own origin: the preview is the user's own code, running in our
 * container, and it must not be able to reach back into the product.
 */

import { Router, sendJson, readBody } from '../../core/http.js';
import { parse, uuid } from '../../core/validate.js';
import { badRequest, notFound } from '../../core/errors.js';
import { previewFor, previewStatus, startPreview, stopPreview } from '../../exec/preview.js';
import { materialiseWorkspace } from '../../exec/persistence.js';
import { logger } from '../../core/logger.js';

/** Response headers we replace rather than forward. */
const STRIPPED = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'strict-transport-security',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'access-control-allow-origin'
]);

/**
 * The preview is untrusted code on our own origin.
 *
 * Same-origin is unavoidable — a dev server on loopback cannot be reached any
 * other way — so the sandbox attribute and a policy of its own do the work
 * instead. `allow-same-origin` is deliberately absent: without it the page is
 * opaque to itself and cannot read a token out of our storage.
 */
function previewHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType || 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; '));
}

export function previewRoutes() {
  const router = new Router();

  async function loadProject(ctx) {
    const id = parse(uuid({ required: true }), ctx.params.id);
    const project = await ctx.auth.db.from('projects').select('*').eq('id', id).first();
    if (!project) throw notFound('Project not found');
    return project;
  }

  router.get('/:id/preview/status', async ctx => {
    const project = await loadProject(ctx);
    const status = previewStatus(project.id);
    return sendJson(ctx.res, 200, {
      preview: {
        ...status,
        // The loopback URL is useless to a browser elsewhere; ours is not.
        url: status?.status === 'ready' ? `/api/projects/${project.id}/preview/` : null,
        devCommand: project.dev_command || null
      }
    });
  }, { auth: true });

  router.post('/:id/preview/start', async ctx => {
    const project = await loadProject(ctx);
    if (!project.dev_command) {
      throw badRequest('This project has no dev command. Set one in project settings, or ask DiroxCode to work out how it starts.');
    }

    // The container may be newer than the project.
    await materialiseWorkspace(project.id).catch(() => {});

    const result = await startPreview(project.id, { command: project.dev_command });
    logger.info('preview started for a person', { projectId: project.id, status: result.status });

    return sendJson(ctx.res, 201, {
      preview: { ...result, url: `/api/projects/${project.id}/preview/` }
    });
  }, { auth: 'write', rateLimit: 'heavy' });

  router.post('/:id/preview/stop', async ctx => {
    const project = await loadProject(ctx);
    await stopPreview(project.id);
    ctx.res.statusCode = 204;
    ctx.res.end();
  }, { auth: 'write' });

  /**
   * Everything else under /preview/ is the app itself.
   *
   * Streamed rather than buffered: a dev server sends bundles, source maps and
   * images, and reading a 4MB bundle into a string to hand it back would be
   * both slow and wrong for anything binary.
   */
  router.all('/:id/preview/*', async ctx => {
    const project = await loadProject(ctx);
    const server = previewFor(project.id);
    if (!server || server.status !== 'ready') {
      throw notFound('No preview is running. Start it first.');
    }

    const prefix = `/api/projects/${project.id}/preview`;
    const path = ctx.url.pathname.slice(prefix.length) || '/';
    const target = `${server.url}${path}${ctx.url.search || ''}`;

    const method = ctx.req.method;
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await readBody(ctx.req, 8 * 1024 * 1024);

    let response;
    try {
      response = await fetch(target, {
        method,
        body,
        // Forward only what a dev server actually reads. Cookies and
        // authorization belong to DiroxCode, not to the previewed app.
        headers: Object.fromEntries(Object.entries({
          accept: ctx.req.headers.accept,
          'accept-language': ctx.req.headers['accept-language'],
          'content-type': ctx.req.headers['content-type'],
          'user-agent': ctx.req.headers['user-agent']
        }).filter(([, value]) => value)),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw badRequest(`The preview did not respond: ${error.message}`);
    }

    server.lastUsedAt = Date.now();

    // A redirect points at the loopback server; rewrite it onto our path so
    // the iframe follows it to somewhere it can actually reach.
    const location = response.headers.get('location');
    if (location) {
      const rewritten = location.startsWith(server.url)
        ? prefix + location.slice(server.url.length)
        : location.startsWith('/') ? prefix + location : location;
      ctx.res.statusCode = response.status;
      ctx.res.setHeader('Location', rewritten);
      return ctx.res.end();
    }

    ctx.res.statusCode = response.status;
    for (const [name, value] of response.headers) {
      if (!STRIPPED.has(name.toLowerCase())) ctx.res.setHeader(name, value);
    }
    previewHeaders(ctx.res, response.headers.get('content-type'));

    if (method === 'HEAD' || !response.body) return ctx.res.end();

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ctx.res.write(Buffer.from(value))) {
        await new Promise(resolve => ctx.res.once('drain', resolve));
      }
    }
    ctx.res.end();
  }, { auth: true });

  return router;
}

export { previewHeaders, STRIPPED };
