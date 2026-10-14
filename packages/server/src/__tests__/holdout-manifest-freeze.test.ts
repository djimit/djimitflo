import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { frozenHoldoutCommits, mutantHoldoutKeys, writeTestHoldoutKeys } from '../services/genome-registry';
import { freezeHoldoutFromManifest, manifestSha256, type FreezeOptions } from '../services/holdout-manifest';
import type { GymTask } from '../services/gym-task-miner';
import type { FailureTask } from '../services/gym-failure-tasks';
import type { MutantTask } from '../services/gym-mutants';

// Holdout epoch 1: an operator-prepared manifest is frozen only after every task is checked eligible NOW (not frozen,
// not TG-001, not trial-attempted, not dream-exposed, no exposed source, no derived contamination). Nothing else changes.
const SRC = (i: number) => `packages/server/src/services/s${String(i).padStart(2, '0')}.ts`;
const MINED: GymTask[] = Array.from({ length: 40 }, (_, i) => ({ commit: `c${String(i).padStart(2, '0')}`, source: SRC(i), tests: [`t${i}.test.ts`], sourceLines: 9 }));
const WT = (i: number, target = SRC(30 + i)): FailureTask => ({ commit: `fail:run-${i}`, kind: 'write_test', base: `b${i}`.padEnd(40, '0'), source: `packages/server/src/__tests__/w${i}.test.ts`,
  tests: [`packages/server/src/__tests__/w${i}.test.ts`], target, sourceLines: 9, run_id: `run-${i}`, lane: 'exports', mutants: [{ key: `mut:w${i}:1`, content: 'x' }], oracle: 'mutant_kill' });
const WT_POOL = Array.from({ length: 8 }, (_, i) => WT(i));
let db: Database.Database;
let seq = 0;

const run = (metadata: unknown, at: string, id = `r${seq++}`) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify(metadata), at, at);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  // epoch 0 already frozen: c00..c01 mined
  for (const c of ['c00', 'c01']) db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)').run(c, '2026-10-01T00:00:00Z');
  // one dream genome; the gym failures of the 24 h before it were dream inputs: commit c05 and the source of c07 are exposed
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-d1', 'baseline', 'strategy_lines', '[\"x\"]', 'dream', 'retired', ?, ?)")
    .run('2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z');
  run({ gym: { commit: 'c05', source: 'packages/server/src/services/other.ts', species: 'atomic@llama-router' }, gym_result: { status: 'failure', reason: 'tests still red' } }, '2026-10-10T06:00:00Z');
  run({ gym: { commit: 'mut:zz:x', source: SRC(7), species: 'atomic@llama-router' }, gym_result: { status: 'failure', reason: 'tests still red' } }, '2026-10-10T07:00:00Z', 'run-exposed');
  // outside the window (2 days before): not an exposure
  run({ gym: { commit: 'c08', source: SRC(8), species: 'atomic@llama-router' }, gym_result: { status: 'failure', reason: 'tests still red' } }, '2026-10-08T06:00:00Z');
  // a trial attempt on c09, and a TG-001 task key c11
  run({ gym: { commit: 'c09', source: SRC(9), species: 'atomic@llama-router', genome: 'g-d1' }, gym_result: { status: 'success', reason: 'ok' } }, '2026-10-11T06:00:00Z');
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES ('tg1', 'TG-001', 'c11', 'A', 0, 'pending', 0, '2026-10-01')").run();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); });

const CLEAN = MINED.slice(12, 32).map((t) => t.commit); // c12..c31: none frozen, exposed, attempted or TG
function manifest(over: { mined?: string[]; write_test?: FailureTask[]; holdout_size?: number; calibration?: Record<string, string[]>; mutant?: unknown; epoch?: number } = {}) {
  const m: Record<string, unknown> = {
    manifest_version: 1, holdout_epoch: over.epoch ?? 1, status: 'PROPOSED_NOT_FROZEN', freeze_timestamp: null,
    provenance: { origin_main: '52297ade' },
    evaluation_policy: { holdout_size: over.holdout_size ?? 20 },
    tasks: {
      mined: (over.mined ?? CLEAN).map((k) => ({ key: k, source: MINED.find((t) => t.commit === k)?.source ?? 'unknown.ts' })),
      write_test: (over.write_test ?? []).map((t) => ({ key: t.commit, source: t.source })),
      ...(over.mutant === undefined ? {} : { mutant: over.mutant }),
    },
    ...(over.calibration ? { calibration: over.calibration } : {}),
  };
  m.manifest_sha256 = manifestSha256(m);
  return m;
}
const opts = (m: Record<string, unknown>, extra: Partial<FreezeOptions> = {}): FreezeOptions => ({
  epoch: 1, expectedSha256: String(m.manifest_sha256), pool: { mined: MINED, writeTest: WT_POOL }, origin: { sha: 'abc1234', version: '0.5.8' },
  now: '2026-10-14T10:00:00Z', env: {}, ...extra,
});

