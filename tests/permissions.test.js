import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, RISK, TRUST } from '../src/agent/permissions.js';
import { configuredOwner } from '../src/modules/auth/service.js';

const tool = risk => ({ name: 'x', risk });

test('read-only tools always run', () => {
  for (const trust of Object.values(TRUST)) {
    assert.equal(decide(tool(RISK.SAFE), { trust }).decision, 'allow');
  }
});

test('SAFE trust asks before any modification', () => {
  assert.equal(decide(tool(RISK.WRITE), { trust: TRUST.SAFE }).decision, 'ask');
  assert.equal(decide(tool(RISK.INSTALL), { trust: TRUST.SAFE }).decision, 'ask');
});

test('CONFIRM trust allows edits but asks for installs', () => {
  assert.equal(decide(tool(RISK.WRITE), { trust: TRUST.CONFIRM }).decision, 'allow');
  assert.equal(decide(tool(RISK.INSTALL), { trust: TRUST.CONFIRM }).decision, 'ask');
});

test('AUTONOMOUS never covers destructive or outward actions', () => {
  assert.equal(decide(tool(RISK.WRITE), { trust: TRUST.AUTONOMOUS }).decision, 'allow');
  assert.equal(decide(tool(RISK.INSTALL), { trust: TRUST.AUTONOMOUS }).decision, 'allow');
  // The boundary that matters holds even at maximum trust.
  assert.equal(decide(tool(RISK.DESTRUCTIVE), { trust: TRUST.AUTONOMOUS }).decision, 'ask');
  assert.equal(decide(tool(RISK.OUTWARD), { trust: TRUST.AUTONOMOUS }).decision, 'ask');
});

test('a viewer role cannot cause a write at any trust level', () => {
  for (const trust of Object.values(TRUST)) {
    assert.equal(decide(tool(RISK.WRITE), { trust, role: 'viewer' }).decision, 'deny');
    assert.equal(decide(tool(RISK.SAFE), { trust, role: 'viewer' }).decision, 'allow');
  }
});

test('read-only modes deny writes regardless of trust', () => {
  for (const mode of ['ask', 'review', 'plan']) {
    const result = decide(tool(RISK.WRITE), { trust: TRUST.AUTONOMOUS, mode });
    assert.equal(result.decision, 'deny', `${mode} mode must deny writes`);
  }
});

// ─── the first administrator ────────────────────────────────────────────────
//
// A fresh deployment has no way to create one from inside the product: the
// admin panel is the only place to grant access, and it is the thing being
// locked. The deployment's configuration names them instead — which makes the
// confirmation check the whole security boundary.

test('a configured owner address is granted administration', () => {
  const list = ['owner@example.com'];
  assert.equal(configuredOwner({ email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }, list).ok, true);
  assert.equal(configuredOwner({ email: 'OWNER@Example.com ', email_confirmed_at: '2026-01-01T00:00:00Z' }, list).ok, true,
    'case and whitespace must not decide who owns the platform');
});

test('an unconfirmed address never inherits the platform', () => {
  const list = ['owner@example.com'];
  // Otherwise anyone who typed the owner's address into a signup form would
  // become an administrator without ever proving they hold it.
  const verdict = configuredOwner({ email: 'owner@example.com', email_confirmed_at: null }, list);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unconfirmed');
});

test('an address that is not configured is refused', () => {
  const list = ['owner@example.com'];
  for (const email of ['someone@example.com', 'owner@example.com.evil.test', '', null]) {
    assert.equal(configuredOwner({ email, email_confirmed_at: '2026-01-01T00:00:00Z' }, list).ok, false, String(email));
  }
});
