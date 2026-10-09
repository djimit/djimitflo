import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildEvolutionEvidence, fisherExact } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const NOW = Date.parse('2026-10-04T20:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let db: Database.Database;
afterEach(() => db?.close());

it('RX-1: an empty or partial schema returns every section and never throws', () => {
  db = new Database(':memory:');
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(Object.keys(e)).toEqual(['at', 'window_days', 'flags', 'outcomes', 'outcomes_tagged', 'merge', 'drafts', 'genomes', 'gym', 'gym_prod_gates', 'gym_diffs', 'trials', 'models', 'oracle', 'commons', 'forecasts_v2', 'hacks', 'hack_rate', 'estimates', 'ope', 'egress', 'failure_tasks', 'embedding_dim_mismatch', 'freshness', 'auto_merge', 'memory_holdout', 'effort_x1', 'graded', 'knowledge_links', 'gates']);
  expect(e.knowledge_links).toEqual({ genomes_with_refs: null, genomes_total: null, proposals_with_refs: null });
  expect(e.outcomes).toEqual([]); expect(e.genomes.holdout).toEqual({ mined: null, mutant: null, write_test: null });
  expect(e.gates.B.state).toBe('red'); expect(e.gates.A.state).toBe('unknown');
  expect(e.flags.every((f) => f.value === null)).toBe(true);
  expect(e.gym_diffs).toEqual({ enabled: false, stored: 0, distinct_tasks: 0, successes: 0, failures: 0, redacted_attempts: 0 }); // no table yet
});

it('RX-1: counts outcomes per source, loop PRs, genomes and gym tiers like hand SQL (foreign keys on)', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db);
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, created_at) VALUES (?, ?, ?, ?, ?)");
  out.run('a', 'loop-maker:test-gap:opencode', 1, 'loop', ago(1)); out.run('b', 'loop-maker:test-gap:opencode', 0, 'loop', ago(2));
  out.run('c', 'loop-maker:gym:atomic', 1, 'gym', ago(1)); out.run('old', 'loop-maker:gym:atomic', 1, 'gym', ago(40));
  out.run('m', 'loop-maker:merge:opencode', 1, 'merge', ago(1));
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('p1', 'test-gap', JSON.stringify({ pr_url: 'u1', pr_outcome: { state: 'merged', survived: true, settled_at: ago(1) } }), ago(20), ago(1));
  run.run('p2', 'test-gap', JSON.stringify({ pr_url: 'u2' }), ago(3), ago(3));
  run.run('p3', 'test-gap', JSON.stringify({ pr_url: 'u3' }), ago(1), ago(1));
  run.run('g1', 'evolution-gym', JSON.stringify({ gym: { commit: 'mut:abc:x:4:1', tier: 4 }, gym_result: { status: 'failure' } }), ago(1), ago(1));
  run.run('g2', 'evolution-gym', JSON.stringify({ gym: { commit: 'abc' }, gym_result: { status: 'success' } }), ago(1), ago(1));
  db.prepare("INSERT INTO maker_genomes (id, origin, status, created_at, updated_at) VALUES ('g-1', 'dream', 'retired', ?, ?)").run(ago(1), ago(1));
  db.prepare("INSERT INTO gym_holdout (commit_sha, created_at) VALUES ('c1', ?)").run(ago(5));

  const e = buildEvolutionEvidence(db, { LOOP_BANDIT_ENABLED: 'true' }, NOW, 30);
  expect(e.outcomes).toEqual(expect.arrayContaining([
    { domain: 'loop', skill: 'loop-maker:test-gap', n: 2, ok: 1 }, { domain: 'gym', skill: 'loop-maker:gym', n: 1, ok: 1 }, { domain: 'merge', skill: 'loop-maker:merge', n: 1, ok: 1 }]));
  expect(e.merge).toMatchObject({ merge_outcomes: 1, settled: [{ state: 'merged', survived: 1, n: 1 }] });
  expect(e.drafts).toMatchObject({ unsettled: 2, unsettled_open_or_recent: 2, age_days_max: 3 });
  expect(e.gates.C.reason).toContain('open or merged < 14 d ago');
  expect(e.genomes.by_status).toEqual([{ status: 'retired', origin: 'dream', n: 1 }]);
  expect(e.genomes.holdout).toEqual({ mined: 1, mutant: 0, write_test: 0 });
  expect(e.gym).toEqual(expect.arrayContaining([{ kind: 'mutant', tier: 4, status: 'failure', n: 1 }, { kind: 'mined', tier: null, status: 'success', n: 1 }]));
  expect(e.flags.find((f) => f.name === 'LOOP_BANDIT_ENABLED')).toMatchObject({ value: 'true', acting: true });
  expect(e.gates.B.reason).toContain('1 settled');
});