it('a valid manifest freezes the epoch atomically, with provenance (manifest sha, freeze ts, origin sha/version)', () => {
  const m = manifest({ write_test: WT_POOL.slice(0, 6) });
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status).toBe('FROZEN');
  expect((db.prepare('SELECT commit_sha FROM gym_holdout WHERE epoch = 1 ORDER BY commit_sha').all() as Array<{ commit_sha: string }>).map((x) => x.commit_sha)).toEqual(CLEAN);
  expect(count('gym_write_test_holdout')).toBe(6);
  const rec = db.prepare('SELECT * FROM gym_holdout_freezes WHERE epoch = 1').get() as Record<string, unknown>;
  expect(rec).toMatchObject({ manifest_sha256: m.manifest_sha256, frozen_at: '2026-10-14T10:00:00Z', origin_sha: 'abc1234', version: '0.5.8', holdout_size: 20 });
  // write_test rows carry the whole task from the pool (a deploy changes the checkout)
  expect(JSON.parse((db.prepare("SELECT task_json FROM gym_write_test_holdout WHERE key = 'fail:run-0'").get() as { task_json: string }).task_json)).toEqual(WT(0));
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  expect(frozenHoldoutCommits(db)).toEqual(CLEAN);
});

it('atomic: a failure inside the transaction leaves nothing behind', () => {
  const m = manifest();
  expect(() => freezeHoldoutFromManifest(db, m, opts(m, { onFrozen: () => { throw new Error('audit down'); } }))).toThrow('audit down');
  expect(count('gym_holdout')).toBe(2); expect(count('gym_holdout_freezes')).toBe(0);
});

it('a dry run validates and writes nothing', () => {
  const m = manifest();
  expect(freezeHoldoutFromManifest(db, m, opts(m, { dryRun: true })).status).toBe('VALID_DRY_RUN');
  expect(count('gym_holdout')).toBe(2); expect(count('gym_holdout_freezes')).toBe(0);
});

it('a tampered manifest (hash mismatch) is refused; so is a sha the operator did not expect', () => {
  const m = manifest();
  const tampered = JSON.parse(JSON.stringify(m)); tampered.tasks.mined[0].key = 'c32';
  const r = freezeHoldoutFromManifest(db, tampered, opts(m));
  expect(r.status).toBe('REFUSED');
  expect(r.status === 'REFUSED' && r.violations.join(' ')).toMatch(/sha256 mismatch/);
  const r2 = freezeHoldoutFromManifest(db, m, opts(m, { expectedSha256: 'f'.repeat(64) }));
  expect(r2.status === 'REFUSED' && r2.violations.join(' ')).toMatch(/expected sha256/);
  expect(count('gym_holdout')).toBe(2);
});

it('the schema is validated', () => {
  for (const bad of [null, {}, { manifest_version: 2 }, { ...manifest(), tasks: { mined: [{ key: 7 }] } }]) {
    const r = freezeHoldoutFromManifest(db, bad, opts({ manifest_sha256: 'x' }));
    expect(r.status).toBe('REFUSED');
  }
  const m = manifest({ epoch: 2 });
  const r = freezeHoldoutFromManifest(db, m, opts(m)); // manifest epoch 2, operator asked for 1
  expect(r.status === 'REFUSED' && r.violations.join(' ')).toMatch(/epoch/);
});

it('a dream-exposed task is refused, with the list of violations', () => {
  const m = manifest({ mined: [...CLEAN.slice(0, 19), 'c05'] });
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status).toBe('REFUSED');
  expect(r.status === 'REFUSED' && r.violations).toEqual([expect.stringMatching(/c05.*dream-exposed commit/)]);
  expect(count('gym_holdout')).toBe(2);
});

