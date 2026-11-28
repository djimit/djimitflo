import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * The two most-read engineering memory rules as a deterministic check (prod 2026-11-23: 540 of 1,030 rule reads, and the
 * holdout showed no effect of reading them — NE-002). A ratchet: the count of each pattern in server source may fall,
 * never rise. Fixed one? Lower the baseline. Need a new one that is genuinely safe? Raise it in the same PR and say why.
 */
const SRC = path.resolve(__dirname, '..');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p);
  return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
});
const count = (re: RegExp) => files(SRC).reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(re)?.length ?? 0), 0);

it('rule "INSERT OR IGNORE on a score cache": no new INSERT OR IGNORE (it silently keeps the first value; use ON CONFLICT DO UPDATE for anything that can change)', () => {
  expect(count(/INSERT OR IGNORE/g)).toBeLessThanOrEqual(62);
});

it('rule "Unguarded JSON extract from model output": no new JSON.parse straight on a process stdout (use firstJsonObject / model-json and handle the no-JSON case)', () => {
  expect(count(/JSON\.parse\([\w.?]*stdout/g)).toBeLessThanOrEqual(8);
});
