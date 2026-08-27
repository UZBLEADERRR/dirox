/**
 * Cron expressions, without a dependency.
 *
 * Five fields — minute, hour, day of month, month, day of week — and the two
 * rules everybody gets wrong:
 *
 *   1. When both day-of-month and day-of-week are restricted, a cron matches
 *      if *either* does. `0 0 1 * 1` is the first of the month and every
 *      Monday, not the first of the month when it falls on a Monday. This is
 *      genuinely strange and it is what every cron implementation does, so
 *      matching it matters more than being sensible.
 *   2. Times are wall-clock in a timezone, so "every day at 09:00" has to stay
 *      at 09:00 across a daylight-saving change. That means computing the next
 *      run in the target timezone rather than in UTC and hoping.
 *
 * The search walks a day at a time and only then tries the times on a matching
 * day, bounded at a year. The first version walked minute by minute — obviously
 * correct, and unusably slow: `0 0 30 2 *`, the thirtieth of February, cost
 * half a million calls into `Intl.DateTimeFormat` before reporting that it will
 * never run. A day is at most a handful.
 */

import { badRequest } from './errors.js';

/** Names people actually write, so an expression can be read aloud. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Shorthands, because `@daily` is what people reach for first. */
const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  // Seven is Sunday as well as zero, everywhere cron is used; the value is
  // normalised to zero once it has been accepted.
  { name: 'day of week', min: 0, max: 7, names: DAYS }
];

/** How far ahead the search will look before giving up. */
const HORIZON_DAYS = 366;

function parseField(raw, field) {
  const values = new Set();
  const text = String(raw).trim().toLowerCase();
  if (!text) throw badRequest(`The ${field.name} field is empty.`);

  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);

    if (!Number.isInteger(step) || step < 1) {
      throw badRequest(`"${part}" is not a valid step in the ${field.name} field.`);
    }

    let from;
    let to;

    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (range.includes('-')) {
      const [start, end] = range.split('-').map(value => toNumber(value, field));
      from = start;
      to = end;
    } else {
      from = toNumber(range, field);
      to = stepText === undefined ? from : field.max;
    }

    if (from > to) throw badRequest(`"${range}" runs backwards in the ${field.name} field.`);

    for (let value = from; value <= to; value += step) {
      // Sunday is both 0 and 7 in every cron anybody has used.
      values.add(field.name === 'day of week' && value === 7 ? 0 : value);
    }
  }

  return values;
}

function toNumber(token, field) {
  const text = String(token).trim();
  if (field.names) {
    const index = field.names.indexOf(text.slice(0, 3));
    if (index >= 0) return field.name === 'month' ? index + 1 : index;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < field.min || value > field.max) {
    throw badRequest(`"${token}" is not valid in the ${field.name} field (${field.min}–${field.max}).`);
  }
  return value;
}

/**
 * @param {string} expression
 * @returns {{minute:Set, hour:Set, dayOfMonth:Set, month:Set, dayOfWeek:Set,
 *            restrictsDayOfMonth:boolean, restrictsDayOfWeek:boolean, source:string}}
 */
export function parseCron(expression) {
  const text = String(expression || '').trim().toLowerCase();
  const resolved = ALIASES[text] ?? text;
  const parts = resolved.split(/\s+/);

  if (parts.length !== 5) {
    throw badRequest(`A schedule needs five fields (minute hour day month weekday); "${expression}" has ${parts.length}.`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseField(part, FIELDS[index]));

  return {
    minute, hour, dayOfMonth, month, dayOfWeek,
    // Whether a field was restricted decides the or-rule below, and `*` is
    // the only way to say "unrestricted".
    restrictsDayOfMonth: parts[2] !== '*',
    restrictsDayOfWeek: parts[4] !== '*',
    source: resolved
  };
}

/** Valid, and worth saying so before a schedule is stored. */
export function isValidCron(expression) {
  try { parseCron(expression); return true; } catch { return false; }
}

/**
 * The wall-clock parts of an instant, in a named timezone.
 *
 * `Intl.DateTimeFormat` is the only thing in the platform that knows what
 * 09:00 in Tashkent means on a given day, and it is built in.
 */
function partsIn(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some locales render midnight as 24; both mean the same instant.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute)
  };
}

