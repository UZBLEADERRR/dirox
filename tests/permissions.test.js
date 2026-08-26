import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, RISK, TRUST } from '../src/agent/permissions.js';

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
