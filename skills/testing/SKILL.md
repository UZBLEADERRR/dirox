---
name: testing
description: Writing tests that would actually catch the bug, and proving a fix.
when: adding or changing tests, fixing a bug, or being asked whether something works.
---

# Testing

A test suite's value is entirely in what it catches. A suite that passes on
broken code is worse than none, because it is trusted.

## Write the failing test first

For a bug: reproduce it in a test, watch it fail for the reason you expect,
then fix it. A test written after the fix proves nothing — it was written
against code that already passes.

Say what failed and what passes now, with the output. "Tests pass" is not a
report; "the test that reproduced the crash now passes, 41 pass" is.

## Assert the behaviour, not the shape

```js
// Proves the function was called. Catches nothing.
assert.ok(result);

// Proves the thing anybody cares about.
assert.equal(result.total, 1250);
assert.equal(result.currency, 'UZS');
```

If you cannot describe what a test would catch, delete it.

## The cases worth writing

For any function, in this order:

1. The ordinary case, with real values.
2. The boundary — zero, one, the limit, the limit plus one.
3. The empty case — empty string, empty array, null, missing field.
4. The failure — what happens when the thing it depends on throws.
5. The case in the bug report, verbatim.

Property tests where the rule is general: "encoding then decoding returns the
original, for every input".

## Test names are sentences

`test('a refund larger than the payment is refused')` tells you what broke
when it goes red. `test('refund test 2')` sends you to read the code.

## What not to mock

Mock what is slow, external or non-deterministic: the network, the clock,
randomness, a paid API. Everything else runs for real. A test where every
collaborator is a mock tests the mocks.

If the code is hard to test without mocking half of it, that is a fact about
the code.

## Never do this to make a suite green

- Skip, disable, or delete a failing test.
- Loosen an assertion until it passes.
- Add a retry to hide a race.
- Call a failure flaky without finding the cause. "Flake" is not a diagnosis.

## Before you say it works

Run the whole suite, not the file you changed. Paste the count. If something
is still failing, say which and why — a partial result reported honestly is
worth more than a green one that is not true.
