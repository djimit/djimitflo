import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const row = (id: string, stop_by: string | null, overdue_reason: string) => ({ id, protocol: 'p.md', started_at: '2026-10-08T00:00:00.000Z', stop_by, overdue: true, overdue_reason });
// DF-05: memory-holdout reached its target n on 2026-10-23 while its stop_by is 2026-10-27 — overdue, but nothing is elapsed since the stop date
vi.mock('../services/experiment-registry', async (orig) => ({
  ...(await orig<typeof import('../services/experiment-registry')>()),
  experimentsReport: () => ({ experiments: [
    row('AT-TARGET', '2026-10-27T00:00:00.000Z', 'every arm reached target 30 without a verdict'),
    row('PAST', '2026-10-20T00:00:00.000Z', 'past stop_by 2026-10-20T00:00:00.000Z without a verdict'),
    row('NO-STOP', null, 'every arm reached target 10 without a verdict'),
  ], overdue: ['AT-TARGET', 'PAST', 'NO-STOP'], no_stop_date: ['NO-STOP'] }),
}));
const { detectStalls } = await import('../services/stall-watch');

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('DF-05: an experiment overdue at target before its stop date has no since; a since is never in the future', () => {
  const stalls = detectStalls(db, NOW, {}).filter((s) => s.subsystem.startsWith('experiment:'));
  const since = Object.fromEntries(stalls.map((s) => [s.subsystem, s.since]));
  expect(since).toEqual({ 'experiment:AT-TARGET': null, 'experiment:PAST': '2026-10-20T00:00:00.000Z', 'experiment:NO-STOP': '2026-10-08T00:00:00.000Z' });
  for (const s of stalls) if (s.since) expect(Date.parse(s.since)).toBeLessThanOrEqual(NOW);
});
