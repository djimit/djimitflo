import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, ensureBaseline, holdout, writeTestHoldoutKeys } from '../services/genome-registry';
import type { FailureTask } from '../services/gym-failure-tasks';
import type { GymTask } from '../services/gym-task-miner';
import { RemoteGymService } from '../services/remote-gym-service';
import { detectStalls } from '../services/stall-watch';

/**
 * Prod 25-10: the epoch-1 trial of g-a187f81f starved after 4 mined attempts. Its next pending item, frozen mined commit
 * 1a2431ef (26-06), had aged out of the miner's 120-day window, so claim() found no task for it, served ordinary work, and
 * hit the same item on every later claim — silently, for good.
 */
const TASK = (commit: string): GymTask => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const TASKS = Array.from({ length: 40 }, (_, i) => TASK(`c${String(i).padStart(2, '0')}`));
const WT = (i: number): FailureTask => ({ commit: `fail:r${String(i).padStart(2, '0')}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`,
  tests: [`packages/server/src/__tests__/w${i}.test.ts`], target: 'packages/server/src/services/widget.ts', sourceLines: 3, run_id: `r${i}`, lane: 'test-gap',
  mutants: [1, 2, 3].map((k) => ({ key: `mut:aaaaaaaaaaaa:packages/server/src/services/widget.ts:1:${k}`, content: `export const widget = () => ${k};\n` })), oracle: 'o' });
type Claim = { runId: string; task: { commit: string; kind?: string }; genome?: { id: string } };

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const trial = (id: string, createdAt: string) => db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at)
  VALUES (?, 'baseline', 'strategy_lines', '["Read the failing test first."]', 'dream', 'trial', ?, ?)`).run(id, createdAt, createdAt);
const attempt = (genome: string, commit: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`)
  .run(`${genome}-${commit}`, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome }, gym_result: { status: 'success', reason: 'tests green, source only' } }));
const claim = (svc: RemoteGymService, caps: string[] = []) => svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: caps }) as Claim;
const blocked = () => db.prepare('SELECT genome_id, task_key FROM gym_trial_blocked ORDER BY genome_id, task_key').all();

it('a frozen mined commit that aged out of the miner list is rebuilt from its own commit and served to the trial', () => {
  const frozen = holdout(db, TASKS); // epoch frozen while every task was still mined
  ensureBaseline(db); trial('g1', '2026-10-16T00:00:00Z');
  for (const c of frozen) attempt(BASELINE_GENOME, c);
  const lookups: string[] = [];
  const svc = new RemoteGymService(db, () => TASKS.filter((t) => t.commit !== frozen[0]), (_repo, commit) => { lookups.push(commit); return commit === frozen[0] ? TASK(commit) : null; });
  expect(claim(svc)).toMatchObject({ task: { commit: frozen[0] }, genome: { id: 'g1' } });
  expect(lookups).toEqual([frozen[0]]); // only the commit missing from the miner list is looked up
  expect(blocked()).toEqual([]);
});

it('an unmaterialisable item does not block the trial: the next pending item is served (parent first) and the block is reported', () => {
  const frozen = holdout(db, TASKS);
  ensureBaseline(db); trial('g1', '2026-10-16T00:00:00Z');
  for (const c of frozen.slice(2)) attempt(BASELINE_GENOME, c);
  let rebuildable = false;
  const svc = new RemoteGymService(db, () => TASKS.filter((t) => t.commit !== frozen[0]), (_repo, commit) => (rebuildable && commit === frozen[0] ? TASK(commit) : null));
  // the parent's own next item comes before any trial-genome attempt on the blocked one
  const first = claim(svc);
  expect(first).toMatchObject({ task: { commit: frozen[1] }, genome: { id: BASELINE_GENOME } });
  expect(blocked()).toEqual([{ genome_id: BASELINE_GENOME, task_key: frozen[0] }, { genome_id: 'g1', task_key: frozen[0] }]);
  svc.record(first.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  expect(claim(svc)).toMatchObject({ task: { commit: frozen[1] }, genome: { id: 'g1' } }); // paired: then the trial genome
  // a permanently unservable item is a stall, never silent starvation
  const stall = detectStalls(db, Date.now(), { DREAM_EVOLUTION_ENABLED: 'true', DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename })
    .find((s) => s.subsystem === 'gym:trial_blocked');
  expect(stall?.detail).toContain(frozen[0]);
  expect(stall?.detail).toContain('g1');
  // once the item can be served again, it is served (parent first) and the block is cleared
  db.prepare("DELETE FROM loop_runs WHERE json_extract(metadata, '$.gym_result') IS NULL").run();
  rebuildable = true;
  expect(claim(svc)).toMatchObject({ task: { commit: frozen[0] }, genome: { id: BASELINE_GENOME } });
  expect(blocked()).toEqual([]);
});

it('a write_test holdout item is skipped for a worker without the capability (next trial item served, nothing reported) and served to one with it', () => {
  vi.stubEnv('DREAM_TRIAL_WRITE_TEST_HOLDOUT', 'true');
  const frozen = holdout(db, TASKS);
  ensureBaseline(db); trial('g1', '2026-10-16T00:00:00Z'); trial('g2', '2026-10-17T00:00:00Z');
  for (const c of frozen) { attempt(BASELINE_GENOME, c); attempt('g1', c); } // g1 has only the write_test holdout left, g2 everything
  const svc = new RemoteGymService(db, () => TASKS, () => null);
  svc.failureTasks = () => Array.from({ length: 8 }, (_, i) => WT(i));
  const plain = claim(svc);
  expect(plain).toMatchObject({ task: { commit: frozen[0] }, genome: { id: 'g2' } });
  expect(writeTestHoldoutKeys(db)).toHaveLength(8);
  db.prepare('DELETE FROM loop_runs WHERE id = ?').run(plain.runId);
  const capable = claim(svc, ['write_test']);
  expect(capable).toMatchObject({ task: { commit: writeTestHoldoutKeys(db)[0], kind: 'write_test' }, genome: { id: BASELINE_GENOME } });
  expect(blocked()).toEqual([]); // servable by a write_test worker: not a block
});
