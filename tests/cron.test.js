/**
 * Cron.
 *
 * Two things here are easy to get wrong and expensive when they are: the
 * or-rule between the two day fields, which reads like an and, and daylight
 * saving, where "every day at 09:00" has to stay at 09:00 rather than drifting
 * an hour twice a year. Both have their own tests below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCron, isValidCron, nextRun, describeCron } from '../src/core/cron.js';

/** The next run as wall-clock in a timezone, for readable assertions. */
const at = (expression, from, timeZone = 'UTC') => {
  const date = nextRun(expression, { from: new Date(from), timeZone });
  return date
    ? new Intl.DateTimeFormat('sv-SE', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date).replace(' ', 'T')
    : null;
};

// ─── reading an expression ──────────────────────────────────────────────────

test('the ordinary shapes parse', () => {
  assert.deepEqual([...parseCron('30 9 * * *').minute], [30]);
  assert.deepEqual([...parseCron('0 */6 * * *').hour], [0, 6, 12, 18]);
  assert.deepEqual([...parseCron('0 0 * * mon-fri').dayOfWeek], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 1 jan *').month], [1]);
  assert.deepEqual([...parseCron('0 9,17 * * *').hour], [9, 17]);
});

test('sunday is both 0 and 7, as it is everywhere else', () => {
  assert.deepEqual([...parseCron('0 0 * * 7').dayOfWeek], [0]);
  assert.deepEqual([...parseCron('0 0 * * 0').dayOfWeek], [0]);
});

test('the shorthands people reach for first work', () => {
  assert.equal(parseCron('@daily').source, '0 0 * * *');
  assert.equal(parseCron('@hourly').source, '0 * * * *');
  assert.equal(parseCron('@weekly').source, '0 0 * * 0');
});

test('nonsense is refused, and says which field', () => {
  assert.throws(() => parseCron('0 0 * *'), /five fields/);
  assert.throws(() => parseCron('99 0 * * *'), /minute field/);
  assert.throws(() => parseCron('0 25 * * *'), /hour field/);
  assert.throws(() => parseCron('0 0 32 * *'), /day of month/);
  assert.throws(() => parseCron('0 0 * * 9'), /day of week/);
  assert.throws(() => parseCron('0 0 * * */0'), /step/);
  assert.throws(() => parseCron('30-10 * * * *'), /backwards/);
  assert.equal(isValidCron('not a cron'), false);
  assert.equal(isValidCron('0 9 * * mon'), true);
});

// ─── when it next runs ──────────────────────────────────────────────────────

test('the next run is the next matching minute, never the current one', () => {
  // 09:30 exactly must not fire again for the same minute.
  assert.equal(at('30 9 * * *', '2026-03-10T09:30:00Z'), '2026-03-11T09:30');
  assert.equal(at('30 9 * * *', '2026-03-10T09:29:00Z'), '2026-03-10T09:30');
  assert.equal(at('*/15 * * * *', '2026-03-10T09:31:00Z'), '2026-03-10T09:45');
});

test('a weekday schedule skips the weekend', () => {
  // 2026-03-13 is a Friday; the next weekday run is the Monday.
  assert.equal(at('0 9 * * mon-fri', '2026-03-13T10:00:00Z'), '2026-03-16T09:00');
});

test('when both day fields are set, either one fires it', () => {
  /*
     `0 0 1 * 1` is the first of the month AND every Monday — an or, despite
     reading as an and. Every cron implementation does this, so matching them
     matters more than being sensible about it.

     From Tuesday 2026-03-03, the next is Monday the 9th, not the 1st of April.
  */
  assert.equal(at('0 0 1 * 1', '2026-03-03T12:00:00Z'), '2026-03-09T00:00');

  // And with only the day of month set, weekdays are irrelevant.
  assert.equal(at('0 0 1 * *', '2026-03-03T12:00:00Z'), '2026-04-01T00:00');
});

test('a date that never comes back is reported rather than looped over', () => {
  // The thirtieth of February.
  assert.equal(nextRun('0 0 30 2 *', { from: new Date('2026-01-01T00:00:00Z') }), null);
});

// ─── time zones, which is where this gets real ──────────────────────────────

test('a wall-clock time stays put across a daylight-saving change', () => {
  /*
     Europe/London moves to BST on 2026-03-29. "Every day at 09:00" must be
     09:00 local on both sides of it — which in UTC is 09:00 before and 08:00
     after. Computing in UTC and hoping produces a schedule that drifts an
     hour twice a year, and nobody notices until it matters.
  */
  const before = nextRun('0 9 * * *', { from: new Date('2026-03-28T10:00:00Z'), timeZone: 'Europe/London' });
  assert.equal(before.toISOString(), '2026-03-29T08:00:00.000Z');
  assert.equal(at('0 9 * * *', '2026-03-28T10:00:00Z', 'Europe/London'), '2026-03-29T09:00');

  const winter = nextRun('0 9 * * *', { from: new Date('2026-01-10T10:00:00Z'), timeZone: 'Europe/London' });
  assert.equal(winter.toISOString(), '2026-01-11T09:00:00.000Z');
});

test('a schedule is kept in the timezone it was written in', () => {
  // 09:00 in Tashkent is 04:00 UTC, all year — Uzbekistan has no DST.
  const run = nextRun('0 9 * * *', { from: new Date('2026-06-01T00:00:00Z'), timeZone: 'Asia/Tashkent' });
  assert.equal(run.toISOString(), '2026-06-01T04:00:00.000Z');
});

// ─── saying it back ─────────────────────────────────────────────────────────

test('a schedule reads back as something a person can check', () => {
  assert.equal(describeCron('0 9 * * *', 'Asia/Tashkent'), 'Every day at 09:00 (Asia/Tashkent)');
  assert.equal(describeCron('30 8 * * mon', 'UTC'), 'Every Monday at 08:30 (UTC)');
  assert.equal(describeCron('0 0 1 * *', 'UTC'), 'On day 1 of the month at 00:00 (UTC)');
  assert.match(describeCron('15 * * * *', 'UTC'), /Every hour at :15/);
});

test('a time that does not exist is skipped, not fired an hour early', () => {
  /*
     Europe/London springs forward at 01:00 on 2026-03-29, so 01:30 that
     morning simply does not happen. A schedule set for 01:30 daily must skip
     that day rather than quietly firing at 00:30 or 02:30 — a backup that
     runs an hour early once a year is a bug nobody attributes correctly.
  */
  const run = nextRun('30 1 * * *', { from: new Date('2026-03-28T12:00:00Z'), timeZone: 'Europe/London' });
  assert.equal(at('30 1 * * *', '2026-03-28T12:00:00Z', 'Europe/London'), '2026-03-30T01:30');
  assert.equal(run.toISOString(), '2026-03-30T00:30:00.000Z');
});

test('finding a next run is fast enough to do on every tick', () => {
  // The minute-by-minute version took 60 seconds to decide the 30th of
  // February never comes. The scheduler does this for every schedule it owns.
  const started = Date.now();
  assert.equal(nextRun('0 0 30 2 *', { from: new Date('2026-01-01T00:00:00Z') }), null);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `deciding a never-matching expression took ${elapsed}ms`);
});
