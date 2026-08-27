/**
 * Authentication and tenancy resolution.
 *
 * Supabase Auth issues and verifies the tokens; DiroxCode never stores a
 * password. This module turns a bearer token into an `auth` context: the user,
 * their profile, the organization they are acting in, and their role there.
 */

import { config } from '../../config/env.js';
import { anonClient, hasServiceRole, serviceClient, userClient } from '../../db/supabase.js';
import { AppError, badRequest, forbidden, notConfigured, unauthorized } from '../../core/errors.js';
import { TtlCache } from '../../core/cache.js';
import { fingerprint } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';

// Short TTL: revocation still takes effect within a few seconds.
const identityCache = new TtlCache({ max: 2000, ttlMs: 20_000 });

function slugify(value, fallback = 'workspace') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

export function bearerToken(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

/** Verify a token with Supabase and return the auth user. */
export async function verifyToken(accessToken) {
  if (!accessToken) return null;
  if (!config.supabase.url) throw notConfigured('Supabase');
  const cacheId = `tok:${fingerprint(accessToken)}`;
  return identityCache.wrap(cacheId, async () => {
    const client = userClient(accessToken);
    try {
      const { data } = await client.request('/auth/v1/user', { method: 'GET' });
      return data?.id ? data : null;
    } catch (error) {
      if (error instanceof AppError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  });
}

/**
 * Ensure the user has a profile and a personal organization.
 *
 * A database trigger creates the profile on signup; this is the recovery path
 * for users created before the trigger existed or through the admin API.
 */
export async function ensureWorkspace(user, accessToken) {
  const client = userClient(accessToken);

  let profile = await client.from('profiles').select('*').eq('id', user.id).first();
  if (!profile) {
    profile = await client.insert('profiles', {
      id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'Developer',
      avatar_url: user.user_metadata?.avatar_url || null
    });
  }

  const membership = await client
    .from('organization_members')
    .select('org_id,role,organizations(id,slug,name,plan_id,is_personal,suspended_at)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .first();

  if (membership?.organizations) {
    return { profile, org: membership.organizations, role: membership.role };
  }

  // First sign-in: create the personal organization.
  const base = slugify(profile?.username || user.email?.split('@')[0] || 'workspace');
  const slug = `${base}-${user.id.slice(0, 6)}`;
  const defaultPlan = await client.from('plans').select('id').eq('is_default', true).first();

  const org = await client.insert('organizations', {
    slug,
    name: `${profile?.full_name || 'My'} workspace`.slice(0, 80),
    owner_id: user.id,
    plan_id: defaultPlan?.id ?? null,
    is_personal: true
  });

  await client.insert('organization_members', { org_id: org.id, user_id: user.id, role: 'owner' }, { returning: false });

  if (hasServiceRole() && defaultPlan?.id) {
    // Subscriptions are system state: written with the service role so a user
    // can never fabricate a plan for themselves.
    await serviceClient()
      .insert('subscriptions', { org_id: org.id, plan_id: defaultPlan.id, status: 'active' }, { returning: false })
      .catch(error => logger.warn('could not create default subscription', { reason: error?.message }));
  }

  return { profile, org, role: 'owner' };
}

/**
 * Resolve the full auth context for a request.
 *
 * The organization is never taken from the client on trust: a supplied
 * `X-Dirox-Org` header is verified against organization_members before use.
 */
export async function resolveAuth(req) {
  const accessToken = bearerToken(req);
  if (!accessToken) return null;

  const user = await verifyToken(accessToken);
  if (!user) return null;

  const client = userClient(accessToken);
  const requestedOrg = String(req.headers['x-dirox-org'] || '').trim();

  let profile;
  let org;
  let role;

  if (requestedOrg) {
    const membership = await client
      .from('organization_members')
      .select('role,organizations(id,slug,name,plan_id,is_personal,suspended_at)')
      .eq('user_id', user.id)
      .eq('org_id', requestedOrg)
      .first();
    if (!membership?.organizations) throw forbidden('You are not a member of that organization');
    org = membership.organizations;
    role = membership.role;
    profile = await client.from('profiles').select('*').eq('id', user.id).first();
  } else {
    ({ profile, org, role } = await ensureWorkspace(user, accessToken));
  }

  if (profile?.suspended_at) throw forbidden('This account has been suspended');
  if (org?.suspended_at) throw forbidden('This organization has been suspended');

  // Revoking a device from the security page ends that session, rather than
  // only hiding it from a list.
  const { isRevoked } = await import('../users/presence.js');
  if (await isRevoked(user.id, accessToken)) {
    identityCache.delete(`tok:${fingerprint(accessToken)}`);
    throw unauthorized('This session was signed out from another device');
  }

  const isAdmin = await isPlatformAdmin(user.id, accessToken, user);

  return {
    user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_confirmed_at) },
    profile,
    org,
    role,
    isPlatformAdmin: isAdmin,
    accessToken,
    db: client,
    /** True for owner/admin/member — anyone allowed to change things. */
    canWrite: ['owner', 'admin', 'member'].includes(role),
    canAdmin: ['owner', 'admin'].includes(role)
  };
}

export async function isPlatformAdmin(userId, accessToken, user = null) {
  return identityCache.wrap(`admin:${userId}`, async () => {
    const row = await userClient(accessToken).from('platform_admins').select('user_id,role').eq('user_id', userId).first();
    if (row) return true;
    return promoteConfiguredOwner(userId, user);
  }, 30_000);
}

/**
 * Does this account match a configured owner address?
 *
 * Pure, and exported, because it is the whole security boundary: an address on
 * the list is not enough, the provider must also have confirmed it.
 *
 * @param {{email?:string, email_confirmed_at?:string|null}} user
 * @returns {{ok:boolean, reason?:string}}
 */
export function configuredOwner(user, emails = config.platformAdminEmails) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no address' };
  if (!emails.includes(email)) return { ok: false, reason: 'not configured' };
  if (!user?.email_confirmed_at) return { ok: false, reason: 'unconfirmed' };
  return { ok: true };
}

/**
 * Grant administration to a configured owner address, once.
 *
 * The first administrator of a deployment cannot be created from inside the
 * product — the admin panel is the only place to grant access, and it is the
 * thing being locked — so the deployment's own configuration names them.
 *
 * Two conditions, both required. The address must be on the configured list,
 * and the identity provider must have confirmed it: without that check anyone
 * who typed the owner's address into a signup form would inherit the platform.
 * It runs at sign-in rather than at boot so an account created later is still
 * promoted, and it writes at most once because the row it inserts is what the
 * lookup above finds next time.
 */
async function promoteConfiguredOwner(userId, user) {
  const verdict = configuredOwner(user);
  if (!verdict.ok) {
    if (verdict.reason === 'unconfirmed') {
      logger.warn('configured administrator address is not confirmed; not granting', { userId });
    }
    return false;
  }
  if (!hasServiceRole()) return false;

  try {
    await serviceClient().insert('platform_admins',
      { user_id: userId, role: 'superadmin' },
      { upsert: true, onConflict: 'user_id', returning: false });
    logger.info('granted platform administration to a configured owner address', { userId });
    return true;
  } catch (error) {
    logger.warn('could not grant platform administration', { userId, reason: error?.message });
    return false;
  }
}

// ─── credential flows ───────────────────────────────────────────────────────

export async function signUp({ email, password, fullName }) {
  const client = anonClient();
  const { data } = await client.request('/auth/v1/signup', {
    method: 'POST',
    body: { email, password, data: { full_name: fullName || email.split('@')[0] } }
  });
  return data;
}

export async function signIn({ email, password }) {
  const client = anonClient();
  const { data } = await client.request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password }
  });
  if (!data?.access_token) throw unauthorized('Email or password is incorrect');
  return data;
}

