/**
 * The scheduler.
 *
 * Everything interesting here is a failure case, because a scheduler runs
 * unattended and the ways it goes wrong are the ways it costs money: a late
 * tick firing every missed run at once, two workers firing the same schedule,
 * and an automation that fails hourly forever until somebody reads the bill.
 *
 * The database is replaced with an in-memory stand-in that behaves like the
 * real query builder for the handful of operations the scheduler uses.
 * Everything between `tick()` and that stand-in is the real code.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../src/', import.meta.url).href;

/** Rows the fake database holds, and the jobs that were queued. */
let rows = [];
let queued = [];
let inserted = [];

/** A query builder with just the operations the scheduler asks for. */
function table(name) {
  const filters = [];
  const builder = {
    select() { return builder; },
    eq(column, value) { filters.push([column, value]); return builder; },
    lte(column, value) { filters.push([column, value, 'lte']); return builder; },
    order() { return builder; },
    limit() { return builder; },
    matching() {
      return rows.filter(row => filters.every(([column, value, op]) =>
        op === 'lte' ? String(row[column] ?? '') <= String(value) : row[column] === value));
    },
    /*
       Reads return copies, as a real database does.

       Handing out the stored object makes the optimistic claim untestable:
       when one tick updates the row, the other tick's copy of `next_run_at`
       changes underneath it, so its "only if nobody moved this" filter matches
       the new value and fires the schedule a second time.
    */
    async all() { return builder.matching().map(row => ({ ...row })); },
    async first() { const [row] = builder.matching(); return row ? { ...row } : null; },
    async update(patch, { returning } = {}) {
      const hit = builder.matching();
      for (const row of hit) Object.assign(row, patch);
      return returning ? hit.map(row => ({ ...row })) : [];
    },
    async remove() {
      const hit = builder.matching();
      rows = rows.filter(row => !hit.includes(row));
      return hit;
    }
  };
  void name;
  return builder;
}

{
  mock.module(`${SRC}db/supabase.js`, {
    namedExports: {
      hasServiceRole() { return true; },
      serviceClient() {
        return {
          from: table,
          async insert(name, values, { returning } = {}) {
            const row = { id: `${name}-${inserted.length + 1}`, ...values };
            inserted.push(row);
            if (name === 'schedules') rows.push(row);
            return returning === false ? null : row;
          }
        };
      },
      userClient() { throw new Error('not used'); }
    }
  });

  mock.module(`${SRC}queue/queue.js`, {
    namedExports: {
      QUEUES: { agent: 'agent', index: 'index', maintenance: 'maintenance' },
      async enqueue(job) { queued.push(job); return { id: `job-${queued.length}` }; }
    }
  });

  mock.module(`${SRC}ai/catalog.js`, {
    namedExports: {
      async featureEnabled() { return true; },
      async systemSetting(_key, fallback) { return fallback; }
    }
  });
}

const { tick, computeNextRun, recordFailure, FAILURE_LIMIT } = await import(`${SRC}queue/scheduler.js`);

function schedule(overrides = {}) {
  return {
    id: 'sched-1',
    org_id: 'org-1',
    user_id: 'user-1',
    project_id: 'project-1',
    name: 'Nightly dependency check',
    objective: 'Check for outdated dependencies and open a pull request if any are behind.',
    mode: 'agent',
    cron: '0 3 * * *',
    timezone: 'UTC',
    trust: 'confirm',
    budget_micros: 100_000,
    enabled: true,
    next_run_at: '2026-03-10T03:00:00.000Z',
    run_count: 0,
    consecutive_failures: 0,
    ...overrides
  };
}

function fresh(...schedules) {
  rows = schedules;
  queued = [];
  inserted = [];
}

