import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  CHECKER_FAMILY_TARGET_DEFAULT, DEFAULT_CHECKER_CROSS_MODEL, assignCheckerFamily, checkerFamilyVersion, checkerCrossModel, checkerFamilyArm, checkerFamilyEnabled, checkerFamilyEvidence, checkerFamilyTarget,
} from '../services/checker-family';
import { EVOLUTION_FLAGS, buildEvolutionEvidence, fisherExact } from '../services/evolution-evidence';

/** F2 (operator-approved 10-10): does a checker of another model family than the maker catch more defects? */
let db: Database.Database;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = '2026-10-10T10:00:00Z';
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

describe('arm assignment', () => {
  it('is deterministic per goal and ~50/50, salted independently of X1', () => {
    expect(checkerFamilyArm('goal-1')).toBe(checkerFamilyArm('goal-1'));
    let cross = 0; const N = 4_000;
    for (let i = 0; i < N; i++) if (checkerFamilyArm(`goal-${i}`) === 'cross') cross++;
    expect(cross / N).toBeGreaterThan(0.47); expect(cross / N).toBeLessThan(0.53);
  });

  it('F2 v2: a version other than v1 enters the salt (fresh arms); v1, the default, keeps the original salt', () => {
    const legacy = (g: string) => (createHash('sha256').update(`checker-family:${g}`).digest()[0] % 2 === 0 ? 'same' : 'cross');
    const salted = (g: string) => (createHash('sha256').update(`checker-family:v2:${g}`).digest()[0] % 2 === 0 ? 'same' : 'cross');
    expect(checkerFamilyVersion({})).toBe('v1');
    expect(checkerFamilyVersion({ CHECKER_FAMILY_VERSION: ' v2 ' })).toBe('v2');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'CHECKER_FAMILY_VERSION', acting: true });
    let changed = 0; let cross = 0; const N = 4_000;
    for (let i = 0; i < N; i++) {
      const g = `goal-${i}`;
      expect(checkerFamilyArm(g)).toBe(legacy(g));
      expect(checkerFamilyArm(g, 'v1')).toBe(legacy(g));
      expect(checkerFamilyArm(g, 'v2')).toBe(salted(g));
      if (checkerFamilyArm(g, 'v2') !== checkerFamilyArm(g)) changed++;
      if (checkerFamilyArm(g, 'v2') === 'cross') cross++;
    }
    expect(changed / N).toBeGreaterThan(0.45); expect(changed / N).toBeLessThan(0.55); // independent of v1
    expect(cross / N).toBeGreaterThan(0.47); expect(cross / N).toBeLessThan(0.53);
  });

  it('F2 v2: the v2 arm and version are stamped on lease, goal and event; the cross checker runs gemma4:31b', () => {
    const goalId = (() => { for (let i = 0; i < 1000; i++) if (checkerFamilyArm(`g-${i}`, 'v2') === 'cross' && checkerFamilyArm(`g-${i}`) === 'same') return `g-${i}`; throw new Error('no goal whose v2 arm differs from v1'); })();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?)").run(goalId, at, at);
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES ('c', 'r', 'checker', 'manual', 'prepared', 'f', '{}', ?)").run(at);
    const env = { DJIMITFLO_OPENCODE_MODEL: 'ollama/glm-5.2:cloud', CHECKER_FAMILY_VERSION: 'v2', CHECKER_CROSS_MODEL: 'ollama/gemma4:31b:cloud' };
    expect(assignCheckerFamily(db, 'r', goalId, 'c', 'opencode', env)).toBe('cross');
    expect(JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get('c') as { metadata: string }).metadata))
      .toMatchObject({ model: 'ollama/gemma4:31b:cloud', checker_family_arm: 'cross', checker_family_version: 'v2', checker_model_family: 'gemma' });
    expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goalId) as { metadata: string }).metadata))
      .toMatchObject({ checker_family_arm: 'cross', checker_family_version: 'v2', checker_model: 'ollama/gemma4:31b:cloud' });
    const ev = db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'checker_family_arm'").all() as Array<{ metadata: string }>;
    expect(JSON.parse(ev[0].metadata)).toMatchObject({ arm: 'cross', version: 'v2', checker_model: 'ollama/gemma4:31b:cloud' });
  });

  it('flag off|on (default off) and a configurable cross model', () => {
    expect(checkerFamilyEnabled({})).toBe(false);
    expect(checkerFamilyEnabled({ CHECKER_FAMILY_RANDOMISE: 'off' })).toBe(false);
    expect(checkerFamilyEnabled({ CHECKER_FAMILY_RANDOMISE: 'on' })).toBe(true);
    expect(checkerCrossModel({})).toBe(DEFAULT_CHECKER_CROSS_MODEL);
    expect(DEFAULT_CHECKER_CROSS_MODEL).toBe('ollama/kimi-k3:cloud');
    expect(checkerCrossModel({ CHECKER_CROSS_MODEL: 'ollama/qwen3.5:cloud' })).toBe('ollama/qwen3.5:cloud');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'CHECKER_FAMILY_RANDOMISE', acting: true });
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'CHECKER_CROSS_MODEL', acting: true });
  });

  it('cross sets the model on the checker lease only and records arm + reviewer model on lease, goal and an event', () => {
    const goalId = (() => { for (let i = 0; ; i++) if (checkerFamilyArm(`g-${i}`) === 'cross') return `g-${i}`; })();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?)").run(goalId, at, at);
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r', ?, 'test-gap', 'closed', 'running', ?, ?)").run(goalId, at, at);
    const ins = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES (?, 'r', ?, ?, ?, 'f', ?, ?)");
    ins.run('m', 'maker', 'opencode', 'completed', JSON.stringify({ model_id: 'ollama/glm-5.2:cloud', model_family: 'glm' }), at);
    ins.run('c', 'checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'm' }), at);
    ins.run('s', 'security_checker', 'manual', 'prepared', JSON.stringify({ maker_lease_id: 'm' }), at);
    const env = { DJIMITFLO_OPENCODE_MODEL: 'ollama/glm-5.2:cloud' };
    expect(assignCheckerFamily(db, 'r', goalId, 'c', 'opencode', env)).toBe('cross');
    const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
    expect(meta('c')).toMatchObject({ model: 'ollama/kimi-k3:cloud', checker_family_arm: 'cross', checker_model_family: 'kimi', maker_model_family: 'glm' });
    expect(meta('s')).toEqual({ maker_lease_id: 'm' });
    expect(JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goalId) as { metadata: string }).metadata))
      .toMatchObject({ checker_family_arm: 'cross', checker_model: 'ollama/kimi-k3:cloud' });
    const ev = db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'checker_family_arm'").all() as Array<{ metadata: string }>;
    expect(ev.map((e) => JSON.parse(e.metadata))).toEqual([{ goal_id: goalId, arm: 'cross', version: 'v1', lease_id: 'c', checker_model: 'ollama/kimi-k3:cloud', checker_model_family: 'kimi', maker_model_family: 'glm' }]);
  });

  it('same leaves the checker lease model untouched (the runtime default) and only records it', () => {
    const goalId = (() => { for (let i = 0; ; i++) if (checkerFamilyArm(`g-${i}`) === 'same') return `g-${i}`; })();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?)").run(goalId, at, at);
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES ('c', 'r', 'checker', 'manual', 'prepared', 'f', '{}', ?)").run(at);
    expect(assignCheckerFamily(db, 'r', goalId, 'c', 'opencode', { DJIMITFLO_OPENCODE_MODEL: 'ollama/glm-5.2:cloud' })).toBe('same');
    const m = JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get('c') as { metadata: string }).metadata);
    expect(m).not.toHaveProperty('model');
    expect(m).toMatchObject({ checker_family_arm: 'same', checker_model_id: 'ollama/glm-5.2:cloud', checker_model_family: 'glm' });
  });
});