export async function refresh(refreshToken) {
  if (!refreshToken) throw badRequest('A refresh token is required');
  const { data } = await anonClient().request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  });
  return data;
}

export async function signOut(accessToken) {
  if (!accessToken) return;
  identityCache.delete(`tok:${fingerprint(accessToken)}`);
  await userClient(accessToken).request('/auth/v1/logout', { method: 'POST', body: {} }).catch(() => {});
}

export async function requestPasswordReset(email, redirectTo) {
  await anonClient().request('/auth/v1/recover', { method: 'POST', body: { email, gotrue_meta_security: {}, redirect_to: redirectTo } });
}

export async function resendVerification(email) {
  await anonClient().request('/auth/v1/resend', { method: 'POST', body: { type: 'signup', email } });
}

export async function updatePassword(accessToken, password) {
  const { data } = await userClient(accessToken).request('/auth/v1/user', { method: 'PUT', body: { password } });
  return data;
}

/** Build the provider redirect URL for Google / GitHub sign-in. */
export function oauthUrl(provider, redirectTo) {
  if (!['google', 'github'].includes(provider)) throw badRequest('Unsupported sign-in provider');
  if (!config.supabase.url) throw notConfigured('Supabase');
  const params = new URLSearchParams({ provider, redirect_to: redirectTo });
  return `${config.supabase.url}/auth/v1/authorize?${params.toString()}`;
}

export function invalidateIdentity(accessToken) {
  if (accessToken) identityCache.delete(`tok:${fingerprint(accessToken)}`);
}

export { identityCache, slugify };