/** How far a timezone is from UTC at a given instant, in milliseconds. */
function offsetAt(date, timeZone) {
  const parts = partsIn(date, timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asIfUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/**
 * A wall-clock time in a timezone, as the instant it names.
 *
 * Two passes, because the offset depends on the instant and the instant
 * depends on the offset. The first guess is right except within an hour of a
 * daylight-saving change, and the second pass fixes those.
 *
 * Returns null when the time does not exist — 02:30 on a spring-forward
 * morning is not a time, and a schedule set for it must skip the day rather
 * than silently fire an hour early.
 */
function instantOf({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);

  let instant = new Date(wall - offsetAt(new Date(wall), timeZone));
  const settled = offsetAt(instant, timeZone);
  const corrected = new Date(wall - settled);
  if (corrected.getTime() !== instant.getTime()) instant = corrected;

  const back = partsIn(instant, timeZone);
  const exists = back.year === year && back.month === month && back.day === day
    && back.hour === hour && back.minute === minute;

  return exists ? instant : null;
}

function dayMatches(schedule, { month, day, weekday }) {
  if (!schedule.month.has(month)) return false;

  const byDay = schedule.dayOfMonth.has(day);
  const byWeekday = schedule.dayOfWeek.has(weekday);

  /*
     The rule nobody expects.

     With both day fields restricted, a cron fires when *either* matches — so
     `0 0 1 * 1` is the first of the month and every Monday. It reads like an
     and; it is an or. Every implementation does this, so matching them is
     more important than being reasonable.
  */
  if (schedule.restrictsDayOfMonth && schedule.restrictsDayOfWeek) return byDay || byWeekday;
  if (schedule.restrictsDayOfMonth) return byDay;
  if (schedule.restrictsDayOfWeek) return byWeekday;
  return true;
}

/**
 * When does this next run, after `from`?
 *
 * Walked a day at a time rather than a minute at a time. The minute-by-minute
 * version was obviously correct and unusably slow: an expression that never
 * matches — the thirtieth of February — cost half a million calls into
 * `Intl.DateTimeFormat` before reporting it. A day is at most a handful.
 *
 * @param {string|object} expression
 * @param {{from?:Date, timeZone?:string}} [options]
 * @returns {Date|null} null when it will never run inside a year
 */
export function nextRun(expression, { from = new Date(), timeZone = 'UTC' } = {}) {
  const schedule = typeof expression === 'string' ? parseCron(expression) : expression;

  // The top of the next minute: a schedule must not fire twice for the minute
  // it was created in.
  const after = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const start = partsIn(after, timeZone);

  const hours = [...schedule.hour].sort((a, b) => a - b);
  const minutes = [...schedule.minute].sort((a, b) => a - b);

  for (let offset = 0; offset <= HORIZON_DAYS; offset += 1) {
    // Calendar arithmetic, in UTC, purely to walk dates — no instant is meant
    // by this, so a timezone would only get in the way.
    const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const date = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      weekday: cursor.getUTCDay()
    };

    if (!dayMatches(schedule, date)) continue;

    for (const hour of hours) {
      for (const minute of minutes) {
        const instant = instantOf({ ...date, hour, minute }, timeZone);
        if (instant && instant.getTime() >= after.getTime()) return instant;
      }
    }
  }

  // The thirtieth of February, and anything else that cannot happen.
  return null;
}

/** A schedule read back in words, for a person confirming what they set up. */
export function describeCron(expression, timeZone = 'UTC') {
  const schedule = parseCron(expression);
  const every = field => field.size > 20;

  const at = every(schedule.hour) || every(schedule.minute)
    ? null
    : [...schedule.hour].sort((a, b) => a - b)
      .flatMap(hour => [...schedule.minute].sort((a, b) => a - b)
        .map(minute => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`))
      .slice(0, 6)
      .join(', ');

  if (schedule.restrictsDayOfWeek) {
    const days = [...schedule.dayOfWeek].sort((a, b) => a - b)
      .map(day => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]);
    return `Every ${days.join(', ')}${at ? ` at ${at}` : ''} (${timeZone})`;
  }
  if (schedule.restrictsDayOfMonth) {
    const days = [...schedule.dayOfMonth].sort((a, b) => a - b).slice(0, 6).join(', ');
    return `On day ${days} of the month${at ? ` at ${at}` : ''} (${timeZone})`;
  }
  if (at) return `Every day at ${at} (${timeZone})`;
  if (schedule.minute.size === 1) return `Every hour at :${String([...schedule.minute][0]).padStart(2, '0')} (${timeZone})`;
  return `${schedule.source} (${timeZone})`;
}

export { ALIASES, HORIZON_DAYS, partsIn, instantOf, dayMatches };
