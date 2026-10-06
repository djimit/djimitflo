import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, holdout, nextTrialAttempt } from '../services/genome-registry';
import { evaluateTrials, minWinsNeeded, settleNoHeadroom } from '../services/dream-evolution';
import { RemoteGymService } from '../services/remote-gym-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const SPECIES = 'atomic@llama-router';
const NOW = Date.parse('2026-10-06T12:00:00Z');
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

let seq = 0;
const gymRun = (commit: string, genomeId: string, ok: boolean) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(`r${seq++}`, JSON.stringify({ gym: { commit, species: SPECIES, genome: genomeId },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red' } }), '2026-10-06T11:00:00Z', '2026-10-06T11:00:00Z');
const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, '2026-10-06T10:00:00Z', '2026-10-06T10:00:00Z');
const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
/** the parent's results on all 20 deciding tasks: it fails the first f */
const parentScored = (f: number) => commits.forEach((c, i) => gymRun(c, BASELINE_GENOME, i >= f));
const status = (id: string) => (db.prepare('SELECT status, note FROM maker_genomes WHERE id = ?').get(id) as { status: string; note: string });

it('B8-HEAD: flag off — behaviour unchanged: no precheck, the mutant gets its deciding-set attempts', () => {
  trial('g-off'); parentScored(3);
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
  expect(status('g-off').status).toBe('trial');
  expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: 'g-off', commit: 'h0' });
});

it('B8-HEAD: flag on, parent fails 3 of 20 — no mutant attempt, trial inconclusive with the reason, row written, Gate A says so', () => {
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
  trial('g-low'); parentScored(3);
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-low', f: 3, n: 20, needed: 5 }]);
  expect(status('g-low')).toEqual({ status: 'inconclusive', note: 'no_headroom: parent fails 3 of 20; ≥ 5 needed for any significant win' });
  expect(nextTrialAttempt(db, SPECIES, commits)).toBeNull(); // nothing left to claim for that trial
  expect(db.prepare('SELECT state, deciding_n, f_parent_failures FROM genome_trial_results WHERE trial_id = ?').get('g-low'))
    .toEqual({ state: 'no_headroom', deciding_n: 20, f_parent_failures: 3 });
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.trials.by_state).toEqual([{ state: 'no_headroom', n: 1 }]);
  expect(e.gates.A.reason).toContain('no headroom');
});

it('B8-HEAD: the threshold is the fewest all-win discordant pairs (best case = win exactly the f parent failures)', () => {
  expect(minWinsNeeded(0.05, 'mcnemar')).toBe(5); // 0.5^5 = 0.031 < 0.05; 0.5^4 = 0.0625 is not
  expect(minWinsNeeded(0.05, 'both')).toBe(5); // e-process needs 7 (E(7,7) ≈ 31.9 ≥ 20); the smaller rule counts
  expect(minWinsNeeded(0.01, 'mcnemar')).toBe(7); // 0.5^7 = 0.0078 < 0.01
});

it('B8-HEAD: flag on — parent fails 4 of 20 → no headroom; 5 of 20 and 10 of 20 → the trial proceeds', () => {
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true');
  trial('g-mid'); parentScored(4);
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-mid', f: 4, n: 20, needed: 5 }]);
  for (const f of [5, 10]) {
    db.prepare("UPDATE maker_genomes SET status = 'trial', note = NULL WHERE id = 'g-mid'").run();
    db.prepare("DELETE FROM genome_trial_results").run(); db.prepare("DELETE FROM loop_runs").run();
    parentScored(f);
    expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
    expect(status('g-mid').status).toBe('trial');
    expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: 'g-mid', commit: 'h0' });
  }
});

it('B8-HEAD: under DREAM_PROMOTION_RULE=both the smaller rule decides; the parent is scored before any mutant attempt', () => {
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', 'both');
  trial('g-e');
  expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: BASELINE_GENOME, commit: 'h0' }); // parent first
  parentScored(4);
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-e', f: 4, n: 20, needed: 5 }]);
  db.prepare("UPDATE maker_genomes SET status = 'trial', note = NULL WHERE id = 'g-e'").run();
  db.prepare("DELETE FROM genome_trial_results").run(); db.prepare("DELETE FROM loop_runs").run();
  parentScored(6);
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
});

it('B8-HEAD: a proceeding trial is decided exactly as without the precheck', () => {
  trial('g-p'); parentScored(18);
  commits.forEach((c, i) => gymRun(c, 'g-p', i >= 1)); // mutant fails only h0: 17 wins vs 0
  const off = evaluateTrials(db, SPECIES, commits, NOW);
  db.prepare("UPDATE maker_genomes SET status = 'trial' WHERE id = 'g-p'").run();
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true');
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
  expect(evaluateTrials(db, SPECIES, commits, NOW)).toEqual(off);
});

it('B8-HEAD: the remote gym claim runs the precheck before serving a trial attempt', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo'); vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true');
  const tasks = Array.from({ length: 40 }, (_, i) => ({ commit: `c${i}`, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }));
  const frozen = holdout(db, tasks, new Date(NOW).toISOString());
  trial('g-claim');
  frozen.forEach((c, i) => gymRun(c, BASELINE_GENOME, i >= 2)); // parent fails 2 of 20
  const claim = new RemoteGymService(db, () => tasks).claim('workstation', [SPECIES], new Date(NOW)) as { genome?: unknown; task: { commit: string } };
  expect(claim.genome).toBeUndefined(); // no trial attempt served
  expect(status('g-claim').status).toBe('inconclusive');
});
