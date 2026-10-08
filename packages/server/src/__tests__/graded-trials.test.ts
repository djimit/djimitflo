import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME } from '../services/genome-registry';
import { evaluateTrials, gradedDecision, pairedPermutationTest, promotionRule, settleNoHeadroom } from '../services/dream-evolution';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const SPECIES = 'atomic@llama-router';
const NOW = Date.parse('2026-10-08T12:00:00Z');
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  new SkillEvolutionEngine(db); // skill_outcomes is created lazily
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

let seq = 0;
/** one scored gym attempt; `graded` (when given) lands as a `graded:<x>` evidence ref on its skill outcome, as the gym writes it */
const gymRun = (commit: string, genomeId: string, ok: boolean, graded?: number) => {
  const id = `r${seq++}`;
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, species: SPECIES, genome: genomeId },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red' } }), '2026-10-08T11:00:00Z', '2026-10-08T11:00:00Z');
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, model, evidence_refs_json, created_at) VALUES (?, 'loop-maker:gym:atomic', ?, 'gym', 'llama-router', ?, ?)")
    .run(`o-${id}`, ok ? 1 : 0, JSON.stringify([`gym:${commit}`, `loop_run:${id}`, ...(graded === undefined ? [] : [`graded:${graded}`, 'graded_kind:mutants_killed'])]), '2026-10-08T11:00:00Z');
};
const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, '2026-10-08T10:00:00Z', '2026-10-08T10:00:00Z');
const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
const status = (id: string) => (db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(id) as { status: string }).status;
const row = (id: string) => db.prepare('SELECT state, graded_mean_parent, graded_mean_mutant, graded_p, graded_decision, graded_refs FROM genome_trial_results WHERE trial_id = ?').get(id) as Record<string, number | string | null>;
/** parent and mutant both binary-fail every task (McNemar blind); graded scores per task from the two functions */
const seedGraded = (id: string, parent: (i: number) => number, mutant: (i: number) => number) => {
  trial(id);
  commits.forEach((c, i) => { gymRun(c, BASELINE_GENOME, false, parent(i)); gymRun(c, id, false, mutant(i)); });
};

it('SI-C: the exact paired sign-flip test on small cases', () => {
  expect(pairedPermutationTest([1, 1, 1, 1, 1])).toMatchObject({ pUp: 1 / 32, pDown: 1, exact: true, n: 5 });
  expect(pairedPermutationTest([1, 1, 1, 1, -1])).toMatchObject({ pUp: 6 / 32, pDown: 31 / 32 });
  const t = pairedPermutationTest([0.5, 0.2, -0.1]); // flips of .5/.2/.1: sums ≥ .6 are +++ (.8) and ++- (.6)
  expect(t.pUp).toBe(2 / 8); expect(t.pDown).toBe(7 / 8); expect(t.mean).toBeCloseTo(0.2, 12);
  expect(pairedPermutationTest([0, 0, 1]).pUp).toBe(0.5); // a zero difference carries no sign
  expect(pairedPermutationTest([])).toMatchObject({ pUp: 1, pDown: 1, mean: 0, n: 0 });
  // n = 20, all +1: the one assignment out of 2^20
  expect(pairedPermutationTest(Array(20).fill(0.3)).pUp).toBe(2 ** -20);
});

it('SI-C: above 20 pairs a seeded Monte-Carlo estimate — deterministic and close to the exact value', () => {
  const diffs = [...Array(13).fill(1), ...Array(11).fill(-1)]; // exact: P(Bin(24, ½) ≥ 13)
  let exact = 0; let coef = 1;
  for (let k = 0; k <= 24; k++) { if (k >= 13) exact += coef; coef = coef * (24 - k) / (k + 1); }
  exact /= 2 ** 24;
  const a = pairedPermutationTest(diffs); const b = pairedPermutationTest(diffs);
  expect(a.exact).toBe(false); expect(a).toEqual(b);
  expect(Math.abs(a.pUp - exact)).toBeLessThan(0.01);
});

it('SI-C: decision rule — promote needs p < α AND mean diff ≥ 0.05; worse when the parent side is significant', () => {
  expect(gradedDecision(Array(20).fill(0.2), 0.05)).toBe('promote');
  expect(gradedDecision(Array(20).fill(0.02), 0.05)).toBe('inconclusive'); // significant but too small
  expect(gradedDecision(Array(20).fill(-0.2), 0.05)).toBe('worse');
  expect(gradedDecision([...Array(10).fill(0.1), ...Array(10).fill(-0.1)], 0.05)).toBe('inconclusive');
  expect(promotionRule({ DREAM_PROMOTION_RULE: 'graded' })).toBe('graded');
  expect(promotionRule({})).toBe('mcnemar');
});