test('a schedule that is due creates a task and queues it', async () => {
  fresh(schedule());

  const result = await tick(new Date('2026-03-10T03:00:30Z'));

  assert.equal(result.fired, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'agent.run');
  assert.equal(queued[0].payload.trust, 'confirm');
  // Nobody is present to approve a plan, so nothing stops to ask for one.
  assert.equal(queued[0].payload.confirmPlan, false);

  const task = inserted.find(row => row.schedule_id === 'sched-1');
  assert.equal(task.status, 'queued');
  assert.equal(task.objective, schedule().objective);
});

test('a schedule that is not due yet is left alone', async () => {
  fresh(schedule());
  const result = await tick(new Date('2026-03-10T02:59:00Z'));
  assert.equal(result.fired, 0);
  assert.equal(queued.length, 0);
});

test('a disabled schedule never fires', async () => {
  fresh(schedule({ enabled: false }));
  assert.equal((await tick(new Date('2026-03-11T03:00:00Z'))).fired, 0);
});

test('a run moves the clock forward before the task is created', async () => {
  /*
     The claim has to happen first. If the task were created before
     `next_run_at` moved, a container that restarted in between would find the
     schedule still due and run it again — and the second run would not know
     about the first.
  */
  fresh(schedule());
  await tick(new Date('2026-03-10T03:00:30Z'));

  assert.equal(rows[0].next_run_at, '2026-03-11T03:00:00.000Z');
  assert.equal(rows[0].run_count, 1);
  assert.ok(rows[0].last_run_at);
});

test('a tick that is hours late fires once, not once per missed hour', async () => {
  /*
     A deploy, a restart or a stuck worker leaves an hourly schedule far
     behind. Catching up run by run would spend a day of budget in a minute
     and produce twenty-four identical pull requests.
  */
  fresh(schedule({ cron: '0 * * * *', next_run_at: '2026-03-10T00:00:00.000Z' }));

  const result = await tick(new Date('2026-03-11T00:00:00Z'));

  assert.equal(result.fired, 1, 'the missed runs were replayed');
  assert.equal(queued.length, 1);
  // And the next run is computed from now, not from where it fell behind.
  assert.equal(rows[0].next_run_at, '2026-03-11T01:00:00.000Z');
});

test('two ticks racing fire a schedule once between them', async () => {
  fresh(schedule());

  const [first, second] = await Promise.all([
    tick(new Date('2026-03-10T03:00:30Z')),
    tick(new Date('2026-03-10T03:00:30Z'))
  ]);

  assert.equal(first.fired + second.fired, 1, 'the same schedule fired twice');
  assert.equal(queued.length, 1);
});

test('a schedule that will never fire again turns itself off', async () => {
  // The 29th of February 2027 does not exist.
  fresh(schedule({ cron: '0 0 29 2 *', next_run_at: '2026-02-28T00:00:00.000Z' }));

  await tick(new Date('2026-02-28T00:01:00Z'));
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].next_run_at, null);
});

test('a schedule that keeps failing stops, rather than failing hourly forever', async () => {
  const row = schedule({ consecutive_failures: FAILURE_LIMIT - 1 });
  fresh(row);

  const client = { from: table };
  await recordFailure(client, row, 'the project was deleted');

  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].consecutive_failures, FAILURE_LIMIT);
  assert.match(rows[0].last_status, /project was deleted/);
});

test('one failure is not enough to stop a schedule', async () => {
  const row = schedule();
  fresh(row);

  await recordFailure({ from: table }, row, 'a flaky network');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].consecutive_failures, 1);
});

test('an unreadable expression does not crash the tick', async () => {
  fresh(schedule({ cron: 'not a cron' }));
  // It cannot be projected forward, so it stops rather than spinning.
  await tick(new Date('2026-03-10T03:00:30Z'));
  assert.equal(rows[0].enabled, false);
});

test('the next run honours the schedule\'s own timezone', () => {
  const next = computeNextRun(
    { cron: '0 9 * * *', timezone: 'Asia/Tashkent' },
    new Date('2026-06-01T00:00:00Z')
  );
  assert.equal(next.toISOString(), '2026-06-01T04:00:00.000Z');
});