it('RX-1: the window is clamped to 1–90 days', () => {
  db = new Database(':memory:');
  expect(buildEvolutionEvidence(db, {}, NOW, 999).window_days).toBe(90);
  expect(buildEvolutionEvidence(db, {}, NOW, -5).window_days).toBe(1);
});

it('RX-3: the share of production maker zeros that are infra / no change / eligible evolve losses, per skill', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const skill = 'loop-maker:test-gap:opencode';
  out.run('a', skill, 0, 'test-gap', '["outcome_class:infra_failed"]', ago(1)); out.run('b', skill, 0, 'test-gap', '["evolve:lost_eligible"]', ago(1));
  out.run('c', skill, 0, 'test-gap', '["outcome_class:regressed"]', ago(1)); out.run('d', skill, 1, 'test-gap', '[]', ago(1));
  out.run('g', 'loop-maker:gym:atomic', 0, 'gym', '["outcome_class:infra_failed"]', ago(1));
  expect(buildEvolutionEvidence(db, {}, NOW).outcomes_tagged).toEqual([{ skill, total: 4, failures: 3, tagged: 2, share: 0.5 }]);
});

it('GYM_PROD_GATES: evidence reports proxy vs prod-gate success per task kind on gated runs only', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  const ins = (id: string, gym: Record<string, unknown>, result: Record<string, unknown>) => run.run(id, JSON.stringify({ gym, gym_result: result }), ago(1), ago(1));
  const wt = { commit: 'fail:r', kind: 'write_test', prod_gates: 1 };
  ins('w1', wt, { status: 'success', reason: 'ok', prod_gates: { diff_limit: 'pass', lint: 'pass' } });
  ins('w2', wt, { status: 'failure', reason: 'prod_gate_failed:lint', prod_gates: { diff_limit: 'pass', lint: 'fail' } });
  ins('w3', wt, { status: 'failure', reason: 'prod_gate_failed:diff_limit', prod_gates: { diff_limit: 'fail', lint: 'fail' } });
  ins('w4', wt, { status: 'failure', reason: 'tests still red' });
  ins('w5', wt, { status: 'discarded', reason: 'infra: x' });
  ins('m1', { commit: 'mut:abc:x:4:1', prod_gates: 1 }, { status: 'failure', reason: 'prod_gate_failed:type-check', prod_gates: { 'type-check': 'fail' } });
  ins('u1', { commit: 'abc' }, { status: 'success', reason: 'ok' }); // claimed without the gates: not in this section
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.gym_prod_gates.by_kind).toEqual([
    { kind: 'mutant', scored: 1, proxy_success: 1, prod_gate_success: 0, proxy_rate: 1, prod_gate_rate: 0 },
    { kind: 'write_test', scored: 4, proxy_success: 3, prod_gate_success: 1, proxy_rate: 0.75, prod_gate_rate: 0.25 },
  ]);
  expect(e.gym_prod_gates.failed_checks).toEqual([{ check: 'lint', n: 2 }, { check: 'diff_limit', n: 1 }, { check: 'type-check', n: 1 }]);
});

it('fisherExact: two-sided exact p on a 2×2 table', () => {
  expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 4);
  expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.0825e-5, 8);
  expect(fisherExact(121, 0, 1, 0)).toBeCloseTo(1, 10); // prod: rules read in 121/122 runs — no control group
  expect(fisherExact(0, 0, 0, 0)).toBe(1);
});

it('MEMORY_HOLDOUT_RATE: verified/regressed per arm (rules vs holdout) with n and a Fisher p; fire-check VOID attempts are counted', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  const imp = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, 0.5, '[]', ?, ?)`);
  const goal = db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)");
  const run = db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?)");
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)");
  const maker = (id: string, status: string, meta: Record<string, unknown>, at = ago(1)) => {
    imp.run(`s-${id}`, status, at, at); goal.run(`g-${id}`, `s-${id}`, at, at); run.run(id, `g-${id}`, at, at); ev.run(`e-${id}`, id, JSON.stringify(meta), at);
  };
  for (let i = 0; i < 10; i++) maker(`r${i}`, 'verified', { examples: [], rule_ids: ['rule-1'] });
  maker('h0', 'regressed', { examples: [], rule_ids: [], memory_holdout: true });
  for (let i = 1; i < 10; i++) maker(`h${i}`, 'regressed', { examples: [], rule_ids: [], memory_holdout: true });
  maker('open', 'executing', { examples: [], rule_ids: ['rule-1'] }); // unsettled: in neither arm
  maker('none', 'verified', { examples: ['x'], rule_ids: [] }); // no rules, not held out: in neither arm
  maker('old', 'regressed', { examples: [], rule_ids: [], memory_holdout: true }, ago(60)); // outside the window
  const gym = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?, ?)`);
  gym.run('v1', JSON.stringify({ gym: { genome: 'g-1' }, gym_result: { status: 'success', void: 'fire_check: no evidence', fire_check: null } }), ago(1), ago(1));
  gym.run('v2', JSON.stringify({ gym: { genome: 'g-1' }, gym_result: { status: 'success', fire_check: { goal_sha256: 'a'.repeat(64), genome_lines: 1, genome_lines_found: 1 } } }), ago(1), ago(1));
  const e = buildEvolutionEvidence(db, { MEMORY_HOLDOUT_RATE: '0.5', GENOME_FIRE_CHECK: 'true' }, NOW, 30);
  expect(e.memory_holdout).toMatchObject({ rate: '0.5', rules: { n: 10, verified: 10, regressed: 0, verified_rate: 1 }, holdout: { n: 10, verified: 0, regressed: 10, verified_rate: 0 } });
  expect(e.memory_holdout.fisher_p).toBeCloseTo(1.0825e-5, 8);
  expect(e.trials.void).toEqual({ attempts: 1, by_genome: [{ genome: 'g-1', n: 1 }], fire_checked: 1 });
  expect(e.flags.find((f) => f.name === 'GENOME_FIRE_CHECK')).toMatchObject({ value: 'true', acting: true });
});

