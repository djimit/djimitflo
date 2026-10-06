import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { LOCALE, fmt, fmtDate, since } from './format';

describe('UX-5: one locale and shared formatters', () => {
  it('UX-5: numbers use the fixed en-GB locale and a dash for missing values', () => {
    expect(LOCALE).toBe('en-GB');
    expect(fmt(1234567)).toBe('1,234,567');
    expect(fmt(0)).toBe('0');
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
  });

  it('UX-5: dates use one short en-GB format; a missing date says so', () => {
    expect(fmtDate('2026-10-06T07:05:00Z', { timeZone: 'UTC' })).toBe('06/10/2026, 07:05');
    expect(fmtDate(null)).toBe('unknown');
    expect(fmtDate(undefined, { fallback: '—' })).toBe('—');
  });

  it('UX-5: since() reports age in hours, then days', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(since(null, now)).toBe('never');
    expect(since('2026-10-06T11:40:00Z', now)).toBe('< 1 h ago');
    expect(since('2026-10-06T07:00:00Z', now)).toBe('5 h ago');
    expect(since('2026-10-01T12:00:00Z', now)).toBe('5 d ago');
  });
});

/** UX-5: the UI is English-only; these Dutch fragments were translated and must not come back. */
const DUTCH = [/\bNog geen\b/, /\bgeen capabilities\b/, /\bbeslist door\b/, /\bgekopieerd\b/, /\bkopieer\b/, /\bniet gepromoot\b/,
  /\balleen nu zichtbaar\b/, /\bCode voor\b/, /\bBeste strategie\b/, /\bbijdragen\b/, /· gestart /, /· laatst /, /\baanklop/, /\bDe emitter draait\b/, /\bAangeklopt\b/, /\bwachtend\b/, /'uitgenodigd'|'gebeten'|'verlopen'/, /\bgebeten\b/, /\bnooit verbonden\b/];
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});

it('UX-5: no Dutch UI strings in the dashboard source', () => {
  const root = join(__dirname, '..');
  const hits = files(root).flatMap((p) => DUTCH.filter((re) => re.test(readFileSync(p, 'utf8'))).map((re) => `${p.slice(root.length)}: ${re}`));
  expect(hits).toEqual([]);
});
