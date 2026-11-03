/**
 * UX-5: one locale and one set of formatters for the whole dashboard (pages had their own copies and mixed
 * en-US, en-GB and the browser default). The UI is English-only; the locale is fixed so dates and numbers read the
 * same for every operator.
 */
export const LOCALE = 'en-GB';

export const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString(LOCALE));

export function fmtDate(value: string | null | undefined, opts: { fallback?: string; timeZone?: string } = {}): string {
  if (!value) return opts.fallback ?? 'unknown';
  return new Date(value).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
}

/** a timestamp up to this far ahead of the browser clock still reads as just now */
const CLOCK_SKEW_MS = 5 * 60_000;

export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const age = (h: number) => (h < 1 ? '< 1 h' : h < 48 ? `${h} h` : `${Math.round(h / 24)} d`);
  // DF-05: a future timestamp is a schedule, never elapsed time (a few minutes ahead is clock skew between server and browser)
  return t > now + CLOCK_SKEW_MS ? `scheduled in ${age(Math.round((t - now) / 3_600_000))}` : `${age(Math.round((now - t) / 3_600_000))} ago`;
}
