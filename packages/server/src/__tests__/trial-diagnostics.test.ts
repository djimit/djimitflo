import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME } from '../services/genome-registry';
import { evaluateTrials, minDiscordantForSignificance, trialPower } from '../services/dream-evolution';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const NOW = Date.parse('2026-10-05T12:00:00Z');
const gymRun = (id: string, commit: string, genomeId: string, ok: boolean) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome: genomeId },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red' } }), '2026-10-05T11:00:00Z', '2026-10-05T11:00:00Z');
const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
/** 20 deciding tasks; the parent fails the first `f`, the mutant fails the listed ones. */
const seed = (id: string, f: number, mutantFails: number[]) => {
  db.prepare("INSERT OR IGNORE INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)").run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  trial(id);
  const holdout = Array.from({ length: 20 }, (_, i) => `h${i}`);
  holdout.forEach((c, i) => { gymRun(`p-${id}-${i}`, c, BASELINE_GENOME, i >= f); gymRun(`m-${id}-${i}`, c, id, !mutantFails.includes(i)); });
  return holdout;
};

it('RX-4: minimum discordant wins (all wins, zero losses) for significance at alpha 0.05', () => {
  expect([5, 6, 7, 8, 9, 10, 12, 20].map((n) => minDiscordantForSignificance(n, 0.05))).toEqual([5, 6, 7, 7, 8, 9, 10, 15]);
  expect(minDiscordantForSignificance(4, 0.05)).toBeNull();
});

it('RX-4: power is exactly 0 when the parent fails ≤ 4 deciding tasks, and ≥ 0.81 at f = 9 (q .8, l .05)', () => {
  expect(trialPower(4, 16, 1, 0, 0.05)).toBe(0);
  expect(trialPower(9, 11, 0.8, 0.05, 0.05)).toBeGreaterThanOrEqual(0.81);
  expect(trialPower(9, 11, 0.8, 0.05, 0.05)).toBeLessThanOrEqual(1);
});

it('RX-4: diagnostics never change the promotion decision', () => {
  const holdout = seed('g-a', 3, [1]);
  const off = evaluateTrials(db, 'atomic@llama-router', holdout, NOW);
  db.prepare("UPDATE maker_genomes SET status = 'trial' WHERE id = 'g-a'").run();
  vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
  expect(evaluateTrials(db, 'atomic@llama-router', holdout, NOW)).toEqual(off);
});

it('RX-4: with the flag on a settled trial records its blindness (f ≤ 4 → blind) and Gate A reads it', () => {
  vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
  const holdout = seed('g-b', 3, [1]);
  evaluateTrials(db, 'atomic@llama-router', holdout, NOW);
  const row = db.prepare('SELECT * FROM genome_trial_results WHERE trial_id = ?').get('g-b') as Record<string, unknown>;
  expect(row).toMatchObject({ parent_id: BASELINE_GENOME, deciding_n: 20, f_parent_failures: 3, b: 2, c: 0, state: 'blind', power_q8_l05: 0 });
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.trials.by_state).toEqual([{ state: 'blind', n: 1 }]);
  expect(e.gates.A).toMatchObject({ state: 'red' }); // parent passed 17/20 = 0.85, outside [0.30, 0.55]
});

it('RX-4: without the flag no diagnostics are written (only the SI-C graded shadow row); Gate A stays unknown', () => {
  evaluateTrials(db, 'atomic@llama-router', seed('g-c', 3, [1]), NOW);
  expect(db.prepare('SELECT state, deciding_n, power_q8_l05 FROM genome_trial_results').all()).toEqual([{ state: 'graded_only', deciding_n: null, power_q8_l05: null }]);
  expect(buildEvolutionEvidence(db, {}, NOW).gates.A.state).toBe('unknown');
});

it('RX-4: a hard deciding set (parent passes 9/20) is powered enough and turns Gate A green', () => {
  vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
  evaluateTrials(db, 'atomic@llama-router', seed('g-d', 11, []), NOW);
  expect(db.prepare("SELECT state FROM genome_trial_results WHERE trial_id = 'g-d'").get()).toEqual({ state: 'powered' });
  expect(buildEvolutionEvidence(db, {}, NOW).gates.A.state).toBe('green');
});
