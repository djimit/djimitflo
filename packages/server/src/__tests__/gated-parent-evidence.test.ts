import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, nextTrialAttempt } from '../services/genome-registry';
import { evaluateTrials, settleNoHeadroom } from '../services/dream-evolution';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

/**
 * EVOLUTION ENGINE 4.0 P0 (13-10): parent fitness / headroom / promotion may only rest on ELIGIBLE observations — claimed with
 * the production gates, verdict recorded on that attempt, same holdout epoch, same evaluation contract. Ungated history stays
 * readable (counts) but never authorizes headroom or promotion; missing eligible evidence holds the trial, never promotes.
 */
const SPECIES = 'atomic@llama-router';
const NOW = Date.parse('2026-10-13T12:00:00Z');
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  new SkillEvolutionEngine(db);
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

let seq = 0;
const PASS = { lint: 'pass', 'type-check': 'pass' };
/** one scored attempt; gated = claimed with GYM_PROD_GATES (a gated success carries the per-check map, as the gym writes it) */
const run = (commit: string, genomeId: string, ok: boolean, o: { gated?: boolean; gates?: Record<string, string>; at?: string } = {}) => {
  const at = o.at ?? '2026-10-13T11:00:00Z'; const gated = o.gated ?? true;
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(`r${seq++}`, JSON.stringify({
    gym: { commit, species: SPECIES, genome: genomeId, ...(gated ? { prod_gates: 1 } : {}) },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red', ...(gated && ok ? { prod_gates: o.gates ?? PASS } : {}) } }), at, at);
};
const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, '2026-10-13T09:00:00Z', '2026-10-13T09:00:00Z');
const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
const genomeRow = (id: string) => db.prepare('SELECT status, note FROM maker_genomes WHERE id = ?').get(id) as { status: string; note: string | null };
const trialRow = (id: string) => db.prepare('SELECT state, deciding_n, f_parent_failures, gate_policy, evidence_json FROM genome_trial_results WHERE trial_id = ?').get(id) as
  { state: string; deciding_n: number | null; f_parent_failures: number | null; gate_policy: string | null; evidence_json: string | null } | undefined;

describe('headroom (settleNoHeadroom) uses only eligible gated parent evidence', () => {
  it.each(['mcnemar', 'both', 'graded'])('rule %s: ungated parent results (17/20) cannot settle a trial as no_headroom', (rule) => {
    vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', rule);
    trial('g-u'); commits.forEach((c, i) => run(c, BASELINE_GENOME, i >= 3, { gated: false }));
    expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
    expect(genomeRow('g-u').status).toBe('trial');
  });

  it('rule both: a NEWER ungated 17/20 never overrides the older gated 10/20 — the trial has headroom and proceeds', () => {
    vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', 'both');
    trial('g-h');
    commits.forEach((c, i) => run(c, BASELINE_GENOME, i >= 10, { at: '2026-10-13T10:00:00Z' }));
    commits.forEach((c, i) => run(c, BASELINE_GENOME, i >= 3, { gated: false, at: '2026-10-13T11:30:00Z' }));
    expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([]);
    expect(genomeRow('g-h').status).toBe('trial');
  });

  it('valid gated evidence still settles no_headroom, with gate policy, epoch, task family and difficulty on the record', () => {
    vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('DREAM_PROMOTION_RULE', 'both');
    trial('g-n'); commits.forEach((c, i) => run(c, BASELINE_GENOME, i >= 3));
    commits.forEach((c) => run(c, BASELINE_GENOME, true, { gated: false, at: '2026-10-13T08:00:00Z' })); // older ungated history: readable only
    expect(settleNoHeadroom(db, SPECIES, commits, [], NOW)).toEqual([{ id: 'g-n', f: 3, n: 20, needed: 5 }]);
    const r = trialRow('g-n')!;
    expect(r).toMatchObject({ state: 'no_headroom', deciding_n: 20, f_parent_failures: 3 });
    expect(r.gate_policy).toMatch(/^prod_gates\/v1:[0-9a-f]{12}$/);
    const ev = JSON.parse(r.evidence_json!);
    expect(ev).toMatchObject({ gate_policy: r.gate_policy, holdout: 'gym_holdout', epoch: 0, parent: { eligible: 20, ungated: 20 }, families: { repair: 20 } });
  });
});

describe('promotion (evaluateTrials) uses only eligible gated evidence, for every rule', () => {
  it.each(['mcnemar', 'both', 'graded'])('rule %s: ungated parent evidence cannot authorize promotion — HOLD (inconclusive), never active', (rule) => {
    vi.stubEnv('DREAM_PROMOTION_RULE', rule);
    trial('g-x');
    commits.forEach((c) => { run(c, BASELINE_GENOME, false, { gated: false }); run(c, 'g-x', true); });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s.status).toBe('inconclusive');
    expect(genomeRow('g-x').status).toBe('inconclusive');
    expect(genomeRow('g-x').note).toMatch(/^inconclusive: no eligible gated parent evidence/);
    const r = trialRow('g-x')!;
    expect(r.state).toBe('hold_ineligible');
    expect(r.deciding_n).toBeNull(); // a hold never feeds Gate A
    expect(JSON.parse(r.evidence_json!)).toMatchObject({ parent: { eligible: 0, ungated: 20 } });
  });

  it.each(['mcnemar', 'both', 'graded'])('rule %s: a trial with enough gated parent results still proceeds and promotes', (rule) => {
    vi.stubEnv('DREAM_PROMOTION_RULE', rule);
    trial('g-ok');
    commits.forEach((c, i) => { run(c, BASELINE_GENOME, i >= 10); run(c, 'g-ok', true); });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s).toEqual({ id: 'g-ok', status: 'active', wins: 20, parentWins: 10 });
    expect(genomeRow('g-ok').note).toMatch(/gates prod_gates\/v1:[0-9a-f]{12}/);
    expect(trialRow('g-ok')!.gate_policy).toMatch(/^prod_gates\/v1:/);
  });

  it('no production gate bypass: a mutant "success" with a failing prod gate is never a win', () => {
    trial('g-byp');
    commits.forEach((c, i) => { run(c, BASELINE_GENOME, i >= 10); run(c, 'g-byp', true, i < 10 ? { gates: { lint: 'fail', 'type-check': 'pass' } } : {}); });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s.status).not.toBe('active');
    expect(s.wins).toBe(10);
  });

  it('a gated "success" without a recorded gate verdict is not eligible: the mutant cannot win on it', () => {
    trial('g-nov');
    commits.forEach((c, i) => {
      run(c, BASELINE_GENOME, i >= 10);
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
        VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-13T11:00:00Z', '2026-10-13T11:00:00Z')`)
        .run(`nov${i}`, JSON.stringify({ gym: { commit: c, species: SPECIES, genome: 'g-nov', prod_gates: 1 }, gym_result: { status: 'success', reason: 'tests green, source only' } }));
    });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s.status).toBe('inconclusive');
    expect(genomeRow('g-nov').note).toMatch(/^inconclusive: no eligible gated mutant evidence/);
  });

  it('stale evidence: an older attempt never overrides a newer eligible one (and a newer ungated one never counts)', () => {
    trial('g-st');
    commits.forEach((c, i) => {
      if (i < 10) {
        run(c, BASELINE_GENOME, false, { at: '2026-10-13T11:00:00Z' }); // newest eligible: failure
        run(c, BASELINE_GENOME, true, { at: '2026-10-13T09:30:00Z' }); // older eligible success, inserted later
        run(c, BASELINE_GENOME, true, { gated: false, at: '2026-10-13T11:30:00Z' }); // newer but ungated
      } else run(c, BASELINE_GENOME, true);
      run(c, 'g-st', true);
    });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s).toEqual({ id: 'g-st', status: 'active', wins: 20, parentWins: 10 });
  });

  it('mixed epochs: parent results from before the current epoch froze the task are rejected, not combined', () => {
    const ins = db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)');
    commits.forEach((c) => ins.run(c, '2026-10-13T10:00:00Z'));
    trial('g-ep');
    commits.forEach((c, i) => { run(c, BASELINE_GENOME, i >= 10, { at: '2026-10-12T11:00:00Z' }); run(c, 'g-ep', true); });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s.status).toBe('inconclusive');
    expect(genomeRow('g-ep').note).toMatch(/^inconclusive: no eligible gated parent evidence/);
  });

  it('mixed epochs: a deciding task frozen under another epoch is never silently combined with the current one', () => {
    vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
    const ins = db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, ?)');
    commits.forEach((c, i) => ins.run(c, '2026-10-13T08:00:00Z', i === 19 ? 0 : 1));
    trial('g-ep2');
    commits.forEach((c, i) => { run(c, BASELINE_GENOME, i >= 10); run(c, 'g-ep2', true); });
    const [s] = evaluateTrials(db, SPECIES, commits, NOW);
    expect(s.status).toBe('inconclusive');
    expect(genomeRow('g-ep2').note).toMatch(/no eligible gated parent evidence \(19 of 20/);
  });
});

