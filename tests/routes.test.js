/**
 * Route surface audit.
 *
 * Builds the real router and asserts things about every registered route, so a
 * new endpoint cannot silently ship without an authorization decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/core/http.js';
import { registerRoutes } from '../src/routes.js';

const router = new Router();
registerRoutes(router);

/** Endpoints that are deliberately reachable without a session. */
const PUBLIC = new Set([
  'GET /api/health',
  'POST /api/auth/signup',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/auth/password/reset',
  'POST /api/auth/verify/resend',
  'GET /api/auth/oauth/:provider',
  'GET /api/github/callback',
  'GET /api/billing/plans',
  'POST /api/billing/webhook'
]);

const key = route => `${route.method} ${route.pattern}`;

test('every route is registered under /api', () => {
  for (const route of router.routes) {
    assert.ok(route.pattern.startsWith('/api/'), `${key(route)} is outside /api`);
  }
});

test('every route declares an authorization decision', () => {
  const undeclared = router.routes.filter(route =>
    route.options.auth === undefined && !PUBLIC.has(key(route)));
  assert.deepEqual(undeclared.map(key), [],
    'these routes neither require auth nor are listed as intentionally public');
});

test('every public route is deliberate', () => {
  const publicRoutes = router.routes
    .filter(route => route.options.auth === false || route.options.auth === undefined)
    .map(key);
  for (const route of publicRoutes) {
    assert.ok(PUBLIC.has(route), `${route} is public but not on the reviewed public list`);
  }
});

test('admin routes require platform admin, not merely a session', () => {
  const adminRoutes = router.routes.filter(route => route.pattern.startsWith('/api/admin'));
  assert.ok(adminRoutes.length > 10, 'expected the admin surface to be registered');
  for (const route of adminRoutes) {
    assert.equal(route.options.auth, 'platformAdmin', `${key(route)} must require platformAdmin`);
  }
});

test('mutating project and task routes require write access or better', () => {
  const mutating = router.routes.filter(route =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) &&
    (route.pattern.startsWith('/api/projects') || route.pattern.startsWith('/api/tasks') ||
     route.pattern.startsWith('/api/conversations')));

  for (const route of mutating) {
    assert.ok(
      ['write', 'orgAdmin', 'platformAdmin', true].includes(route.options.auth),
      `${key(route)} mutates but only requires ${JSON.stringify(route.options.auth)}`
    );
  }
});

test('expensive endpoints carry a heavier rate limit', () => {
  const expensive = [
    'POST /api/tasks',
    'POST /api/projects',
    'POST /api/me/export',
    'GET /api/me/export',
    'POST /api/billing/checkout',
    'POST /api/admin/ai/playground'
  ];
  for (const route of router.routes) {
    if (!expensive.includes(key(route))) continue;
    assert.ok(route.options.rateLimit, `${key(route)} should declare a rate limit policy`);
  }
});

test('the router matches parameters and rejects unknown paths', () => {
  const matched = router.match('GET', '/api/projects/abc-123');
  assert.ok(matched?.params?.id === 'abc-123');
  assert.equal(router.match('GET', '/api/does-not-exist'), null);
  // A known path with the wrong method reports a method mismatch, not a 404.
  assert.equal(router.match('DELETE', '/api/health')?.methodMismatch, true);
});

test('no route pattern can be shadowed by an earlier catch-all', () => {
  const wildcards = router.routes.filter(route => route.pattern.includes('*'));
  assert.deepEqual(wildcards.map(key), [], 'wildcard routes would shadow later registrations');
});
