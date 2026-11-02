import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, frozenHoldoutCommits } from '../services/genome-registry';
import { gatedEvidence } from '../services/dream-evolution';
import { freezeHoldoutFromManifest, manifestSha256 } from '../services/holdout-manifest';
import type { GymTask } from '../services/gym-task-miner';

// #819 × #823: an epoch frozen from a manifest is read by Gate A's eligibility — its freeze time (created_at = frozen_at) is
// the epoch membership boundary: gated attempts after the freeze are ELIGIBLE_*, before it INELIGIBLE; calibration tasks
// are frozen in the epoch but never part of the deciding set.
const SPECIES = 'atomic@llama-router';
const FROZEN_AT = '2026-10-14T10:00:00Z';
const MINED: GymTask[] = Array.from({ length: 24 }, (_, i) => ({ commit: `c${String(i).padStart(2, '0')}`, source: `packages/server/src/services/s${i}.ts`, tests: [], sourceLines: 9 }));
const DECIDING = MINED.slice(0, 20).map((t) => t.commit); const CALIBRATION = ['c20', 'c21'];
let db: Database.Database; let seq = 0;
const run = (commit: string, ok: boolean, at: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(`r${seq++}`, JSON.stringify({
  gym: { commit, species: SPECIES, genome: BASELINE_GENOME, prod_gates: 1 },
  gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red', ...(ok ? { prod_gates: { lint: 'pass', 'type-check': 'pass' } } : {}) } }), at, at);

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const m: Record<string, unknown> = { manifest_version: 1, holdout_epoch: 1, evaluation_policy: { holdout_size: 20 },
    tasks: { mined: [...DECIDING, ...CALIBRATION].map((k) => ({ key: k, source: MINED.find((t) => t.commit === k)!.source })) }, calibration: { mined: CALIBRATION } };
  m.manifest_sha256 = manifestSha256(m);
  const r = freezeHoldoutFromManifest(db, m, { epoch: 1, expectedSha256: String(m.manifest_sha256), pool: { mined: MINED }, origin: { sha: 'x', version: null }, now: FROZEN_AT, env: {} });
  expect(r.status).toBe('FROZEN');
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('gated attempts after the manifest freeze count, attempts before it do not', () => {
  run('c00', true, '2026-10-14T09:00:00Z'); // before the freeze: INELIGIBLE
  run('c01', true, '2026-10-14T11:00:00Z'); // after: ELIGIBLE_PASS
  run('c02', false, '2026-10-14T11:00:00Z'); // after: ELIGIBLE_FAIL
  const deciding = frozenHoldoutCommits(db);
  expect(deciding).toEqual(DECIDING);
  const e = gatedEvidence(db, SPECIES, BASELINE_GENOME, deciding);
  expect([...e.byKey.keys()].sort()).toEqual(['c01', 'c02']);
  expect(e.byKey.get('c01')?.status).toBe('success'); expect(e.byKey.get('c02')?.status).toBe('failure');
  expect(e.classes).toEqual({ INELIGIBLE: 1, ELIGIBLE_PASS: 1, ELIGIBLE_FAIL: 1 });
});

it('calibration-role tasks never decide, even with eligible gated attempts after the freeze', () => {
  for (const c of CALIBRATION) run(c, false, '2026-10-14T11:00:00Z');
  const deciding = frozenHoldoutCommits(db);
  for (const c of CALIBRATION) expect(deciding).not.toContain(c);
  const e = gatedEvidence(db, SPECIES, BASELINE_GENOME, deciding);
  expect(e.byKey.size).toBe(0); expect(e.classes).toEqual({});
});

it('P0-12: a quarantined attempt (hack-flagged success) is never a trial win', () => {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('q', 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(JSON.stringify({
    gym: { commit: 'c03', species: SPECIES, genome: BASELINE_GENOME, prod_gates: 1 },
    gym_result: { status: 'quarantined', reason: 'tests green, source only', hack_flags: ['tests_touched'], prod_gates: { lint: 'pass' } } }), '2026-10-14T11:00:00Z', '2026-10-14T11:00:00Z');
  const e = gatedEvidence(db, SPECIES, BASELINE_GENOME, frozenHoldoutCommits(db));
  // neither pass nor fail: the task stays UNKNOWN for the trial (E2), so a hack can never decide a promotion
  expect(e.byKey.has('c03')).toBe(false);
  expect(e.classes).toEqual({ INELIGIBLE: 1 });
});
