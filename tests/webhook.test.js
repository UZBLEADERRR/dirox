import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_value';
const { verifyWebhookSignature, encodeForm } = await import('../src/modules/billing/stripe.js');

function sign(body, secret = 'whsec_test_secret_value', timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });

test('a correctly signed webhook verifies', () => {
  assert.equal(verifyWebhookSignature(body, sign(body)), true);
});

test('a webhook signed with the wrong secret is rejected', () => {
  assert.throws(() => verifyWebhookSignature(body, sign(body, 'whsec_wrong')), /does not match/i);
});

test('a tampered body is rejected', () => {
  const header = sign(body);
  const tampered = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', amount: 999999 });
  assert.throws(() => verifyWebhookSignature(tampered, header), /does not match/i);
});

test('a replayed old event is rejected', () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhookSignature(body, sign(body, undefined, old)), /tolerance window/i);
});

test('a missing or malformed signature is rejected', () => {
  assert.throws(() => verifyWebhookSignature(body, ''), /Missing Stripe signature/i);
  assert.throws(() => verifyWebhookSignature(body, 'garbage'), /Malformed/i);
  assert.throws(() => verifyWebhookSignature(body, 't=123'), /Malformed/i);
});

test('form encoding handles the nested shapes Stripe expects', () => {
  assert.equal(encodeForm({ mode: 'subscription' }), 'mode=subscription');
  assert.equal(
    encodeForm({ line_items: { 0: { price: 'price_1', quantity: 1 } } }),
    'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1'
  );
  // Null and undefined are omitted, not sent as the strings "null"/"undefined".
  assert.equal(encodeForm({ a: 'x', b: null, c: undefined }), 'a=x');
});
