import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { holdout, mutantHoldout, writeTestHoldout } from '../services/genome-registry';
import type { GymTask } from '../services/gym-task-miner';
import type { FailureTask } from '../services/gym-failure-tasks';
import type { MutantTask } from '../services/gym-mutants';

// The claim-time freeze (remote gym, DREAM_EVOLUTION_ENABLED) excluded only tasks of another epoch: it froze dream-exposed
// mined tasks and mutants on exposed source files. Now it uses the same exclusions as the manifest freeze.
const SRC = (i: number) => `packages/server/src/services/s${String(i).padStart(2, '0')}.ts`;
const MINED: GymTask[] = Array.from({ length: 40 }, (_, i) => ({ commit: `c${String(i).padStart(2, '0')}`, source: SRC(i), tests: [], sourceLines: 9 }));
let db: Database.Database;
let seq = 0;
const run = (metadata: unknown, at: string, id = `r${seq++}`) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify(metadata), at, at);

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-d1', 'baseline', 'strategy_lines', '[\"x\"]', 'dream', 'retired', ?, ?)")
    .run('2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z');
  // exposed: commits c00, c02 (both on the every-other spread) and the source files of c04, s07
  for (const [c, s] of [['c00', 'x.ts'], ['c02', 'y.ts'], ['mut:a', SRC(4)], ['mut:b', SRC(7)]]) {
    run({ gym: { commit: c, source: s, species: 'atomic@llama-router' }, gym_result: { status: 'failure', reason: 'tests still red' } }, '2026-10-10T06:00:00Z');
  }
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('the mined claim-time freeze excludes dream-exposed tasks and tasks on exposed source files', () => {
  const frozen = holdout(db, MINED);
  expect(frozen).toHaveLength(20);
  for (const c of ['c00', 'c02', 'c04', 'c07']) expect(frozen).not.toContain(c);
});

it('the mutant claim-time freeze never uses an exposed source file, and freezes nothing when it cannot fill the size', () => {
  let n = 0;
  const make = (tier: number, tried: Set<string | null>): MutantTask | null => {
    for (;;) {
      const i = n++; const source = SRC(i % 10);
      const t = { commit: `mut:base:${source}:${tier}:${i}`, base: 'base', source, tests: [], sourceLines: 9, mutant: 'x', tier };
      if (!tried.has(t.commit)) return t;
    }
  };
  const frozen = mutantHoldout(db, make);
  expect(frozen).toHaveLength(20);
  expect(frozen.some((t) => t.source === SRC(4) || t.source === SRC(7))).toBe(false);
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  // only exposed sources available: HOLD, never a partial holdout
  expect(mutantHoldout(db, (tier) => ({ commit: `mut:base:${SRC(7)}:${tier}:${n++}`, base: 'base', source: SRC(7), tests: [], sourceLines: 9, mutant: 'x', tier }))).toEqual([]);
  expect((db.prepare('SELECT COUNT(*) AS n FROM gym_mutant_holdout WHERE epoch = 1').get() as { n: number }).n).toBe(0);
});

it('the write_test claim-time freeze excludes tasks whose target file was exposed', () => {
  const wt = (i: number, target: string): FailureTask => ({ commit: `fail:r${i}`, kind: 'write_test', base: 'b'.repeat(40), source: `w${i}.test.ts`, tests: [`w${i}.test.ts`], target, sourceLines: 9,
    run_id: `r-${i}`, lane: 'exports', mutants: [], oracle: 'mutant_kill' });
  const pool = [wt(0, SRC(7)), ...Array.from({ length: 6 }, (_, i) => wt(i + 1, SRC(20 + i)))];
  const frozen = writeTestHoldout(db, () => pool);
  expect(frozen.map((t) => t.commit)).not.toContain('fail:r0');
  expect(frozen).toHaveLength(6);
});

it('HOLDOUT_SIZE configures the claim-time size; out of bounds or an insufficient pool freezes nothing (HOLD)', () => {
  vi.stubEnv('HOLDOUT_SIZE', '5'); // below the minimum
  expect(holdout(db, MINED)).toEqual([]);
  vi.stubEnv('HOLDOUT_SIZE', '40'); // 36 eligible after the exclusions
  expect(holdout(db, MINED)).toEqual([]);
  expect((db.prepare('SELECT COUNT(*) AS n FROM gym_holdout').get() as { n: number }).n).toBe(0);
  vi.stubEnv('HOLDOUT_SIZE', '30');
  expect(holdout(db, MINED)).toHaveLength(30);
});