it('a task whose source file was exposed to a dream is refused', () => {
  const m = manifest({ mined: [...CLEAN.slice(0, 19), 'c07'] });
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status === 'REFUSED' && r.violations).toEqual([expect.stringMatching(/c07.*dream-exposed source/)]);
});

it('frozen-in-any-epoch, TG-001, trial-attempted and not-in-pool tasks are all refused and all listed', () => {
  const m = manifest({ mined: [...CLEAN.slice(0, 16), 'c00', 'c09', 'c11', 'nope'] });
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status).toBe('REFUSED');
  const v = r.status === 'REFUSED' ? r.violations.join('\n') : '';
  expect(v).toMatch(/c00.*frozen/); expect(v).toMatch(/c09.*trial/); expect(v).toMatch(/c11.*TG-001/); expect(v).toMatch(/nope.*not in the eligible pool/);
});

it('derived-task contamination is refused: a write_test task on an exposed source file or from an exposed run', () => {
  const onExposedTarget = WT(10, SRC(7)); const fromExposedRun = { ...WT(11), run_id: 'run-exposed', commit: 'fail:run-exposed' };
  const pool = { mined: MINED, writeTest: [...WT_POOL, onExposedTarget, fromExposedRun] };
  const m = manifest({ write_test: [...WT_POOL.slice(0, 5), onExposedTarget, fromExposedRun] });
  const r = freezeHoldoutFromManifest(db, m, opts(m, { pool }));
  expect(r.status).toBe('REFUSED');
  const v = r.status === 'REFUSED' ? r.violations.join('\n') : '';
  expect(v).toMatch(/fail:run-10.*dream-exposed source/); expect(v).toMatch(/fail:run-exposed.*dream-exposed run/);
});

it('mutants generated at freeze never use an exposed source file (derived contamination), and fill the full size', () => {
  let n = 0;
  const makeMutant = (tier: number): MutantTask => { const i = n++; return { commit: `mut:base:${i % 3 === 0 ? SRC(7) : SRC(20 + (i % 10))}:${tier}:${i}`, base: 'base', source: i % 3 === 0 ? SRC(7) : SRC(20 + (i % 10)), tests: ['t.test.ts'], sourceLines: 9, mutant: 'x', tier }; };
  const m = manifest({ mutant: { generated_at_freeze: true, proposed_tiers: [3, 4] } });
  const r = freezeHoldoutFromManifest(db, m, opts(m, { makeMutant }));
  expect(r.status).toBe('FROZEN');
  const rows = (db.prepare('SELECT task_json FROM gym_mutant_holdout WHERE epoch = 1').all() as Array<{ task_json: string }>).map((x) => JSON.parse(x.task_json) as MutantTask);
  expect(rows).toHaveLength(20);
  expect(rows.some((t) => t.source === SRC(7))).toBe(false);
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1'); vi.stubEnv('DREAM_TRIAL_MUTANT_TIERS', '3,4');
  expect(mutantHoldoutKeys(db)).toHaveLength(20);
  // a manifest that wants mutants but no generator is refused
  const r2 = freezeHoldoutFromManifest(db, manifest({ epoch: 2, mutant: { generated_at_freeze: true, proposed_tiers: [3] } }), { ...opts(m), epoch: 2, expectedSha256: manifestSha256(manifest({ epoch: 2, mutant: { generated_at_freeze: true, proposed_tiers: [3] } })) });
  expect(r2.status).toBe('REFUSED');
});

it('an epoch that already has rows is refused and left untouched (existing frozen holdouts never change)', () => {
  db.prepare("INSERT INTO gym_mutant_holdout (key, task_json, created_at, epoch) VALUES ('mut:old', '{}', '2026-10-02', 1)").run();
  const before = db.prepare('SELECT * FROM gym_mutant_holdout ORDER BY key').all();
  const m = manifest();
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status === 'REFUSED' && r.violations.join(' ')).toMatch(/epoch 1 already has frozen rows/);
  expect(db.prepare('SELECT * FROM gym_mutant_holdout ORDER BY key').all()).toEqual(before);
  expect(count('gym_holdout')).toBe(2);
  // and a second freeze of the same epoch after a successful one
  const m2 = manifest({ epoch: 3 });
  expect(freezeHoldoutFromManifest(db, m2, { ...opts(m2), epoch: 3 }).status).toBe('FROZEN');
  expect(freezeHoldoutFromManifest(db, m2, { ...opts(m2), epoch: 3 }).status).toBe('REFUSED');
});

