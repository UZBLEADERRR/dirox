/**
 * Billing surface.
 *
 * Plans are catalogue data the admin owns; this module reads them and reports
 * the organization's current subscription and usage against its limits.
 * Payment provider integration is added on top of this in the billing service.
 */

import { Router, sendJson, readBody } from '../../core/http.js';
import { anonClient, serviceClient, hasServiceRole } from '../../db/supabase.js';
import { caches } from '../../core/cache.js';
import { capabilities, config } from '../../config/env.js';
import { parse, t } from '../../core/validate.js';
import { badRequest, notFound, notConfigured } from '../../core/errors.js';
import { audit } from '../observability/audit.js';
import { logger } from '../../core/logger.js';
import { getPlanUsage } from './usage.js';
import { createCheckoutSession, createPortalSession, handleWebhookEvent, verifyWebhookSignature } from './stripe.js';

function shapePlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    priceMonthlyCents: row.price_monthly_cents,
    priceYearlyCents: row.price_yearly_cents,
    currency: row.currency,
    includedCreditsCents: row.included_credits_cents,
    maxProjects: row.max_projects,
    maxTasksPerDay: row.max_tasks_per_day,
    maxTokensPerMonth: row.max_tokens_per_month === null ? null : Number(row.max_tokens_per_month),
    maxCostPerMonthCents: row.max_cost_per_month_cents,
    maxConcurrentAgents: row.max_concurrent_agents,
    maxRepoMb: row.max_repo_mb,
    requestsPerMinute: row.requests_per_minute,
    allowedModelTiers: row.allowed_model_tiers,
    features: row.features,
    isDefault: row.is_default
  };
}

export function billingRoutes() {
  const router = new Router();

  /** Public pricing. Cached briefly so the landing page is cheap to serve. */
  router.get('/plans', async ctx => {
    const plans = await caches.settings.wrap('public:plans', async () => {
      const rows = await anonClient().from('plans').select('*').eq('is_public', true)
        .order('sort_order', { ascending: true }).limit(20).all();
      return rows.map(shapePlan);
    }, 120_000);
    ctx.res.setHeader('Cache-Control', 'public, max-age=120');
    return sendJson(ctx.res, 200, { plans });
  }, { auth: false });

  /** What this organization is on, and how much of it is used. */
  router.get('/subscription', async ctx => {
    const usage = await getPlanUsage(ctx.auth);
    return sendJson(ctx.res, 200, {
      ...usage,
      paymentsEnabled: capabilities().billing
    });
  }, { auth: true });

  /**
   * Start a checkout for a plan change.
   * The price comes from the plan row; the client only names the plan.
   */
  router.post('/checkout', async ctx => {
    if (!capabilities().billing) throw notConfigured('Stripe');
    const body = parse(t.object({
      planCode: t.string({ required: true, max: 40 }),
      interval: t.enum(['monthly', 'yearly'], { default: 'monthly' })
    }), await ctx.json());

    const plan = await ctx.auth.db.from('plans').select('*').eq('code', body.planCode).eq('is_public', true).first();
    if (!plan) throw notFound('That plan is not available');
    if (!plan.price_monthly_cents && !plan.price_yearly_cents) {
      throw badRequest('This plan is not self-serve. Contact us to arrange it.');
    }

    const session = await createCheckoutSession({
      org: ctx.auth.org,
      plan,
      interval: body.interval,
      ownerEmail: ctx.auth.user.email,
      returnUrl: `${config.appUrl || ''}/app/settings/billing`
    });

    audit.record({
      orgId: ctx.auth.org.id, actorId: ctx.auth.user.id, action: 'billing.checkout_started',
      resource: 'plan', resourceId: plan.code, severity: 'warning', metadata: { interval: body.interval }
    });

    return sendJson(ctx.res, 200, { url: session.url });
  }, { auth: 'orgAdmin', rateLimit: 'heavy' });

  /** The Stripe-hosted portal: payment methods, cancellation, invoices. */
  router.post('/portal', async ctx => {
    if (!capabilities().billing) throw notConfigured('Stripe');
    const session = await createPortalSession({
      org: ctx.auth.org,
      ownerEmail: ctx.auth.user.email,
      returnUrl: `${config.appUrl || ''}/app/settings/billing`
    });
    return sendJson(ctx.res, 200, { url: session.url });
  }, { auth: 'orgAdmin', rateLimit: 'heavy' });

  /**
   * Stripe webhook.
   *
   * Reads the raw bytes, verifies the signature against them, and only then
   * parses. Unauthenticated by necessity — the signature is the authentication.
   */
  router.post('/webhook', async ctx => {
    if (!config.stripe.webhookSecret) throw notConfigured('STRIPE_WEBHOOK_SECRET');

    const raw = (await readBody(ctx.req, 1024 * 1024)).toString('utf8');
    verifyWebhookSignature(raw, ctx.req.headers['stripe-signature']);

    let event;
    try { event = JSON.parse(raw); }
    catch { throw badRequest('Webhook body is not valid JSON'); }

    // Acknowledge fast; a slow handler makes Stripe retry a event we already have.
    const result = await handleWebhookEvent(event).catch(error => {
      logger.error('webhook handler failed', { eventId: event?.id, reason: error?.message });
      return { status: 'failed' };
    });

    return sendJson(ctx.res, 200, { received: true, ...result });
  }, { auth: false, rateLimit: 'webhook' });

  router.get('/invoices', async ctx => {
    const rows = await ctx.auth.db.from('invoices')
      .select('id,number,status,total_cents,currency,period_start,period_end,hosted_url,pdf_url,issued_at,paid_at')
      .eq('org_id', ctx.auth.org.id).order('created_at').limit(50).all();
    return sendJson(ctx.res, 200, { invoices: rows });
  }, { auth: 'orgAdmin' });

  return router;
}

export { shapePlan };
