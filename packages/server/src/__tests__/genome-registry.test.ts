import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, HOLDOUT_SIZE, ensureBaseline, holdout, mutantHoldout, mutantHoldoutKeys, nextTrialAttempt, strategyGenomeFor } from '../services/genome-registry';
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

it('a holdout task that keeps timing out for a genome becomes unscorable: skipped, and the trial can still settle (prod 02-10)', async () => {
  const { evaluateTrials } = await import('../services/dream-evolution');
  ensureBaseline(db); mutant('g1', ['A']);
  const run = (id: string, genome: string, commit: string, status: string, reason: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`).run(id, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome }, gym_result: { status, reason } }));
  run('b0', BASELINE_GENOME, 'c00', 'failure', 'tests still red'); run('b1', BASELINE_GENOME, 'c02', 'success', 'tests green, source only');
  run('g1', 'g1', 'c02', 'success', 'tests green, source only');
  for (let i = 0; i < 3; i++) run(`t${i}`, 'g1', 'c00', 'discarded', `infra: maker crashed or timed out (${i})`);
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00', 'c02'])).toBeNull(); // c00 given up for g1, c02 done for both
  const settled = evaluateTrials(db, 'atomic@llama-router', ['c00', 'c02']);
  expect(settled).toEqual([{ id: 'g1', status: 'retired', wins: 1, parentWins: 1 }]); // compared on c02 only: 0 vs 0 discordant
});

it('Z5: the mutant holdout is frozen once (tier 2 and 3, task stored); trials are judged on it, the mined holdout may cost one task net', async () => {
  const { evaluateTrials } = await import('../services/dream-evolution');
  let n = 0;
  const make = (tier: number) => ({ commit: `mut:b:${n}:${tier}:${n++}`, base: 'b', source: 's.ts', tests: ['s.test.ts'], sourceLines: 9, mutant: 'x', tier });
  const first = mutantHoldout(db, make);
  expect(first).toHaveLength(HOLDOUT_SIZE);
  expect(first.map((t) => t.tier).filter((t) => t === 3)).toHaveLength(HOLDOUT_SIZE / 2);
  expect(mutantHoldout(db, make).map((t) => t.commit)).toEqual(first.map((t) => t.commit)); // never re-picked
  ensureBaseline(db); mutant('g1', ['A']);
  const run = (genome: string, commit: string, ok: boolean) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`).run(`${genome}-${commit}`, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome }, gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red' } }));
  const mined = ['c00', 'c02', 'c04'];
  const mutants = first.slice(0, 6).map((t) => t.commit);
  // mined: g1 loses c00 (net -1, allowed); mutants: g1 wins all 6, baseline none -> McNemar p = 1/64
  for (const c of mined) { run(BASELINE_GENOME, c, true); run('g1', c, c !== 'c00'); }
  for (const c of mutants) { run(BASELINE_GENOME, c, false); run('g1', c, true); }
  expect(evaluateTrials(db, 'atomic@llama-router', mined, Date.now(), mutants)).toEqual([{ id: 'g1', status: 'active', wins: 8, parentWins: 3 }]);
  // same mutant win, but two mined tasks lost -> retired
  db.prepare("UPDATE maker_genomes SET status = 'trial', updated_at = '2000-01-01' WHERE id = 'g1'").run();
  db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.gym_result.status', 'failure') WHERE id = 'g1-c02'").run();
  expect(evaluateTrials(db, 'atomic@llama-router', mined, Date.now(), mutants)[0].status).toBe('retired');
});

it('Z5: a new tier set freezes its own mutant holdout next to the old one (nothing deleted); keys follow the configured tiers', () => {
  let n = 0;
  const make = (tier: number) => ({ commit: `mut:b:${n}:${tier}:${n++}`, base: 'b', source: 's.ts', tests: ['s.test.ts'], sourceLines: 9, mutant: 'x', tier });
  const easy = mutantHoldout(db, make, undefined, [2, 3]);
  const hard = mutantHoldout(db, make, undefined, [4, 5]);
  expect(hard).toHaveLength(HOLDOUT_SIZE);
  expect(new Set(hard.map((t) => t.tier))).toEqual(new Set([4, 5]));
  expect(mutantHoldoutKeys(db, [2, 3])).toEqual(easy.map((t) => t.commit).sort());
  expect(mutantHoldoutKeys(db, [4, 5])).toEqual(hard.map((t) => t.commit).sort());
  expect(mutantHoldout(db, make, undefined, [4, 5]).map((t) => t.commit)).toEqual(hard.map((t) => t.commit)); // frozen
  expect(db.prepare('SELECT COUNT(*) AS n FROM gym_mutant_holdout').get()).toEqual({ n: 2 * HOLDOUT_SIZE });
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

it('D2: a production maker of the evolving species is attributed to the active genome (else baseline); other species have none', () => {
  ensureBaseline(db);
  expect(strategyGenomeFor(db, 'remote', 'workstation/atomic@llama-router')?.id).toBe(BASELINE_GENOME);
  expect(strategyGenomeFor(db, 'atomic', 'llama-router')?.id).toBe(BASELINE_GENOME);
  expect(strategyGenomeFor(db, 'opencode', null)).toBeNull();
  mutant('g1', ['Run the target test first.']);
  db.prepare("UPDATE maker_genomes SET status = 'active', updated_at = datetime('now') WHERE id = 'g1'").run();
  expect(strategyGenomeFor(db, 'remote', 'workstation/atomic@llama-router')).toMatchObject({ id: 'g1', lines: ['Run the target test first.'] });
});

it('GENOME_FIRE_CHECK: a VOID trial attempt is not an attempt; after 3 the pair is unscorable', async () => {
  const { unscorable } = await import('../services/genome-registry');
  ensureBaseline(db); mutant('g1', ['A']);
  const run = (id: string, genome: string, commit: string, extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`).run(id, JSON.stringify({ gym: { commit, species: 'atomic@llama-router', genome }, gym_result: { status: 'success', reason: 'tests green, source only', ...extra } }));
  run('b0', BASELINE_GENOME, 'c00');
  run('v0', 'g1', 'c00', { void: 'fire_check: 0 of 1 genome lines in the maker prompt' });
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00'])).toEqual({ genomeId: 'g1', commit: 'c00' });
  run('v1', 'g1', 'c00', { void: 'fire_check: no evidence that the genome lines reached the maker' }); run('v2', 'g1', 'c00', { void: 'fire_check: x' });
  expect(unscorable(db, 'atomic@llama-router', 'g1', 'c00')).toBe(true);
  expect(nextTrialAttempt(db, 'atomic@llama-router', ['c00'])).toBeNull();
});
