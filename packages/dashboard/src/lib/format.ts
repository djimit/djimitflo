/**
 * UX-5: one locale and one set of formatters for the whole dashboard (pages had their own copies and mixed
 * en-US, en-GB and the browser default). The UI is English-only; the locale is fixed so dates and numbers read the
 * same for every operator.
 */
export const LOCALE = 'en-GB';

export const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString(LOCALE));

/**
 * Epoch ms of a server timestamp. SQLite `datetime('now')` text (`2026-10-01 18:36:22`) is UTC but carries no zone, and
 * Date.parse reads a zone-less date-time as browser-local time; such values are read as UTC (as the server's isoMs does).
 */
export function parseTs(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

export function fmtDate(value: string | null | undefined, opts: { fallback?: string; timeZone?: string } = {}): string {
  if (!value) return opts.fallback ?? 'unknown';
  return new Date(parseTs(value)).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
}

/** a timestamp up to this far ahead of the browser clock still reads as just now */
const CLOCK_SKEW_MS = 5 * 60_000;

export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = parseTs(iso);
  if (Number.isNaN(t)) return 'unknown';
  const age = (h: number) => (h < 1 ? '< 1 h' : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`);
  // DF-05: a future timestamp is a schedule, never elapsed time (a few minutes ahead is clock skew between server and browser)
  return t > now + CLOCK_SKEW_MS ? `scheduled in ${age(Math.round((t - now) / 3_600_000))}` : `${age(Math.round((now - t) / 3_600_000))} ago`;
}