it('holdout size is explicit and validated: bounds, env vs manifest conflict, and an insufficient set is HOLD (never a smaller freeze)', () => {
  const m = manifest();
  for (const bad of ['5', '1000', 'abc', '20.5']) {
    const r = freezeHoldoutFromManifest(db, m, opts(m, { env: { HOLDOUT_SIZE: bad } }));
    expect(r.status).toBe('REFUSED');
  }
  // env 30 vs manifest 20: refused, not silently picked
  expect(freezeHoldoutFromManifest(db, m, opts(m, { env: { HOLDOUT_SIZE: '30' } })).status).toBe('REFUSED');
  // manifest asks 30 but lists 20 deciding tasks: HOLD
  const m30 = manifest({ holdout_size: 30 });
  const r = freezeHoldoutFromManifest(db, m30, opts(m30));
  expect(r.status).toBe('HOLD');
  expect(r.status === 'HOLD' && r.reasons.join(' ')).toMatch(/20 of 30/);
  // too few write_test tasks (below the minimum): HOLD
  const mw = manifest({ write_test: WT_POOL.slice(0, 2) });
  expect(freezeHoldoutFromManifest(db, mw, opts(mw)).status).toBe('HOLD');
  // a generator that runs dry: HOLD, no partial mutant holdout
  let k = 0;
  const m4 = manifest({ mutant: { generated_at_freeze: true, proposed_tiers: [3] } });
  const dry = freezeHoldoutFromManifest(db, m4, opts(m4, { makeMutant: (tier) => (k < 5 ? { commit: `mut:b:${SRC(20)}:${tier}:${k++}`, base: 'b', source: SRC(20), tests: [], sourceLines: 1, mutant: 'x', tier } : null) }));
  expect(dry.status).toBe('HOLD');
  expect(count('gym_holdout')).toBe(2); expect(count('gym_mutant_holdout')).toBe(0); expect(count('gym_holdout_freezes')).toBe(0);
});

it('freeze never enables dreaming, never seeds genomes and starts no scheduler', () => {
  const env = { ...process.env };
  const timers = [vi.spyOn(globalThis, 'setInterval'), vi.spyOn(globalThis, 'setTimeout')];
  const genomes = count('maker_genomes');
  const m = manifest();
  expect(freezeHoldoutFromManifest(db, m, opts(m)).status).toBe('FROZEN');
  expect(process.env).toEqual(env);
  expect(process.env.DREAM_EVOLUTION_ENABLED).toBe(env.DREAM_EVOLUTION_ENABLED);
  for (const t of timers) expect(t).not.toHaveBeenCalled();
  expect(count('maker_genomes')).toBe(genomes);
});

it('calibration tasks are frozen apart and never count as deciding evidence', () => {
  const extra = MINED.slice(32, 34).map((t) => t.commit);
  const m = manifest({ mined: [...CLEAN, ...extra], calibration: { mined: extra, write_test: ['fail:run-0'] }, write_test: WT_POOL.slice(0, 6) });
  const r = freezeHoldoutFromManifest(db, m, opts(m));
  expect(r.status).toBe('FROZEN');
  expect((db.prepare("SELECT commit_sha FROM gym_holdout WHERE epoch = 1 AND role = 'calibration' ORDER BY commit_sha").all() as Array<{ commit_sha: string }>).map((x) => x.commit_sha)).toEqual(extra);
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  expect(frozenHoldoutCommits(db)).toEqual(CLEAN); // deciding set only
  expect(writeTestHoldoutKeys(db)).not.toContain('fail:run-0');
  expect(writeTestHoldoutKeys(db)).toHaveLength(5);
  // calibration keys must be manifest tasks
  const bad = manifest({ epoch: 4, calibration: { mined: ['c39'] } });
  const rb = freezeHoldoutFromManifest(db, bad, { ...opts(bad), epoch: 4 });
  expect(rb.status === 'REFUSED' && rb.violations.join(' ')).toMatch(/calibration/);
});
