/** Presentation helpers. Cost stays secondary in the UI, so it formats small. */

export function formatCost(micros, { precise = false } = {}) {
  const dollars = Number(micros || 0) / 1_000_000;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01 && !precise) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(precise ? 4 : 3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function formatTokens(count) {
  const n = Number(count || 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat(undefined).format(Number(value || 0));
}

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  const n = Number(ms || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Units, largest first. The first one the elapsed time reaches is the one
 * used, which is what makes two days read as "2 days ago" rather than
 * "48 hours ago".
 */
const UNITS = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
];

export function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);

  if (abs < 45_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, divisor] of UNITS) {
    if (abs >= divisor) return formatter.format(Math.round(-diff / divisor), unit);
  }
  return 'just now';
}

/**
 * The same instant in as few characters as possible: "3m", "2h", "5d".
 * For a sidebar, where the age of a row is a hint and not a fact.
 */
export function shortTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const abs = Math.abs(Date.now() - then);

  if (abs < 60_000) return 'now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
  if (abs < 604_800_000) return `${Math.round(abs / 86_400_000)}d`;
  if (abs < 2_592_000_000) return `${Math.round(abs / 604_800_000)}w`;
  if (abs < 31_536_000_000) return `${Math.round(abs / 2_592_000_000)}mo`;
  return `${Math.round(abs / 31_536_000_000)}y`;
}

export function formatDate(value, options = { dateStyle: 'medium' }) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

export function initials(name, email) {
  const source = String(name || email || '').trim();
  if (!source) return '?';
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${Number(count) === 1 ? singular : plural}`;
}
