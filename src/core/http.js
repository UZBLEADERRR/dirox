/**
 * Minimal HTTP kernel: routing, body parsing, consistent responses,
 * security headers and CORS. Built on node:http so the deployment has no
 * runtime dependencies and a predictable cold start.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { AppError, badRequest, notFound, payloadTooLarge, toAppError } from './errors.js';
import { logger } from './logger.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * A route path like `/api/projects/:id` compiled to a matcher.
 *
 * `specificity` is what stops a wildcard eating a sibling. Routing used to
 * take the first pattern that matched, which made correctness depend on the
 * order files happen to be imported in — fine until a proxy route needs a
 * `*`, and then silently wrong. The most specific match wins now: literal
 * segments beat parameters, parameters beat a wildcard, and registration
 * order decides nothing.
 */
function compile(pattern) {
  const keys = [];
  let literals = 0;
  let wildcards = 0;

  const source = pattern
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) { keys.push(segment.slice(1)); return '([^/]+)'; }
      if (segment === '*') { keys.push('wildcard'); wildcards += 1; return '(.*)'; }
      if (segment) literals += 1;
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');

  return { regex: new RegExp(`^${source}/?$`), keys, specificity: { wildcards, literals } };
}

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, options = {}) {
    const { regex, keys, specificity } = compile(pattern);
    this.routes.push({ method, pattern, regex, keys, handler, options, specificity });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /**
   * Every method at one path.
   *
   * For a proxy, where the handler forwards whatever arrives rather than
   * caring which verb it was.
   */
  all(p, h, o) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) this.add(method, p, h, o);
    return this;
  }

  /** Mount another router under a prefix. */
  use(prefix, router) {
    for (const route of router.routes) {
      this.add(route.method, `${prefix}${route.pattern === '/' ? '' : route.pattern}`, route.handler, route.options);
    }
    return this;
  }

  match(method, pathname) {
    let pathExists = false;
    let best = null;
    let bestMatch = null;

    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;

      // Fewer wildcards first, then more literal segments. A tie keeps the
      // earlier registration, so nothing that works today changes.
      if (!best
        || route.specificity.wildcards < best.specificity.wildcards
        || (route.specificity.wildcards === best.specificity.wildcards
            && route.specificity.literals > best.specificity.literals)) {
        best = route;
        bestMatch = m;
      }
    }

    if (!best) return pathExists ? { methodMismatch: true } : null;

    const params = {};
    best.keys.forEach((key, index) => { params[key] = decodeURIComponent(bestMatch[index + 1] || ''); });
    return { route: best, params };
  }
}

export async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw payloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = MAX_BODY_BYTES) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw badRequest('Request body is not valid JSON'); }
}

export function securityHeaders(res, { html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (html) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '));
  }
}

export function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;
  if (!origin) return;
  const ok = allowed.includes('*') || allowed.includes(origin) || (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  if (!ok) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dirox-Org, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

export function sendError(res, error, requestId) {
  const app = toAppError(error);
  const payload = app.toJSON();
  payload.error.requestId = requestId;
  // 499 is a client-cancel marker, not a wire status.
  sendJson(res, app.status === 499 ? 408 : app.status, payload);
}

/** Server-sent events channel used to stream agent activity to the browser. */
export function openStream(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  };
  req.on('close', close);

  return {
    send(event, data) {
      if (res.writableEnded) return false;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
      return true;
    },
    get closed() { return closed || res.writableEnded; },
    close
  };
}

/** Build the per-request context passed to every handler. */
export function createContext(req, res, params, url) {
  const requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 64);
  res.setHeader('X-Request-Id', requestId);
  return {
    req,
    res,
    params,
    url,
    query: Object.fromEntries(url.searchParams),
    requestId,
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    log: logger.child({ requestId }),
    json: (limit) => readJson(req, limit),
    /** Populated by the auth middleware. */
    auth: null,
    state: {}
  };
}

export { MAX_BODY_BYTES, AppError, notFound };