it('SI-A/SI-B: graded per pool (gym write_test, gym repair, prod test-gap, prod exports, prod mutation) with n, mean and share at 1.0, plus contest agreement', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  const out = db.prepare('INSERT INTO skill_outcomes (id, skill_id, success, domain, evidence_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const g = (score: string, kind: string, ...extra: string[]) => JSON.stringify([`graded:${score}`, `graded_kind:${kind}`, ...extra]);
  out.run('w1', 'loop-maker:gym:atomic', 1, 'gym', g('1.000', 'mutant_kill', 'gym:fail'), ago(1));
  out.run('w2', 'loop-maker:gym:atomic', 1, 'gym', g('0.500', 'mutant_kill', 'gym:fail'), ago(1));
  out.run('r1', 'loop-maker:gym:atomic', 0, 'gym', g('0.500', 'tests_green'), ago(1));
  out.run('t1', 'loop-maker:test-gap:opencode', 1, 'test-gap', g('0.667', 'mutant_kill', 'graded_lane:test-gap'), ago(1));
  out.run('x1', 'loop-maker:test-gap:codex', 0, 'test-gap', g('1.000', 'mutant_kill', 'graded_lane:exports'), ago(1));
  out.run('m1', 'loop-maker:doc-drift-and-small-fix-loop:opencode', 1, 'doc-drift-and-small-fix-loop', g('0.982', 'mutation_score', 'graded_lane:mutation'), ago(1));
  out.run('old', 'loop-maker:gym:atomic', 1, 'gym', g('1.000', 'binary'), ago(40));
  out.run('plain', 'loop-maker:gym:atomic', 1, 'gym', '[]', ago(1));
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('c', 'test-gap', 'closed', 'completed', '[]', ?, ?)").run(ago(1), ago(1));
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, 'c', 'contest_graded', 'info', 'm', ?, ?)");
  ev.run('e1', JSON.stringify({ agree: true }), ago(1)); ev.run('e2', JSON.stringify({ agree: false }), ago(1)); ev.run('e3', JSON.stringify({ agree: true }), ago(1));
  const e = buildEvolutionEvidence(db, { GRADED_FITNESS_MODE: 'shadow' }, NOW, 30);
  expect(e.graded.pools).toEqual([
    { pool: 'gym_write_test', n: 2, mean: 0.75, share_full: 0.5 },
    { pool: 'gym_repair', n: 1, mean: 0.5, share_full: 0 },
    { pool: 'prod_test_gap', n: 1, mean: 0.667, share_full: 0 },
    { pool: 'prod_exports', n: 1, mean: 1, share_full: 1 },
    { pool: 'prod_mutation', n: 1, mean: 0.982, share_full: 0 },
  ]);
  expect(e.graded.contest).toEqual({ contests: 3, agree: 2, agreement_rate: 0.667 });
  expect(e.graded.mode).toEqual({ fitness: 'shadow', contest: 'off' });
  expect(e.flags.find((f) => f.name === 'GRADED_CONTEST_MODE')).toMatchObject({ acting: true });
  expect(e.flags.find((f) => f.name === 'GRADED_FITNESS_MODE')).toMatchObject({ acting: false, value: 'shadow' });
});

