import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, HOLDOUT_SIZE, ensureBaseline, holdout, nextTrialAttempt } from '../services/genome-registry';
import { RemoteGymService } from '../services/remote-gym-service';

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const TASKS = Array.from({ length: 40 }, (_, i) => TASK(`c${String(i).padStart(2, '0')}`));
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const mutant = (id: string, lines: string[]) => db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at)
  VALUES (?, ?, 'strategy_lines', ?, 'dream', 'trial', datetime('now'), datetime('now'))`).run(id, BASELINE_GENOME, JSON.stringify(lines));

it('Y3: the holdout is picked once, spread over the task list, and never changes', () => {
  const first = holdout(db, TASKS);
  expect(first).toHaveLength(HOLDOUT_SIZE);
  expect(first[0]).toBe('c00'); expect(first[1]).toBe('c02');
  expect(holdout(db, [TASK('zz')])).toEqual(first);
});

it('Y3: trial attempts are paired — the parent first on each holdout task, then the mutant', () => {
  ensureBaseline(db);
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toBeNull(); // no trial genome
  mutant('g1', ['Read the failing test first.']);
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toEqual({ genomeId: BASELINE_GENOME, commit: 'c00' });
  const attempt = (genome: string, commit: string, reason = 'tests green, source only') => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`).run(`${genome}-${commit}-${reason.length}`, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome }, gym_result: { status: 'success', reason } }));
  attempt(BASELINE_GENOME, 'c00');
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toEqual({ genomeId: 'g1', commit: 'c00' });
  attempt('g1', 'c00', 'infra: npm ci failed'); // an infra discard does not count as the attempt
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toEqual({ genomeId: 'g1', commit: 'c00' });
  attempt('g1', 'c00');
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toEqual({ genomeId: BASELINE_GENOME, commit: 'c02' });
});

it('Y3: with dream evolution on, the remote gym serves trial work with the genome lines and records genome evidence', () => {
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  const svc = new RemoteGymService(db, () => TASKS);
  ensureBaseline(db); mutant('g1', ['Read the failing test first.']);
  const first = svc.claim('workstation', ['atomic@llama-router']) as { runId: string; task: { commit: string }; genome?: { id: string; lines: string[] } };
  expect(first).toMatchObject({ task: { commit: 'c00' }, genome: { id: BASELINE_GENOME, lines: [] } });
  svc.record(first.runId, 'workstation', { status: 'success', reason: 'tests green, source only' });
  const second = svc.claim('workstation', ['atomic@llama-router']) as { runId: string; genome?: { id: string; lines: string[] } };
  expect(second.genome).toEqual({ id: 'g1', lines: ['Read the failing test first.'] });
  svc.record(second.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE evidence_refs_json LIKE '%genome:g1%'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM skill_outcomes WHERE evidence_refs_json LIKE '%genome:baseline%'").get()).toEqual({ n: 1 });
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'false'); // off: normal replays, no genome
  const normal = svc.claim('workstation', ['atomic@llama-router']) as { genome?: unknown };
  expect(normal.genome).toBeUndefined();
});
