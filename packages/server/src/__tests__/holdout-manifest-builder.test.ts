import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildHoldoutManifest, freezeHoldoutFromManifest, manifestSha256 } from '../services/holdout-manifest';
import type { GymTask } from '../services/gym-task-miner';
import type { FailureTask } from '../services/gym-failure-tasks';
import type { MutantTask } from '../services/gym-mutants';

// Epoch 1 (operator 14-10): the prepared manifest was built from gym-failure exposure only and missed 7 tasks whose files a
// dream saw through failed maker leases' changed_files. The builder now uses the same exclusions as the freeze, so a built
// manifest cannot miss either source; kept tasks of a base manifest stay, refused ones are dropped with their reason.
const SRC = (i: number) => `packages/server/src/services/s${String(i).padStart(2, '0')}.ts`;
const MINED: GymTask[] = Array.from({ length: 60 }, (_, i) => ({ commit: `c${String(i).padStart(2, '0')}`, source: SRC(i), tests: [], sourceLines: 9 }));
const WT = (i: number, target: string): FailureTask => ({ commit: `fail:r${i}`, kind: 'write_test', base: 'b'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`,
  tests: [], target, sourceLines: 9, run_id: `r-${i}`, lane: 'exports', mutants: [], oracle: 'mutant_kill' });
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-d1', 'baseline', 'strategy_lines', '[\"x\"]', 'dream', 'retired', ?, ?)")
    .run('2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z');
  // exposure through a failed maker lease only (no gym failure): its changed files s03 and a test file
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('lr1', 'test-gap', 'closed', 'failed', '[]', '{}', '[]', '[]', '{}', '2026-10-10T05:00:00Z', '2026-10-10T05:00:00Z')`).run();
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l1', 'lr1', 'maker', 'opencode', 'failed', ?, '2026-10-10T06:00:00Z', '2026-10-10T06:00:00Z')`)
    .run(JSON.stringify({ changed_files: JSON.stringify([SRC(3), 'packages/server/src/__tests__/w1.test.ts']), failure_reason: 'tests still red' }));
});
afterEach(() => db.close());

it('excludes tasks exposed only through failed maker leases changed_files (mined source and write_test file)', () => {
  const pool = { mined: MINED, writeTest: [WT(0, SRC(50)), WT(1, SRC(51)), WT(2, SRC(52))] };
  const { manifest, dropped } = buildHoldoutManifest(db, { epoch: 1, size: 40, pool, tiers: [3, 4, 5, 6], provenance: { origin_sha: 'x' }, now: '2026-10-14T12:00:00Z' });
  const mined = (manifest.tasks.mined as Array<{ key: string }>).map((t) => t.key);
  expect(mined).toHaveLength(40);
  expect(mined).not.toContain('c03');
  expect((manifest.tasks.write_test as Array<{ key: string }>).map((t) => t.key)).toEqual(['fail:r0', 'fail:r2']);
  expect(dropped).toEqual([]);
  expect(manifest.evaluation_policy).toMatchObject({ holdout_size: 40, deciding: 'mutant', mined_role: 'no_regression' });
  expect(manifest.manifest_sha256).toBe(manifestSha256(manifest));
  // a manifest built with the same rule passes the freeze checks (here: dry run)
  let n = 0;
  const makeMutant = (tier: number): MutantTask => { const i = n++; return { commit: `mut:b:${SRC(20 + (i % 30))}:${tier}:${i}`, base: 'b', source: SRC(20 + (i % 30)), tests: [], sourceLines: 9, mutant: 'x', tier }; };
  const r = freezeHoldoutFromManifest(db, manifest, { epoch: 1, expectedSha256: manifest.manifest_sha256 as string, pool, makeMutant, origin: { sha: 'x', version: null }, env: {}, dryRun: true });
  expect(r.status).toBe('VALID_DRY_RUN');
  expect(r.status === 'VALID_DRY_RUN' && r.counts).toMatchObject({ mined: 40, mutant: 40, write_test: 2 });
});

it('rebuilding from a base manifest keeps its eligible tasks, drops refused ones with the reason and refills deterministically', () => {
  const base = { manifest_version: 1, holdout_epoch: 1, tasks: { mined: ['c03', 'c10', 'c11'].map((k) => ({ key: k, source: SRC(Number(k.slice(1))) })), write_test: [{ key: 'fail:r1', source: 'packages/server/src/__tests__/w1.test.ts' }] }, manifest_sha256: '' };
  base.manifest_sha256 = manifestSha256(base);
  const pool = { mined: MINED, writeTest: [WT(1, SRC(51))] };
  const a = buildHoldoutManifest(db, { epoch: 1, size: 20, pool, tiers: [3], base, provenance: {}, now: '2026-10-14T12:00:00Z' });
  const b = buildHoldoutManifest(db, { epoch: 1, size: 20, pool, tiers: [3], base, provenance: {}, now: '2026-10-14T12:00:00Z' });
  expect(a.manifest).toEqual(b.manifest);
  const mined = (a.manifest.tasks.mined as Array<{ key: string }>).map((t) => t.key);
  expect(mined).toContain('c10'); expect(mined).toContain('c11'); expect(mined).not.toContain('c03'); expect(mined).toHaveLength(20);
  expect(a.dropped).toEqual([
    { key: 'c03', reason: expect.stringMatching(/dream-exposed source/) },
    { key: 'fail:r1', reason: expect.stringMatching(/dream-exposed source/) },
  ]);
  expect(a.added).toHaveLength(18);
  expect((a.manifest.provenance as Record<string, unknown>).rebuilt_from_sha256).toBe(base.manifest_sha256);
});

it('a pool too small for the size is reported, never padded', () => {
  const r = buildHoldoutManifest(db, { epoch: 1, size: 40, pool: { mined: MINED.slice(0, 30) }, tiers: [3], provenance: {}, now: '2026-10-14T12:00:00Z' });
  expect((r.manifest.tasks.mined as unknown[]).length).toBe(29);
  expect(r.shortfall).toBe(11);
});

it('a manifest that declares mutant deciding but has no mutant part is refused', () => {
  const m: Record<string, unknown> = { manifest_version: 1, holdout_epoch: 1, evaluation_policy: { holdout_size: 20, deciding: 'mutant' }, tasks: { mined: MINED.slice(0, 20).map((t) => ({ key: t.commit, source: t.source })) } };
  m.manifest_sha256 = manifestSha256(m);
  const r = freezeHoldoutFromManifest(db, m, { epoch: 1, expectedSha256: m.manifest_sha256 as string, pool: { mined: MINED }, origin: { sha: null, version: null }, env: {}, dryRun: true });
  expect(r.status === 'REFUSED' && r.violations.join(' ')).toMatch(/deciding/);
});
