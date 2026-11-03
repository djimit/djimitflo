/**
 * U4d (re-20261029 E-assumptions A4 / C5): the daily digest printed "Loop PRs settled: 0 (0 survived)" when the
 * settlement evidence could not be read — the operator reads that as a measurement. Unknown renders 'unknown', never 0.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

const evidence = vi.hoisted(() => ({ fail: false }));
vi.mock('../services/evolution-evidence', async (orig) => {
  const real = await orig<typeof import('../services/evolution-evidence')>();
  return { ...real, buildEvolutionEvidence: (...args: Parameters<typeof real.buildEvolutionEvidence>) => {
    if (evidence.fail) throw new Error('evidence unreadable');
    return real.buildEvolutionEvidence(...args);
  } };
});
const { buildDigest } = await import('../services/operator-push');

/** capability chain (stall-watch): a configured environment */
const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };
const NOON = Date.parse('2026-10-06T12:00:00Z');
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); evidence.fail = false; });
afterEach(() => db.close());

it('unreadable evidence: settled / survived / unsettled are null and read unknown, not 0', () => {
  evidence.fail = true;
  const d = buildDigest(db, NOON, C);
  expect(d.data).toMatchObject({ loop_prs_settled: null, loop_prs_survived: null, drafts_unsettled: null });
  expect(d.text).toContain('Loop PRs settled: unknown (unknown survived)');
  expect(d.text).toContain('Loop PRs unsettled: unknown');
  expect(d.text).not.toMatch(/Loop PRs settled: 0/);
});

it('readable evidence on an empty DB still reports measured zeros', () => {
  const d = buildDigest(db, NOON, C);
  expect(d.data).toMatchObject({ loop_prs_settled: 0, loop_prs_survived: 0, drafts_unsettled: 0 });
  expect(d.text).toContain('Loop PRs settled: 0 (0 survived)');
  expect(d.text).toContain('Loop PRs unsettled: 0');
});
