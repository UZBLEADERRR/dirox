/**
 * Application assembly: the route table and the request pipeline.
 *
 * Pipeline order matters and is deliberate:
 *   cors -> security headers -> rate limit -> auth -> handler -> error mapping
 */

import { Router, applyCors, createContext, securityHeaders, sendError, sendJson } from './core/http.js';
import { config, configReport } from './config/env.js';
import { enforce } from './core/ratelimit.js';
import { toAppError } from './core/errors.js';
import { applyAuth } from './modules/auth/middleware.js';
import { metrics, runtimeStats } from './modules/observability/audit.js';
import { logger } from './core/logger.js';
import { fingerprint } from './core/crypto.js';
import { serveStatic } from './static.js';
import { registerRoutes } from './routes.js';

export function createApp() {
  const router = new Router();
  registerRoutes(router);
  const report = configReport();
  for (const warning of report.warnings) logger.warn('configuration', { warning });

  return async function handle(req, res) {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.statusCode = 400;
      return res.end('Bad request');
    }

    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const isApi = url.pathname.startsWith('/api/');
    securityHeaders(res, { html: !isApi });

    const ctx = createContext(req, res, {}, url);
    let failed = false;

    try {
      if (!isApi) {
        const served = await serveStatic(req, res, url);
        if (served) return;
      }

      const matched = router.match(req.method, url.pathname);
      if (!matched || matched.methodMismatch) {
        failed = true;
        if (isApi) return sendJson(res, matched?.methodMismatch ? 405 : 404, { error: { code: matched?.methodMismatch ? 'method_not_allowed' : 'not_found', message: matched?.methodMismatch ? 'That method is not allowed on this endpoint' : 'Endpoint not found', requestId: ctx.requestId } });
        // Unknown non-API path: hand it to the single-page app.
        failed = false;
        return serveStatic(req, res, new URL('/', url), { fallback: true });
      }

      ctx.params = matched.params;
      const { handler, options } = matched.route;

      if (options.rateLimit !== false) {
        // Signed-in callers are limited per credential, anonymous ones per IP.
        const credential = req.headers.authorization ? `u:${fingerprint(req.headers.authorization)}` : `ip:${ctx.ip}`;
        enforce(options.rateLimit || 'api', credential);
      }

      await applyAuth(ctx, options.auth);
      await handler(ctx);

      if (!res.writableEnded) sendJson(res, 204, null);
    } catch (error) {
      failed = true;
      const app = toAppError(error);
      if (app.status >= 500) ctx.log.error('request failed', { path: url.pathname, method: req.method, code: app.code, message: app.message, stack: app.cause?.stack?.split('\n').slice(0, 4).join(' | ') });
      else ctx.log.debug('request rejected', { path: url.pathname, status: app.status, code: app.code });
      sendError(res, app, ctx.requestId);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      runtimeStats.request(durationMs, failed);
      if (isApi && (failed || durationMs > 1500)) {
        metrics.observe({ kind: 'api', name: `${req.method} ${url.pathname}`, status: failed ? 'error' : 'slow', durationMs, orgId: ctx.auth?.org?.id || null });
      }
    }
  };
}

export { config };
