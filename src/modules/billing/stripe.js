/**
 * Stripe integration.
 *
 * Written against the REST API directly rather than the SDK, to keep the
 * deployment dependency-free. Two rules are absolute:
 *
 *   1. Frontend payment state is never trusted. A subscription becomes active
 *      because a verified webhook said so, not because a browser said so.
 *   2. Every webhook signature is verified before the payload is parsed, and
 *      each event is processed at most once.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/env.js';
import { badRequest, forbidden, notConfigured, upstreamFailed } from '../../core/errors.js';
import { serviceClient, hasServiceRole } from '../../db/supabase.js';
import { logger } from '../../core/logger.js';
import { audit } from '../observability/audit.js';
import { notify } from '../notifications/routes.js';
import { invalidatePlanUsage } from './usage.js';

const API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;

function requireStripe() {
  if (!config.stripe.secretKey) throw notConfigured('Stripe');
}

/** Stripe takes form-encoded bodies, including for nested objects. */
function encodeForm(data, prefix = '', parts = []) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) encodeForm(value, name, parts);
    else if (Array.isArray(value)) value.forEach((item, index) => encodeForm({ [index]: item }, name, parts));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

async function stripeRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  requireStripe();
  const headers = {
    Authorization: `Bearer ${config.stripe.secretKey}`,
    'Stripe-Version': '2024-06-20'
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? encodeForm(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  }).catch(error => { throw upstreamFailed('Could not reach Stripe', { reason: error?.message }); });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    logger.warn('stripe request failed', { path, status: response.status, code: data?.error?.code });
    throw upstreamFailed(data?.error?.message || `Stripe returned ${response.status}`);
  }
  return data;
}

/**
 * Verify a webhook signature.
 *
 * The raw body must be the exact bytes Stripe sent — parsing it first and
 * re-serialising would change the signature and silently break verification.
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.stripe.webhookSecret) throw notConfigured('STRIPE_WEBHOOK_SECRET');
  if (!signatureHeader) throw forbidden('Missing Stripe signature');

  const parts = Object.fromEntries(
    String(signatureHeader).split(',').map(part => part.split('=').map(piece => piece.trim()))
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;

  if (!timestamp || !signature) throw forbidden('Malformed Stripe signature');

  // Reject replays of an old, otherwise-valid event.
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > SIGNATURE_TOLERANCE_SECONDS) throw forbidden('Stripe signature timestamp is outside the tolerance window');

  const expected = createHmac('sha256', config.stripe.webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden('Stripe signature does not match');

  return true;
}

// ─── customer and checkout ──────────────────────────────────────────────────

export async function ensureCustomer(org, ownerEmail) {
  const subscription = await serviceClient().from('subscriptions')
    .select('id,stripe_customer_id').eq('org_id', org.id)
    .in('status', ['trialing', 'active', 'past_due', 'canceled']).first();

  if (subscription?.stripe_customer_id) return subscription.stripe_customer_id;

  const customer = await stripeRequest('/customers', {
    method: 'POST',
    idempotencyKey: `customer:${org.id}`,
    body: {
      email: ownerEmail,
      name: org.name,
      metadata: { org_id: org.id, org_slug: org.slug }
    }
  });

  if (subscription?.id) {
    await serviceClient().from('subscriptions').eq('id', subscription.id)
      .update({ stripe_customer_id: customer.id });
  }
  return customer.id;
}

/**
 * Create a hosted checkout session.
 * The plan's price id comes from the database, never from the client.
 */
export async function createCheckoutSession({ org, plan, interval, ownerEmail, returnUrl }) {
  requireStripe();
  const priceId = interval === 'yearly' ? plan.stripe_price_id_yearly : plan.stripe_price_id_monthly;
  if (!priceId) {
    throw badRequest(`The ${plan.name} plan has no Stripe price configured for ${interval} billing. An administrator must set it.`);
  }

  const customerId = await ensureCustomer(org, ownerEmail);

  return stripeRequest('/checkout/sessions', {
    method: 'POST',
    body: {
      mode: 'subscription',
      customer: customerId,
      line_items: { 0: { price: priceId, quantity: 1 } },
      success_url: `${returnUrl}?checkout=success`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
      client_reference_id: org.id,
      subscription_data: { metadata: { org_id: org.id, plan_code: plan.code } },
      allow_promotion_codes: true
    }
  });
}

/** The Stripe-hosted portal, where a customer manages their own subscription. */
export async function createPortalSession({ org, ownerEmail, returnUrl }) {
  const customerId = await ensureCustomer(org, ownerEmail);
  return stripeRequest('/billing_portal/sessions', {
    method: 'POST',
    body: { customer: customerId, return_url: returnUrl }
  });
}

// ─── webhook handling ───────────────────────────────────────────────────────

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
]);

const STATUS_MAP = {
  trialing: 'trialing', active: 'active', past_due: 'past_due',
  canceled: 'canceled', unpaid: 'past_due', incomplete: 'incomplete',
  incomplete_expired: 'canceled', paused: 'paused'
};

/**
 * Process a verified webhook event, exactly once.
 * @returns {Promise<{status:string, reason?:string}>}
 */
