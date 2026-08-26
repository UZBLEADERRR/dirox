/**
 * Authentication endpoints.
 *
 * Tokens are returned to the browser and held in memory by the client rather
 * than in a readable cookie, so an XSS-injected script has no persistent
 * credential to steal. Refresh tokens are stored in a `SameSite=Strict`,
 * `HttpOnly` cookie set by this server.
 */

import { Router, sendJson } from '../../core/http.js';
import { config } from '../../config/env.js';
import { parse, t, email as emailSchema } from '../../core/validate.js';
import { badRequest, unauthorized } from '../../core/errors.js';
import { enforce } from '../../core/ratelimit.js';
import { audit } from '../../modules/observability/audit.js';
import * as auth from './service.js';

const REFRESH_COOKIE = 'dirox_refresh';

const credentials = t.object({
  email: emailSchema({ required: true }),
  password: t.string({ required: true, min: 8, max: 200, trim: false })
});

function setRefreshCookie(res, token, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token || '')}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${token ? maxAgeSeconds : 0}`
  ];
  if (config.isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Only the fields the client actually needs. Never the raw Supabase payload. */
function sessionPayload(session) {
  return {
    accessToken: session.access_token,
    expiresIn: session.expires_in,
    expiresAt: session.expires_at,
    user: session.user
      ? { id: session.user.id, email: session.user.email, emailVerified: Boolean(session.user.email_confirmed_at) }
      : null
  };
}

export function authRoutes() {
  const router = new Router();

  router.post('/signup', async ctx => {
    enforce('auth', ctx.ip);
    const body = parse(t.object({
      email: emailSchema({ required: true }),
      password: t.string({ required: true, min: 8, max: 200, trim: false }),
      fullName: t.string({ max: 80, truncate: true })
    }), await ctx.json());

    const result = await auth.signUp(body);
    // Supabase returns a session directly when email confirmation is disabled.
    if (result?.access_token) {
      setRefreshCookie(ctx.res, result.refresh_token);
      return sendJson(ctx.res, 201, { ...sessionPayload(result), emailVerificationRequired: false });
    }
    return sendJson(ctx.res, 201, {
      user: result?.user ? { id: result.user.id, email: result.user.email } : null,
      emailVerificationRequired: true,
      message: 'Check your inbox to confirm your email address.'
    });
  });

  router.post('/login', async ctx => {
    enforce('auth', ctx.ip);
    const body = parse(credentials, await ctx.json());
    const session = await auth.signIn(body);
    setRefreshCookie(ctx.res, session.refresh_token);
    await audit.record({
      actorId: session.user?.id, action: 'auth.login', resource: 'session',
      ip: ctx.ip, userAgent: ctx.userAgent
    });
    return sendJson(ctx.res, 200, sessionPayload(session));
  });

  router.post('/refresh', async ctx => {
    enforce('refresh', ctx.ip);
    const body = await ctx.json().catch(() => ({}));
    const token = body.refreshToken || readCookie(ctx.req, REFRESH_COOKIE);
    if (!token) throw unauthorized('No refresh token was supplied');
    const session = await auth.refresh(token);
    if (!session?.access_token) throw unauthorized('Session has expired. Please sign in again.');
    setRefreshCookie(ctx.res, session.refresh_token);
    return sendJson(ctx.res, 200, sessionPayload(session));
  });

  router.post('/logout', async ctx => {
    const token = auth.bearerToken(ctx.req);
    await auth.signOut(token);
    setRefreshCookie(ctx.res, '');
    return sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/password/reset', async ctx => {
    enforce('auth', ctx.ip);
    const body = parse(t.object({ email: emailSchema({ required: true }) }), await ctx.json());
    await auth.requestPasswordReset(body.email, `${config.appUrl}/reset-password`);
    // Always the same answer, so the endpoint cannot enumerate accounts.
    return sendJson(ctx.res, 200, { ok: true, message: 'If that email has an account, a reset link is on its way.' });
  });

  router.post('/password/update', async ctx => {
    const body = parse(t.object({ password: t.string({ required: true, min: 8, max: 200, trim: false }) }), await ctx.json());
    const token = auth.bearerToken(ctx.req);
    if (!token) throw unauthorized();
    await auth.updatePassword(token, body.password);
    await audit.record({ actorId: ctx.auth?.user?.id, action: 'auth.password_changed', severity: 'warning', ip: ctx.ip });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  router.post('/verify/resend', async ctx => {
    enforce('auth', ctx.ip);
    const body = parse(t.object({ email: emailSchema({ required: true }) }), await ctx.json());
    await auth.resendVerification(body.email);
    return sendJson(ctx.res, 200, { ok: true });
  });

  /**
   * Begin a social sign-in.
   *
   * A full browser navigation, not an API call: the browser has to follow the
   * redirect to the provider. Failures redirect back to /login with a reason
   * rather than rendering JSON at someone who clicked a button.
   */
  router.get('/oauth/:provider', async ctx => {
    const provider = String(ctx.params.provider || '').toLowerCase();
    const fail = reason => {
      ctx.res.statusCode = 302;
      ctx.res.setHeader('Location', `/login?error=${encodeURIComponent(reason)}`);
      ctx.res.end();
    };

    if (!['google', 'github'].includes(provider)) return fail('unsupported_provider');
    if (!config.supabase.url) return fail('auth_not_configured');
    if (!/^https?:\/\//.test(config.appUrl)) {
      ctx.log.error('APP_URL is not set, so the provider has nowhere to send the user back to');
      return fail('app_url_missing');
    }

    // Carry the intended destination through the provider round trip, so the
    // user lands where they were going rather than always on the dashboard.
    const next = String(ctx.query.next || '').slice(0, 300);
    const callback = new URL('/auth/callback', config.appUrl);
    if (next.startsWith('/')) callback.searchParams.set('next', next);

    ctx.res.statusCode = 302;
    ctx.res.setHeader('Location', auth.oauthUrl(provider, callback.toString()));
    ctx.res.end();
  }, { auth: false });

  /** Current identity, organization and role — the client's bootstrap call. */
  router.get('/me', async ctx => {
    const { user, profile, org, role, isPlatformAdmin } = ctx.auth;
    return sendJson(ctx.res, 200, {
      user,
      profile: profile ? {
        id: profile.id,
        fullName: profile.full_name,
        username: profile.username,
        email: profile.email,
        avatarUrl: profile.avatar_url,
        timezone: profile.timezone,
        locale: profile.locale,
        experienceLevel: profile.experience_level,
        primaryLanguages: profile.primary_languages,
        preferredFrameworks: profile.preferred_frameworks,
        aiPreferences: profile.ai_preferences,
        notificationPreferences: profile.notification_preferences,
        onboardedAt: profile.onboarded_at
      } : null,
      organization: org ? { id: org.id, slug: org.slug, name: org.name, isPersonal: org.is_personal } : null,
      role,
      isPlatformAdmin
    });
  }, { auth: true });

  router.get('/organizations', async ctx => {
    const rows = await ctx.auth.db
      .from('organization_members')
      .select('role,organizations(id,slug,name,is_personal,avatar_url)')
      .eq('user_id', ctx.auth.user.id)
      .all();
    return sendJson(ctx.res, 200, {
      organizations: rows
        .filter(row => row.organizations)
        .map(row => ({ ...row.organizations, role: row.role }))
    });
  }, { auth: true });

  return router;
}

export { REFRESH_COOKIE, readCookie };
