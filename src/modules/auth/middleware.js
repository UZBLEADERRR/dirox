/**
 * Route guards. Handlers declare what they need; the kernel applies it.
 *
 *   router.get('/x', handler, { auth: true })            // signed in
 *   router.post('/y', handler, { auth: 'write' })        // member or above
 *   router.post('/z', handler, { auth: 'orgAdmin' })     // owner/admin
 *   router.get('/a', handler, { auth: 'platformAdmin' }) // DiroxCode staff
 */

import { forbidden, unauthorized } from '../../core/errors.js';
import { resolveAuth } from './service.js';

export const AUTH_LEVELS = ['optional', 'user', 'write', 'orgAdmin', 'platformAdmin'];

function normalise(level) {
  if (level === true) return 'user';
  if (level === false || level === undefined || level === null) return null;
  if (level === 'read') return 'user';
  return AUTH_LEVELS.includes(level) ? level : 'user';
}

export async function applyAuth(ctx, requirement) {
  const level = normalise(requirement);
  if (!level) return null;

  const auth = await resolveAuth(ctx.req);

  if (!auth) {
    if (level === 'optional') return null;
    throw unauthorized();
  }

  ctx.auth = auth;
  ctx.log = ctx.log.child({ userId: auth.user.id, orgId: auth.org?.id });

  switch (level) {
    case 'write':
      if (!auth.canWrite) throw forbidden('Your role in this organization is read-only');
      break;
    case 'orgAdmin':
      if (!auth.canAdmin) throw forbidden('This action requires an organization owner or admin');
      break;
    case 'platformAdmin':
      if (!auth.isPlatformAdmin) throw forbidden('This action requires DiroxCode administrator access');
      break;
    default:
      break;
  }

  return auth;
}

/** Assert a resolved auth context, for use inside a handler body. */
export function requireAuth(ctx) {
  if (!ctx.auth) throw unauthorized();
  return ctx.auth;
}