it('S7: hack_rate over 14 days per genome and task kind (checked = hack detector ran), canaries served/passed, Wilson 95 % and insufficient below n = 10', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  let i = 0;
  const ins = (gym: Record<string, unknown>, result: Record<string, unknown> | null, at = ago(1)) => run.run(`h${i++}`, JSON.stringify({ gym, ...(result ? { gym_result: result } : {}) }), at, at);
  // genome g-1, mined: 12 checked, 3 flagged; 1 scored before HACK_DETECTOR_MODE=shadow (no hack_flags key); 1 discarded
  for (let k = 0; k < 12; k++) ins({ commit: 'abc', genome: 'g-1' }, { status: k % 2 ? 'success' : 'failure', hack_flags: k < 3 ? ['tests_touched'] : [] });
  ins({ commit: 'abc', genome: 'g-1' }, { status: 'success' });
  ins({ commit: 'abc', genome: 'g-1' }, { status: 'discarded', reason: 'infra' });
  // no genome: a mutant (flagged), a write_test (clean) and a probe (clean)
  ins({ commit: 'mut:abc:x:4:1' }, { status: 'success', hack_flags: ['skip_or_only_added', 'assertion_removed'] });
  ins({ commit: 'fail:r', kind: 'write_test' }, { status: 'success', hack_flags: [] });
  ins({ commit: 'abc', probe: 1 }, { status: 'failure', hack_flags: [] });
  // canaries: 3 served — one passed (compromised oracle), one failed, one still running
  ins({ commit: 'mut:abc:y:2:1', canary: 1 }, { status: 'success', hack_flags: [] });
  ins({ commit: 'mut:abc:y:2:1', canary: 1 }, { status: 'failure', hack_flags: [] });
  ins({ commit: 'mut:abc:y:2:1', canary: 1 }, null);
  // outside the 14-day window (inside the 30-day evidence window)
  ins({ commit: 'abc', genome: 'g-1' }, { status: 'success', hack_flags: ['readme_only'] }, ago(20));
  ins({ commit: 'mut:abc:y:2:1', canary: 1 }, { status: 'success', hack_flags: [] }, ago(20));

  const h = buildEvolutionEvidence(db, { HACK_DETECTOR_MODE: 'shadow', GYM_CANARY_RATE: '0.05' }, NOW, 30).hack_rate;
  expect(h).toMatchObject({ window_days: 14, mode: 'shadow', canary_rate: '0.05' });
  expect(h.by_genome).toEqual([
    { genome: 'g-1', scored: 13, checked: 12, flagged: 3, rate: 0.25, ci: [0.0889, 0.5323], status: 'ok' },
    { genome: 'none', scored: 3, checked: 3, flagged: 1, rate: null, ci: null, status: 'insufficient' },
  ]);
  expect(h.by_kind).toEqual([
    { kind: 'canary', scored: 2, checked: 2, flagged: 0, rate: null, ci: null, status: 'insufficient' },
    { kind: 'mined', scored: 13, checked: 12, flagged: 3, rate: 0.25, ci: [0.0889, 0.5323], status: 'ok' },
    { kind: 'mutant', scored: 1, checked: 1, flagged: 1, rate: null, ci: null, status: 'insufficient' },
    { kind: 'probe', scored: 1, checked: 1, flagged: 0, rate: null, ci: null, status: 'insufficient' },
    { kind: 'write_test', scored: 1, checked: 1, flagged: 0, rate: null, ci: null, status: 'insufficient' },
  ]);
  expect(h.canary).toEqual({ served: 3, scored: 2, passed: 1, rate: null, ci: null, status: 'insufficient', compromised: true });
});

it('S7: hack_rate is fail-soft on an empty schema', () => {
  db = new Database(':memory:');
  expect(buildEvolutionEvidence(db, {}, NOW).hack_rate).toMatchObject({ mode: null, canary_rate: null, by_genome: [], by_kind: [],
    canary: { served: 0, scored: 0, passed: 0, rate: null, ci: null, status: 'insufficient', compromised: false } });
});

it('KE-3: knowledge_links counts genomes and proposals that cite knowledge units or claims', () => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const g = db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at, knowledge_refs_json) VALUES (?, 'strategy_lines', '[]', 'dream', 'trial', ?, ?, ?)");
  g.run('g1', ago(1), ago(1), '["u1"]'); g.run('g2', ago(1), ago(1), null); g.run('g3', ago(1), ago(1), '[]');
  const p = db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at, evidence_refs_json) VALUES (?, 'feature', ?, 'd', 'r', 's', 'proposed', 0.5, ?, ?, ?)");
  p.run('p1', 't1', ago(1), ago(1), '["expert_unit:u1"]'); p.run('p2', 't2', ago(1), ago(1), '["expert_claim:c1","test-gap:x"]'); p.run('p3', 't3', ago(1), ago(1), '["test-gap:y"]');
  expect(buildEvolutionEvidence(db, {}, NOW).knowledge_links).toEqual({ genomes_with_refs: 1, genomes_total: 3, proposals_with_refs: 2 });
});
