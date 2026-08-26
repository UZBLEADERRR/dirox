/**
 * Organizations: the tenant boundary.
 *
 * Membership is the only thing that grants access to a project, a task or a
 * usage record. Nothing here trusts an organization id from the client without
 * checking it against organization_members first.
 */

import { Router, sendJson } from '../../core/http.js';
import { parse, t, uuid, email as emailSchema } from '../../core/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { audit } from '../observability/audit.js';
import { slugify } from '../auth/service.js';
import { hasServiceRole, serviceClient } from '../../db/supabase.js';

export function orgRoutes() {
  const router = new Router();

  router.get('/current', async ctx => {
    const org = await ctx.auth.db.from('organizations').select('*').eq('id', ctx.auth.org.id).one('Organization not found');
    const subscription = await ctx.auth.db
      .from('subscriptions')
      .select('id,status,billing_interval,current_period_start,current_period_end,cancel_at_period_end,credits_cents,plans(code,name,max_projects,max_tasks_per_day,max_tokens_per_month,max_cost_per_month_cents,max_concurrent_agents,included_credits_cents,features,allowed_model_tiers)')
      .eq('org_id', org.id)
      .in('status', ['trialing', 'active', 'past_due'])
      .first();

    const { total: memberCount } = await ctx.auth.db.from('organization_members').select('user_id').eq('org_id', org.id).count().run('GET');
    const { total: projectCount } = await ctx.auth.db.from('projects').select('id').eq('org_id', org.id).is('archived_at', 'null').count().run('GET');

    return sendJson(ctx.res, 200, {
      organization: { id: org.id, slug: org.slug, name: org.name, avatarUrl: org.avatar_url, isPersonal: org.is_personal, settings: org.settings, createdAt: org.created_at },
      role: ctx.auth.role,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        interval: subscription.billing_interval,
        periodStart: subscription.current_period_start,
        periodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        creditsCents: subscription.credits_cents,
        plan: subscription.plans
      } : null,
      counts: { members: memberCount ?? 0, projects: projectCount ?? 0 }
    });
  }, { auth: true });

  router.post('/', async ctx => {
    const body = parse(t.object({
      name: t.string({ required: true, min: 2, max: 60 })
    }), await ctx.json());

    const slug = `${slugify(body.name, 'team')}-${Math.random().toString(36).slice(2, 7)}`;
    const defaultPlan = await ctx.auth.db.from('plans').select('id').eq('is_default', true).first();

    const org = await ctx.auth.db.insert('organizations', {
      slug, name: body.name, owner_id: ctx.auth.user.id, plan_id: defaultPlan?.id ?? null, is_personal: false
    });
    await ctx.auth.db.insert('organization_members', { org_id: org.id, user_id: ctx.auth.user.id, role: 'owner' }, { returning: false });
    if (hasServiceRole() && defaultPlan?.id) {
      await serviceClient().insert('subscriptions', { org_id: org.id, plan_id: defaultPlan.id, status: 'active' }, { returning: false }).catch(() => {});
    }

    audit.record({ orgId: org.id, actorId: ctx.auth.user.id, action: 'organization.created', resource: 'organization', resourceId: org.id });
    return sendJson(ctx.res, 201, { organization: { id: org.id, slug: org.slug, name: org.name, isPersonal: false, role: 'owner' } });
  }, { auth: true });

  router.patch('/current', async ctx => {
    const body = parse(t.object({
      name: t.string({ min: 2, max: 60 }),
      avatarUrl: t.string({ max: 500 }),
      settings: t.object({}, { passthrough: true })
    }), await ctx.json());

    const patch = {};
    if (body.name) patch.name = body.name;
    if (body.avatarUrl !== undefined) patch.avatar_url = body.avatarUrl;
    if (body.settings) patch.settings = body.settings;
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const [org] = await ctx.auth.db.from('organizations').eq('id', ctx.auth.org.id).update(patch);
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'organization.updated', resource: 'organization', resourceId: ctx.auth.org.id });
    return sendJson(ctx.res, 200, { organization: org });
  }, { auth: 'orgAdmin' });

  router.get('/current/members', async ctx => {
    const rows = await ctx.auth.db
      .from('organization_members')
      .select('user_id,role,created_at,profiles(id,full_name,username,email,avatar_url,last_seen_at)')
      .eq('org_id', ctx.auth.org.id)
      .order('created_at', { ascending: true })
      .limit(200)
      .all();
    return sendJson(ctx.res, 200, {
      members: rows.map(row => ({ userId: row.user_id, role: row.role, joinedAt: row.created_at, profile: row.profiles }))
    });
  }, { auth: true });

  /**
   * Add an existing DiroxCode user to this organization.
   *
   * Email invitations to people without an account require an email provider;
   * that is reported honestly rather than silently doing nothing.
   */
  router.post('/current/members', async ctx => {
    const body = parse(t.object({
      email: emailSchema({ required: true }),
      role: t.enum(['admin', 'member', 'viewer'], { default: 'member' })
    }), await ctx.json());

    if (!hasServiceRole()) {
      throw badRequest('Adding members requires SUPABASE_SERVICE_ROLE_KEY to be configured on the server');
    }

    const profile = await serviceClient().from('profiles').select('id,email,full_name').eq('email', body.email).first();
    if (!profile) throw notFound('No DiroxCode account exists with that email address. Ask them to sign up first.');

    const existing = await ctx.auth.db.from('organization_members').select('user_id').eq('org_id', ctx.auth.org.id).eq('user_id', profile.id).first();
    if (existing) throw conflict('That person is already a member of this organization');

    await ctx.auth.db.insert('organization_members', {
      org_id: ctx.auth.org.id, user_id: profile.id, role: body.role, invited_by: ctx.auth.user.id
    }, { returning: false });

    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'organization.member_added', resource: 'member', resourceId: profile.id, metadata: { role: body.role } });
    return sendJson(ctx.res, 201, { member: { userId: profile.id, role: body.role, profile } });
  }, { auth: 'orgAdmin' });

  router.patch('/current/members/:userId', async ctx => {
    const userId = parse(uuid({ required: true }), ctx.params.userId);
    const body = parse(t.object({ role: t.enum(['admin', 'member', 'viewer'], { required: true }) }), await ctx.json());

    const org = await ctx.auth.db.from('organizations').select('owner_id').eq('id', ctx.auth.org.id).one();
    if (org.owner_id === userId) throw forbidden('The organization owner\'s role cannot be changed');

    const [row] = await ctx.auth.db.from('organization_members').eq('org_id', ctx.auth.org.id).eq('user_id', userId).update({ role: body.role });
    if (!row) throw notFound('That person is not a member of this organization');
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'organization.member_role_changed', resourceId: userId, severity: 'warning', metadata: { role: body.role } });
    return sendJson(ctx.res, 200, { member: row });
  }, { auth: 'orgAdmin' });

  router.delete('/current/members/:userId', async ctx => {
    const userId = parse(uuid({ required: true }), ctx.params.userId);
    const org = await ctx.auth.db.from('organizations').select('owner_id').eq('id', ctx.auth.org.id).one();
    if (org.owner_id === userId) throw forbidden('The organization owner cannot be removed');
    if (userId !== ctx.auth.user.id && !ctx.auth.canAdmin) throw forbidden('Only an owner or admin can remove other members');

    await ctx.auth.db.from('organization_members').eq('org_id', ctx.auth.org.id).eq('user_id', userId).remove();
    audit.record({ orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'organization.member_removed', resourceId: userId, severity: 'warning' });
    return sendJson(ctx.res, 200, { ok: true });
  }, { auth: true });

  return router;
}
