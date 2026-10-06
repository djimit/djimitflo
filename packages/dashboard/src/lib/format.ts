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

export function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const h = Math.round((now - Date.parse(iso)) / 3_600_000);
  return h < 1 ? '< 1 h ago' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
