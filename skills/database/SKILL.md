---
name: database
description: Schema, migrations and queries that survive contact with real data.
when: designing tables, writing a migration, changing a schema, or a query that is slow.
---

# Database

## A migration runs on data that already exists

Every migration will run against a table with rows in it, on a database
somebody depends on, possibly twice.

- **Idempotent.** `create table if not exists`, `add column if not exists`,
  `drop constraint if exists` before adding it. A migration that fails on its
  second run will fail on somebody's retry.
- **Reversible in effect, if not in file.** Adding a column is safe. Dropping
  one destroys data — do it in a later migration, after the code that used it
  is gone.
- **A new non-null column needs a default**, or the migration fails on the
  first existing row.
- **Never edit a migration that has run anywhere.** Write another one.

Test it by applying the whole chain to an empty database, then applying the
whole chain again.

## Constraints belong in the schema

A rule enforced only in application code is a rule that is already broken in
the data. Foreign keys with an explicit `on delete`, `check` for the values a
column may hold, `unique` for what must not repeat, `not null` wherever null
would be meaningless. The database is the last place that can say no.

## Row-level security, where it exists

With Postgres or Supabase, filtering by user in the query is one forgotten
`where` away from a leak. Enable RLS on every table and write the policy. Then
the leak requires deleting a policy, not forgetting a clause.

## Index what you filter and sort by

Every `where` and `order by` in a hot query wants an index, and a compound
index must be ordered to match: equality columns first, then the range or sort
column. Check with `explain analyze` rather than by intuition — the planner
knows things you do not.

Do not index everything. Each index is paid for on every write.

## The query mistakes worth knowing

- **N+1.** A loop that queries is one query that should have joined. Look for
  a query inside an iteration.
- **`select *`** across a network sends columns nobody reads.
- **Unbounded results.** Every list query needs a limit, from the first day.
- **Counting to paginate.** `count(*)` over a large table is slow; use a
  cursor on an indexed column.

## Money and time

Money is an integer of the smallest unit, never a float. `0.1 + 0.2` is not
`0.3`, and a rounding error in a ledger is a bug people notice.

Time is stored in UTC with a timezone-aware type, converted only for display.