export async function handleWebhookEvent(event) {
  if (!hasServiceRole()) throw notConfigured('Webhook processing (SUPABASE_SERVICE_ROLE_KEY)');
  const client = serviceClient();

  // The unique constraint on (provider, external_id) is the idempotency lock:
  // a duplicate delivery loses the race and is ignored.
  try {
    await client.insert('webhook_events', {
      provider: 'stripe', external_id: event.id, event_type: event.type,
      status: 'received', payload: { type: event.type, created: event.created }
    }, { returning: false });
  } catch (error) {
    if (error.code === 'conflict' || error.status === 409) {
      logger.debug('duplicate stripe event ignored', { eventId: event.id });
      return { status: 'duplicate' };
    }
    throw error;
  }

  if (!HANDLED.has(event.type)) {
    await markEvent(event.id, 'ignored');
    return { status: 'ignored', reason: 'event type not handled' };
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await onSubscriptionChanged(event.data.object, event.type === 'customer.subscription.deleted');
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await onInvoice(event.data.object, event.type === 'invoice.paid');
        break;
      default:
        break;
    }
    await markEvent(event.id, 'processed');
    return { status: 'processed' };
  } catch (error) {
    await markEvent(event.id, 'failed', error.message);
    logger.error('stripe webhook processing failed', { eventId: event.id, type: event.type, reason: error?.message });
    throw error;
  }
}

async function markEvent(externalId, status, error = null) {
  await serviceClient().from('webhook_events')
    .eq('provider', 'stripe').eq('external_id', externalId)
    .update({ status, error, processed_at: new Date().toISOString() })
    .catch(() => {});
}

async function onCheckoutCompleted(session) {
  const orgId = session.client_reference_id || session.metadata?.org_id;
  if (!orgId || !session.subscription) return;

  // Read the subscription back from Stripe rather than trusting the session.
  const subscription = await stripeRequest(`/subscriptions/${session.subscription}`);
  await onSubscriptionChanged(subscription, false, orgId);
}

async function onSubscriptionChanged(subscription, deleted, explicitOrgId) {
  const client = serviceClient();
  const orgId = explicitOrgId || subscription.metadata?.org_id;
  if (!orgId) {
    logger.warn('stripe subscription has no org_id metadata', { subscriptionId: subscription.id });
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const interval = subscription.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';

  // Map the Stripe price back to a plan through the database, so the plan a
  // customer receives is always one an administrator configured.
  let plan = null;
  if (priceId) {
    plan = await client.from('plans').select('id,code,name')
      .or(`stripe_price_id_monthly.eq.${priceId},stripe_price_id_yearly.eq.${priceId}`)
      .first().catch(() => null);
  }
  if (!plan && subscription.metadata?.plan_code) {
    plan = await client.from('plans').select('id,code,name').eq('code', subscription.metadata.plan_code).first();
  }
  if (!plan) {
    logger.warn('no plan matches the stripe price', { priceId, subscriptionId: subscription.id });
    return;
  }

  const status = deleted ? 'canceled' : (STATUS_MAP[subscription.status] || 'active');

  const existing = await client.from('subscriptions').select('id,plan_id,status').eq('org_id', orgId)
    .in('status', ['trialing', 'active', 'past_due', 'incomplete', 'paused']).first();

  const values = {
    org_id: orgId,
    plan_id: plan.id,
    status,
    billing_interval: interval,
    current_period_start: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000).toISOString() : new Date().toISOString(),
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : new Date(Date.now() + 30 * 86_400_000).toISOString(),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
    stripe_customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    stripe_subscription_id: subscription.id
  };

  if (existing) await client.from('subscriptions').eq('id', existing.id).update(values);
  else await client.insert('subscriptions', values, { returning: false });

  await client.from('organizations').eq('id', orgId).update({ plan_id: plan.id });
  invalidatePlanUsage(orgId);

  audit.record({
    orgId, actorType: 'system', action: deleted ? 'billing.subscription_cancelled' : 'billing.subscription_updated',
    resource: 'subscription', resourceId: subscription.id, severity: 'warning',
    metadata: { plan: plan.code, status, interval }
  });

  const owner = await client.from('organizations').select('owner_id,name').eq('id', orgId).first();
  if (owner?.owner_id) {
    await notify({
      userId: owner.owner_id, orgId, kind: 'billing',
      severity: status === 'past_due' ? 'critical' : 'success',
      title: deleted ? 'Subscription cancelled' : `Subscription updated: ${plan.name}`,
      body: status === 'past_due'
        ? 'A payment failed. Update your payment method to avoid interruption.'
        : `Your organization is now on the ${plan.name} plan.`,
      link: '/app/settings/billing'
    });
  }

  logger.info('subscription synchronised from stripe', { orgId, plan: plan.code, status });
}

async function onInvoice(invoice, paid) {
  const client = serviceClient();
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

  const subscription = await client.from('subscriptions')
    .select('id,org_id').eq('stripe_customer_id', customerId).first();
  if (!subscription) return;

  await client.insert('invoices', {
    org_id: subscription.org_id,
    subscription_id: subscription.id,
    number: invoice.number || null,
    status: paid ? 'paid' : 'open',
    amount_cents: invoice.subtotal ?? 0,
    tax_cents: invoice.tax ?? 0,
    total_cents: invoice.total ?? 0,
    currency: invoice.currency || 'usd',
    period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
    period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
    hosted_url: invoice.hosted_invoice_url || null,
    pdf_url: invoice.invoice_pdf || null,
    stripe_invoice_id: invoice.id,
    line_items: (invoice.lines?.data || []).slice(0, 20).map(line => ({
      description: line.description, amount: line.amount, quantity: line.quantity
    })),
    issued_at: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
    paid_at: paid ? new Date().toISOString() : null
  }, { upsert: true, onConflict: 'stripe_invoice_id', returning: false }).catch(() => {});

  if (!paid) {
    const org = await client.from('organizations').select('owner_id').eq('id', subscription.org_id).first();
    if (org?.owner_id) {
      await notify({
        userId: org.owner_id, orgId: subscription.org_id, kind: 'billing', severity: 'critical',
        title: 'Payment failed',
        body: 'We could not charge your payment method. Update it to keep your subscription active.',
        link: '/app/settings/billing'
      });
    }
  }
}

export { stripeRequest, encodeForm, HANDLED, STATUS_MAP };