describe('Gate A and the trial scheduler', () => {
  it('Gate A reads only decisions made on eligible gated evidence; legacy ungated rows stay readable but never colour it', () => {
    db.prepare(`INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, mined_b, mined_c, power_q8_l05, state, recorded_at, epoch)
      VALUES ('g-legacy', 'baseline', 'mined', 20, 3, 0, 0, 1, 0, 0, 0, 'no_headroom', '2026-10-13T11:59:00Z', 0)`).run();
    let e = buildEvolutionEvidence(db, {}, NOW);
    expect(e.gates.A.state).toBe('unknown');
    expect(e.gates.A.reason).toContain('eligible production-gated');
    expect(e.trials.recent.map((t) => t.trial_id)).toContain('g-legacy'); // diagnostics still show it
    vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true'); vi.stubEnv('TRIAL_DIAGNOSTICS_ENABLED', 'true');
    trial('g-a'); commits.forEach((c, i) => { run(c, BASELINE_GENOME, i >= 10); run(c, 'g-a', i >= 9); });
    evaluateTrials(db, SPECIES, commits, NOW);
    e = buildEvolutionEvidence(db, {}, NOW);
    expect(e.gates.A.state).toBe('green'); // parent 10/20 = 0.50, inside [0.30, 0.55]
    expect(e.gates.A.reason).toContain('latest trial g-a');
  });

  it('GYM_PROD_GATES on: a parent task with only ungated results is served again (bounded), so gated evidence can exist', () => {
    vi.stubEnv('TRIAL_HEADROOM_PRECHECK', 'true');
    trial('g-s'); commits.forEach((c) => run(c, BASELINE_GENOME, true, { gated: false }));
    expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: 'g-s', commit: 'h0' }); // gates off: unchanged
    vi.stubEnv('GYM_PROD_GATES', 'true');
    expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: BASELINE_GENOME, commit: 'h0' });
    run('h0', BASELINE_GENOME, true, { gated: false }); run('h0', BASELINE_GENOME, true, { gated: false }); // 3 ungated: give up on h0
    expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: BASELINE_GENOME, commit: 'h1' });
    run('h1', BASELINE_GENOME, true);
    expect(nextTrialAttempt(db, SPECIES, commits)).toEqual({ genomeId: BASELINE_GENOME, commit: 'h2' });
  });
});
