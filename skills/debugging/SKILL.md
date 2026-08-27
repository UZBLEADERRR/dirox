---
name: debugging
description: Finding the cause of a bug instead of guessing at it.
when: something is failing, crashing, flaky, or behaving differently from what was expected.
---

# Debugging

Guessing is fast and wrong most of the time, and every wrong guess changes
code that was not broken. The method below is slower for one step and faster
for the whole job.

## Reproduce before you read

A bug you cannot reproduce is a bug you cannot prove you fixed. Get to a
command that fails, every time, in one step. Write it down.

If it only fails sometimes, find what differs: order, timing, state left over
from a previous run, a real clock, a real network.

## Read the whole error

The first line names the symptom; the stack names the place. Read to the
bottom — the deepest frame in *your* code is usually the answer, not the
library frame above it. A `TypeError: cannot read 'x' of undefined` is never
about `x`; it is about wherever the undefined came from, which is earlier.

## Narrow before you fix

Halve the space each time:

- Does it fail with the smallest possible input?
- Does it fail with the network stubbed? With the database stubbed?
- Which commit introduced it? `git log -S'someString'` finds when a line
  appeared; `git bisect` finds the commit when the history is long.
- Add one log line at the boundary between "known good" and "known bad", and
  move it.

## State the cause before you change anything

Out loud, in one sentence: "the session is undefined because the cookie is
parsed before the middleware that sets it runs." If you cannot write that
sentence, you have not found it yet and the next edit is a guess.

## Fix the cause

A fix that makes the symptom go away without explaining it will come back
under a different symptom. Optional chaining that silences a crash leaves the
undefined in place.

## Prove it

1. The reproduction now passes.
2. The whole suite still passes.
3. A test exists that would have caught this.

## When you are stuck

- Re-read the reproduction: is it actually reproducing the reported bug?
- Check the assumption you have not checked, which is usually that the code
  running is the code you are reading. Print something and confirm.
- Look at what changed recently around the failure, not around your theory.
- Say what you have ruled out. A clear "it is not X, Y or Z, and here is why"
  is progress worth reporting.