describe('evidence section checker_family', () => {
  let n = 0;
  /** one reviewed goal: checker verdict, attributed outcome (+ failed gates) and the maker's assertion-strength shadow result */
  const seed = (arm: 'same' | 'cross', verdict: string, outcome: string, failedGates: string[] = [], strength?: 'pass' | 'fail', version?: string) => {
    const v = version ? { checker_family_version: version } : {};
    const id = `${arm}-${n++}`;
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', ?, ?, ?)")
      .run(`g-${id}`, JSON.stringify({ checker_family_arm: arm, ...v }), at, at);
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?)").run(`r-${id}`, `g-${id}`, at, at);
    const ins = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at) VALUES (?, ?, ?, 'opencode', 'completed', 'f', ?, ?)");
    const checks = strength ? [{ name: 'test:assertion-strength', status: 'skipped', shadow_status: strength }] : [];
    ins.run(`m-${id}`, `r-${id}`, 'maker', JSON.stringify({ model_family: 'glm', deterministic_checks: checks }), at);
    ins.run(`c-${id}`, `r-${id}`, 'checker', JSON.stringify({ maker_lease_id: `m-${id}`, verdict, checker_family_arm: arm, ...v, maker_model_family: 'glm', checker_model_family: arm === 'cross' ? 'kimi' : 'glm' }), at);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'outcome_attribution', 'loop_run', ?, ?, 'annotation', ?, ?, ?, ?)`).run(`j-${id}`, `r-${id}`, outcome, outcome, outcome, JSON.stringify({ computed: true, failed_gates: failedGates }), at);
  };

  it('per arm: verdict counts, agreement with the attributed outcome (reviewer/env excluded), kappa, Fisher, weak-assertion signal', () => {
    seed('same', 'accepted', 'verified', [], 'fail');
    seed('same', 'accepted', 'maker_failure', ['security_checker_verdict'], 'pass');
    seed('same', 'rejected', 'maker_failure', ['checker_verdict']);
    seed('same', 'needs_revision', 'verified');
    seed('same', 'accepted', 'environment_failure', ['worktree_isolation']); // excluded from the outcome label
    seed('cross', 'accepted', 'verified');
    seed('cross', 'accepted', 'verified', [], 'fail');
    seed('cross', 'rejected', 'maker_failure', ['checker_verdict'], 'fail');
    seed('cross', 'needs_revision', 'maker_failure', ['checker_verdict', 'security_checker_verdict']);
    const e = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', { CHECKER_FAMILY_RANDOMISE: 'on' }, fisherExact);
    expect(e).toMatchObject({ enabled: 'on', cross_model: 'ollama/kimi-k3:cloud' });
    expect(e.same).toMatchObject({ goals: 5, reviewed: 5, verdicts: { accepted: 3, needs_revision: 1, rejected: 1 }, realized_cross: 0, outcome: { n: 4, agree: 2, kappa: 0 } });
    expect(e.cross).toMatchObject({ goals: 4, reviewed: 4, verdicts: { accepted: 2, needs_revision: 1, rejected: 1 }, realized_cross: 4, outcome: { n: 4, agree: 4, kappa: 1 } });
    expect(e.same.outcome).toMatchObject({ circular: true });
    // secondary, circular: the attributed outcome contains the checker's own rejection
    expect(e.secondary_circular).toMatchObject({ endpoint: 'outcome', circular: true, delta_kappa: 1, n: { same: 4, cross: 4 } });
    expect(e.secondary_circular.fisher_p).toBeCloseTo(fisherExact(4, 0, 2, 2), 3);
    // primary (EXP-1): the other failed gates only, until merge survival has settled
    expect(e.same.outcome_wo_checker).toMatchObject({ n: 4, agree: 1 });
    expect(e.cross.outcome_wo_checker).toMatchObject({ n: 4, agree: 3 });
    expect(e.primary).toMatchObject({ endpoint: 'outcome_wo_checker', read: 'interim', n: { same: 4, cross: 4 } });
    expect(e.primary.fisher_p).toBeCloseTo(fisherExact(3, 1, 1, 3), 3);
    expect(e.same.outcome_survival).toMatchObject({ n: 0, kappa: null }); // no merge-survival labels yet
    expect(e.same.weak_assertion).toMatchObject({ n: 2, weak: 1, caught: 0, missed: 1, false_alarms: 0, sensitivity: 0 });
    expect(e.cross.weak_assertion).toMatchObject({ n: 2, weak: 2, caught: 1, missed: 1, sensitivity: 0.5 });
    expect(e.weak_fisher_p).toBeCloseTo(fisherExact(1, 1, 0, 1), 3);
    expect(e.stop).toMatchObject({ per_arm: 93, reached: false, verdict: 'collecting' });
  });

  it('F2 v2: evidence per version — the top level counts only the current version, v1 is labelled closed interim, never pooled', () => {
    seed('same', 'accepted', 'verified'); seed('cross', 'rejected', 'maker_failure', ['checker_verdict']); seed('cross', 'accepted', 'verified'); // v1 (unversioned)
    seed('same', 'accepted', 'verified', [], undefined, 'v2'); seed('cross', 'accepted', 'verified', [], undefined, 'v2');
    // default v1: identical to before — the v2 rows are not counted
    const v1 = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', {}, fisherExact);
    expect(v1).toMatchObject({ version: 'v1', cross_model: 'ollama/kimi-k3:cloud', same: { goals: 1, reviewed: 1 }, cross: { goals: 2, reviewed: 2 } });
    expect(v1.versions.v1).toMatchObject({ label: 'current', closed: false });
    expect(v1.versions.v2).toMatchObject({ label: 'not current', closed: false, evidence: { same: { reviewed: 1 }, cross: { reviewed: 1 } } });
    // v2: only its own rows; v1 under its closed label and its own cross model
    const env = { CHECKER_FAMILY_VERSION: 'v2', CHECKER_CROSS_MODEL: 'ollama/gemma4:31b:cloud' };
    const v2 = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', env, fisherExact);
    expect(v2).toMatchObject({ version: 'v2', cross_model: 'ollama/gemma4:31b:cloud', same: { goals: 1, reviewed: 1 }, cross: { goals: 1, reviewed: 1 },
      primary: { n: { same: 1, cross: 1 } } });
    expect(v2.versions.v1).toMatchObject({ label: 'interim (closed 2026-10-17, cross=kimi-k3)', closed: true,
      evidence: { cross_model: 'ollama/kimi-k3:cloud', same: { goals: 1, reviewed: 1 }, cross: { goals: 2, reviewed: 2 } } });
    expect(v2.versions.v2.evidence.same).toEqual(v2.same);
    expect(Object.keys(v2.versions)).toEqual(['v1', 'v2']);
  });

  it('target per arm: default 93 (EXP-1), CHECKER_FAMILY_TARGET_PER_ARM overrides, junk falls back', () => {
    expect(CHECKER_FAMILY_TARGET_DEFAULT).toBe(93);
    expect(checkerFamilyTarget({})).toBe(93);
    expect(checkerFamilyTarget({ CHECKER_FAMILY_TARGET_PER_ARM: '120' })).toBe(120);
    expect(checkerFamilyTarget({ CHECKER_FAMILY_TARGET_PER_ARM: 'x' })).toBe(93);
    expect(checkerFamilyTarget({ CHECKER_FAMILY_TARGET_PER_ARM: '0' })).toBe(93);
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'CHECKER_FAMILY_TARGET_PER_ARM', acting: false });
  });

  /** E1: a valid settlement (merged, settled after the 14-day window) */
  const settledPr = (survived: boolean) => ({ pr_url: 'https://github.com/o/r/pull/1', pr_outcome: { state: 'merged', merged_at: '2026-09-15T00:00:00Z', settled_at: '2026-10-01T00:00:00Z', survived } });

  it('E1: only SETTLED_SURVIVED / SETTLED_REGRESSED label survival; pending and anomalous outcomes are unlabelled', () => {
    seed('cross', 'accepted', 'verified'); seed('cross', 'rejected', 'maker_failure', ['checker_verdict']); seed('cross', 'accepted', 'verified');
    const set = (id: string, meta: object) => db.prepare("UPDATE loop_runs SET metadata = ? WHERE id = 'r-' || ?").run(JSON.stringify(meta), id);
    set(`cross-${n - 3}`, settledPr(true));
    // survived set but no merged_at (pipeline anomaly) — main counted it as a survival label
    set(`cross-${n - 2}`, { pr_url: 'https://github.com/o/r/pull/2', pr_outcome: { state: 'merged', settled_at: '2026-10-01T00:00:00Z', survived: false } });
    // merged 3 d ago, still in the window: pending, no label
    set(`cross-${n - 1}`, { pr_url: 'https://github.com/o/r/pull/3', pr_outcome: { state: 'merged', merged_at: '2026-10-07T12:00:00Z', survived: true } });
    const e = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', {}, fisherExact, NOW);
    expect(e.cross.outcome_survival).toMatchObject({ n: 1, unlabelled: 2 });
  });

  it('merge survival is a checker-independent label and becomes the primary once settled for the target in both arms', () => {
    seed('cross', 'accepted', 'verified'); seed('cross', 'rejected', 'maker_failure', ['checker_verdict']);
    db.prepare("UPDATE loop_runs SET metadata = ? WHERE id = 'r-' || ?").run(JSON.stringify(settledPr(false)), `cross-${n - 2}`);
    db.prepare("UPDATE loop_runs SET metadata = ? WHERE id = 'r-' || ?").run(JSON.stringify(settledPr(true)), `cross-${n - 1}`);
    const e = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', { CHECKER_FAMILY_TARGET_PER_ARM: '2' }, fisherExact, NOW);
    expect(e.cross.outcome_survival).toMatchObject({ n: 2, agree: 0, kappa: -1 });
    expect(e.primary.endpoint).toBe('outcome_wo_checker'); // the same arm has no survival labels yet
    seed('same', 'accepted', 'verified'); seed('same', 'rejected', 'maker_failure', ['checker_verdict']);
    db.prepare("UPDATE loop_runs SET metadata = ? WHERE id = 'r-' || ?").run(JSON.stringify(settledPr(true)), `same-${n - 2}`);
    db.prepare("UPDATE loop_runs SET metadata = ? WHERE id = 'r-' || ?").run(JSON.stringify(settledPr(false)), `same-${n - 1}`);
    const settled = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', { CHECKER_FAMILY_TARGET_PER_ARM: '2' }, fisherExact, NOW);
    expect(settled.primary).toMatchObject({ endpoint: 'outcome_survival', delta_kappa: -2, n: { same: 2, cross: 2 } });
  });

  // perfect agreement on the primary label: a rejection also fails the security checker (another gate), an accept verifies
  const perfect = (arm: 'same' | 'cross', i: number) => (i % 2 ? seed(arm, 'accepted', 'verified') : seed(arm, 'rejected', 'maker_failure', ['checker_verdict', 'security_checker_verdict']));
  // chance agreement: verdict and label independent
  const chance = (arm: 'same' | 'cross', i: number) => {
    const acc = i % 2 === 1; const ok = i % 4 < 2;
    seed(arm, acc ? 'accepted' : 'rejected', ok ? 'verified' : 'maker_failure', ok ? (acc ? [] : ['checker_verdict']) : (acc ? ['security_checker_verdict'] : ['checker_verdict', 'security_checker_verdict']));
  };

  it('no verdict before the target: an interim read stays collecting even when the CI excludes 0', () => {
    for (let i = 0; i < 92; i++) { chance('same', i); perfect('cross', i); }
    const e = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', {}, fisherExact);
    expect(e.primary.delta_kappa_ci![0]).toBeGreaterThan(0);
    expect(e.primary.read).toBe('interim');
    expect(e.stop).toMatchObject({ per_arm: 93, reached: false, verdict: 'collecting' });
  });

  it('pre-registered stop at 93 per arm on the primary label: falsified when the Δkappa CI includes 0, supported when it excludes 0 upward', () => {
    for (let i = 0; i < 93; i++) { perfect('same', i); perfect('cross', i); }
    const equal = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', {}, fisherExact);
    expect(equal.primary).toMatchObject({ endpoint: 'outcome_wo_checker', read: 'final', delta_kappa: 0 });
    expect(equal.stop).toMatchObject({ reached: true, verdict: 'falsified' });

    db.exec("DELETE FROM goals; DELETE FROM loop_runs; DELETE FROM worker_leases; DELETE FROM judgments");
    for (let i = 0; i < 93; i++) { chance('same', i); perfect('cross', i); }
    const better = checkerFamilyEvidence(db, '2026-09-10T00:00:00Z', {}, fisherExact);
    expect(better.primary.delta_kappa_ci![0]).toBeGreaterThan(0);
    expect(better.stop).toMatchObject({ reached: true, verdict: 'supported' });
  });

  it('is part of evolution-evidence and fail-soft on an empty database', () => {
    const e = buildEvolutionEvidence(db, {}, NOW, 30);
    expect(e.checker_family).toMatchObject({ enabled: null, target_per_arm: 93, same: { goals: 0, reviewed: 0 }, cross: { goals: 0, reviewed: 0 },
      primary: { endpoint: 'outcome_wo_checker', read: 'interim', delta_kappa: null }, secondary_circular: { circular: true }, stop: { reached: false, verdict: 'collecting' } });
  });
});
