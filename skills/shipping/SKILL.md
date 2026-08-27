---
name: shipping
description: What to check before saying a change is done.
when: finishing a piece of work, preparing a deploy, or reporting on what was built.
---

# Shipping

The difference between "I wrote the code" and "it works" is a short list of
checks, and skipping them is what makes a change come back.

## Before you call it done

1. **Run it.** Not the tests — the actual thing. Start the app, open the page,
   call the endpoint. A change that has never been executed is a draft.
2. **Run the whole suite**, not the file you touched. Report the count.
3. **Read your own diff** as though somebody else wrote it and you are looking
   for the mistake. Debug output left in, a rename half-applied, a file that
   should not be committed.
4. **Check the console and the logs** for anything new.
5. **Try the failure path**, not only the happy one.

## Report what actually happened

Say what changed, which files, what you tested, what still does not work, and
what it cost. If something is broken, say so plainly — a known problem stated
is worth more than a green report that is not true.

Never claim a check you did not run.

## A deploy is a change to something people are using

- Migrations run before the code that needs them, and are backward compatible
  with the code still running.
- Environment variables the new code reads exist in the target before it
  starts.
- Health check passes, and means something more than "the process is alive".
- Know how to undo it, before you do it.

## Do not widen the work

Fix what was asked. A refactor bundled into a bug fix makes both harder to
review and impossible to revert separately. If you find something else worth
doing, say so and leave it.

## What to leave behind

A commit message that explains *why*, since the diff already shows what. A
test that would catch this again. A comment where the reason is not obvious
from the code — and no comment where it is.
