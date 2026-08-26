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

export function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);

  if (abs < 45_000) return 'just now';
  const units = [
    [60_000, 'minute', 60_000],
    [3_600_000, 'hour', 3_600_000],
    [86_400_000, 'day', 86_400_000],
    [604_800_000, 'week', 604_800_000],
    [2_592_000_000, 'month', 2_592_000_000]
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [threshold, unit, divisor] of units) {
    if (abs < threshold * 60 || unit === 'month') {
      const amount = Math.round(-diff / divisor);
      if (Math.abs(amount) < 1) continue;
      return formatter.format(amount, unit);
    }
  }
  return new Date(value).toLocaleDateString();
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
