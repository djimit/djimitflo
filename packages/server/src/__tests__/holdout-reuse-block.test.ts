import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME } from '../services/genome-registry';
import { evaluateTrials } from '../services/dream-evolution';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// Cockpit 3.0 adversarial scenario 10: a genome that wins on a reused holdout must not be promoted; the same win on a fresh epoch is.
const SPECIES = 'atomic@llama-router';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
let db: Database.Database;
let seq = 0;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  new SkillEvolutionEngine(db);
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  for (const c of commits) db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)').run(c, '2026-10-02T00:00:00Z');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const gymRun = (commit: string, genomeId: string, ok: boolean) => {
  const id = `r${seq++}`; const at = '2026-10-10T11:00:00Z';
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, species: SPECIES, genome: genomeId },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red' } }), at, at);
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, model, evidence_refs_json, created_at) VALUES (?, 'loop-maker:gym:atomic', ?, 'gym', 'llama-router', ?, ?)")
    .run(`o-${id}`, ok ? 1 : 0, JSON.stringify([`gym:${commit}`, `loop_run:${id}`]), at);
};
/** parent fails the first 10 tasks, the trial solves all 20: b = 10, c = 0 — a significant win under McNemar */
const seedWinner = (id: string) => {
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
    .run(id, BASELINE_GENOME, '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z');
  commits.forEach((c, i) => { gymRun(c, BASELINE_GENOME, i >= 10); gymRun(c, id, true); });
};
/** earlier candidates that ran on the same epoch (retired long ago), each one completed attempt */
const exposeTo = (n: number) => { for (let k = 0; k < n; k++) gymRun(commits[k % 20], `g-old-${k}`, false); };
const genomeRow = (id: string) => db.prepare('SELECT status, note FROM maker_genomes WHERE id = ?').get(id) as { status: string; note: string };

it('scenario 10: a win on a holdout epoch already used by more candidates than the limit is inconclusive, not promoted', () => {
  exposeTo(10); // + the trial itself = 11 candidates > 10
  seedWinner('g-win');
  expect(evaluateTrials(db, SPECIES, commits, NOW)).toEqual([{ id: 'g-win', status: 'inconclusive', wins: 20, parentWins: 10 }]);
  expect(genomeRow('g-win')).toMatchObject({ status: 'inconclusive' });
  expect(genomeRow('g-win').note).toBe('holdout_exhausted: mined epoch 0 used by 11 candidates (limit 10)');
});

it('scenario 10: the same win on a fresh epoch is promoted', () => {
  seedWinner('g-win');
  expect(evaluateTrials(db, SPECIES, commits, NOW)).toEqual([{ id: 'g-win', status: 'active', wins: 20, parentWins: 10 }]);
});

it('DREAM_HOLDOUT_REUSE_LIMIT overrides the contract limit', () => {
  vi.stubEnv('DREAM_HOLDOUT_REUSE_LIMIT', '20');
  exposeTo(10);
  seedWinner('g-win');
  expect(evaluateTrials(db, SPECIES, commits, NOW)[0].status).toBe('active');
});