it('SI-C: rule graded — a mutant that kills more seeded mutants is promoted although McNemar is blind', () => {
  vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  seedGraded('g-up', () => 0.6, (i) => (i % 2 ? 0.8 : 0.7));
  expect(evaluateTrials(db, SPECIES, commits, NOW)).toEqual([{ id: 'g-up', status: 'active', wins: 0, parentWins: 0 }]);
  expect(row('g-up')).toMatchObject({ graded_decision: 'promote', graded_refs: 40 });
  expect(row('g-up').graded_mean_parent).toBeCloseTo(0.6, 9); expect(row('g-up').graded_mean_mutant).toBeCloseTo(0.75, 9);
  expect(row('g-up').graded_p).toBe(2 ** -20);
  expect((db.prepare('SELECT note FROM maker_genomes WHERE id = ?').get('g-up') as { note: string }).note).toContain('graded 0.750 vs 0.600');
});

it('SI-C: rule graded — retires a worse mutant and an inconclusive one', () => {
  vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  seedGraded('g-down', () => 0.6, () => 0.4);
  evaluateTrials(db, SPECIES, commits, NOW);
  expect(status('g-down')).toBe('retired'); expect(row('g-down').graded_decision).toBe('worse');
  seedGraded('g-flat', () => 0.6, (i) => (i % 2 ? 0.7 : 0.5));
  evaluateTrials(db, SPECIES, commits, NOW);
  expect(status('g-flat')).toBe('retired'); expect(row('g-flat').graded_decision).toBe('inconclusive');
});

it('SI-C: rule graded — the binary mined no-regression check still blocks a promotion', () => {
  vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  const mined = Array.from({ length: 4 }, (_, i) => `m${i}`);
  trial('g-mined');
  commits.forEach((c) => { gymRun(c, BASELINE_GENOME, false, 0.5); gymRun(c, 'g-mined', false, 0.8); });
  mined.forEach((c, i) => { gymRun(c, BASELINE_GENOME, true); gymRun(c, 'g-mined', i >= 2); }); // mutant loses 2 mined tasks net
  evaluateTrials(db, SPECIES, mined, NOW, commits);
  expect(status('g-mined')).toBe('retired');
  expect(row('g-mined').graded_decision).toBe('promote'); // the graded test alone would have promoted
});

it('SI-C: without graded refs the scores fall back to success 1/0', () => {
  vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  trial('g-bin');
  commits.forEach((c, i) => { gymRun(c, BASELINE_GENOME, i >= 10); gymRun(c, 'g-bin', true); }); // 10 wins vs 0, no graded refs
  evaluateTrials(db, SPECIES, commits, NOW);
  expect(status('g-bin')).toBe('active');
  expect(row('g-bin')).toMatchObject({ graded_mean_parent: 0.5, graded_mean_mutant: 1, graded_p: 2 ** -10, graded_decision: 'promote', graded_refs: 0 });
});

it('SI-C: shadow — under the default rule the graded columns are stored but the decision is McNemar\'s', () => {
  seedGraded('g-shadow', () => 0.6, () => 0.8);
  expect(evaluateTrials(db, SPECIES, commits, NOW)).toEqual([{ id: 'g-shadow', status: 'retired', wins: 0, parentWins: 0 }]);
  expect(row('g-shadow')).toMatchObject({ state: 'graded_only', graded_decision: 'promote', graded_p: 2 ** -20 });
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.trials.recent[0]).toMatchObject({ trial_id: 'g-shadow', graded_decision: 'promote', graded_p: 2 ** -20 });
  expect(e.trials.by_epoch[0]).toMatchObject({ graded_promote: 1 });
  expect(e.gates.A.state).toBe('unknown'); // a shadow-only row carries no deciding-set diagnostics
});

it('SI-C: shadow next to diagnostics — the RX-4 row keeps its state and gains the graded columns', () => {
  vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
  seedGraded('g-diag', () => 0.6, () => 0.8);
  evaluateTrials(db, SPECIES, commits, NOW);
  expect(row('g-diag')).toMatchObject({ state: 'powered', graded_decision: 'promote' });
});

it('SI-C: graded headroom — no no_headroom under graded while the parent\'s mean graded < 0.95, even with < 5 binary failures', () => {
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  trial('g-head');
  commits.forEach((c, i) => gymRun(c, BASELINE_GENOME, i >= 3, i >= 3 ? 0.75 : 0.5)); // fails 3 binary, mean graded 0.71
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
  expect(status('g-head')).toBe('trial');
  vi.stubEnv('DREAM_PROMOTION_RULE', 'mcnemar'); // the binary rule still sees no headroom
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-head', f: 3, n: 20, needed: 5 }]);
});

it('SI-C: graded headroom — a parent at mean graded ≥ 0.95 with < 5 failures is still no_headroom; its mean is recorded', () => {
  vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', 'graded');
  trial('g-sat');
  commits.forEach((c, i) => gymRun(c, BASELINE_GENOME, i >= 3, i >= 3 ? 1 : 0.8)); // (17 + 2.4) / 20 = 0.97
  expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-sat', f: 3, n: 20, needed: 5 }]);
  expect(row('g-sat').state).toBe('no_headroom');
  expect(row('g-sat').graded_mean_parent).toBeCloseTo(0.97, 9);
});
