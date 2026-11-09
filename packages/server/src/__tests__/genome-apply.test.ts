import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME } from '../services/genome-registry';
import { evaluateTrials } from '../services/dream-evolution';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { LoopDaemon } from '../services/loop-daemon';
import type { LoopService } from '../services/loop-service';
import { GoalService } from '../services/goal-service';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';
import { unknownEnvFlags } from '../services/env-flags';
import { recordTreatmentEnvBoundaries } from '../services/experiment-registry';
import { detectStallsWithHealth } from '../services/stall-watch';
import {
  GENOME_APPLY_HOLDOUT_RATE, applyGenomeToLease, genomeApplyArm, genomeApplyEvidence, genomeApplyMode, genomeApplyRetireCheck, genomeLinesSha256, planGenomeApply,
} from '../services/genome-apply';

/**
 * GENOME_APPLY_MODE=on (fitness-contract audit, PR #1188): a gym genome promoted by the paired-holdout rule reaches production
 * makers — only an active genome promoted through promoteGenome with gated trial evidence, only oracle-lane makers of the
 * species it was trialled on, a permanent 10 % per-goal holdout, a delivery receipt (genome id + lines sha256) and an
 * auto-retire rule that never promotes. off|shadow stay exactly as before.
 */
const SPECIES = 'atomic@llama-router';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
const LINES = ['Run the narrowest failing test first, then the package suite.', 'Change one function at a time.'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let db: Database.Database; let repo: string; let seq = 0;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  new SkillEvolutionEngine(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'genome-apply-'));
  vi.stubEnv('GENOME_APPLY_MODE', '');
  vi.stubEnv('SKILL_ROUTE_MODE', '');
  vi.stubEnv('DREAM_EVOLUTION_SPECIES', '');
  vi.stubEnv('OUTCOME_ATTRIBUTION_ENABLED', 'true');
  vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)")
    .run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  for (const c of commits) db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)').run(c, '2026-10-02T00:00:00Z');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

const gymRun = (commit: string, genomeId: string, ok: boolean) => {
  const id = `r${seq++}`; const at = '2026-10-11T11:00:00Z';
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ gym: { commit, species: SPECIES, genome: genomeId, prod_gates: 1 },
    gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green, source only' : 'tests still red', ...(ok ? { prod_gates: { lint: 'pass' } } : {}) } }), at, at);
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, model, evidence_refs_json, created_at) VALUES (?, 'loop-maker:gym:atomic', ?, 'gym', 'llama-router', ?, ?)")
    .run(`o-${id}`, ok ? 1 : 0, JSON.stringify([`gym:${commit}`, `loop_run:${id}`]), at);
};
/** a genome promoted by the real rule: a significant paired win on the frozen holdout with gated evidence (evaluateTrials → promoteGenome) */
function promoted(id = 'g-win') {
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', ?, 'dream', 'trial', ?, ?)")
    .run(id, BASELINE_GENOME, JSON.stringify(LINES), '2026-10-11T10:00:00Z', '2026-10-11T10:00:00Z');
  commits.forEach((c, i) => { gymRun(c, BASELINE_GENOME, i >= 10); gymRun(c, id, true); });
  vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
  const settled = evaluateTrials(db, SPECIES, commits, NOW);
  expect(settled.find((s) => s.id === id)?.status).toBe('active');
  return id;
}
function seedGoal(goalId: string, refs: string[]) {
  const pid = `p-${goalId}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'test', 'Strengthen tests', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, datetime('now'), datetime('now'))`).run(pid, JSON.stringify(refs));
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, datetime('now'), datetime('now'))`).run(goalId, pid);
}
const TEST_GAP = ['test-gap:packages/server/src/services/a.ts'];
const goalIn = (arm: 'treatment' | 'holdout', from = 0) => { for (let i = from; ; i++) if (genomeApplyArm(`goal-${i}`) === arm) return `goal-${i}`; };
const ASSIGNMENT = '# test-gap Assignment\n\nLoop run: run-1\n\n## Finding\n\nAdd a test.\n';
function lease(id: string, runtime = 'atomic', model: string | null = 'llama-router') {
  const file = path.join(repo, `${id}.LOOP_WORK.md`); fs.writeFileSync(file, ASSIGNMENT);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', 'maker', ?, 'prepared', ?, ?, ?)`)
    .run(id, runtime, JSON.stringify({ assignment_file: file, ...(model ? { model } : {}) }), now, now);
  return file;
}
const leaseMeta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata) as Record<string, any>;
const occurrences = (text: string, s: string) => text.split(s).length - 1;
const apply = (leaseId: string, goalId: string | null, loopName = 'test-gap-loop') => applyGenomeToLease(db, { runId: 'run-1', goalId, loopName, leaseId });

describe('flag', () => {
  it('off unless shadow or on; an acting evolution flag; known to the env check; an oracle-population treatment variable (ACE-001, STE-001, MAKER-DEPS-001, X1, F2)', () => {
    expect(genomeApplyMode({})).toBe('off');
    expect(genomeApplyMode({ GENOME_APPLY_MODE: 'yes' })).toBe('off');
    expect(genomeApplyMode({ GENOME_APPLY_MODE: 'shadow' })).toBe('shadow');
    expect(genomeApplyMode({ GENOME_APPLY_MODE: 'on' })).toBe('on');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'GENOME_APPLY_MODE', acting: true });
    expect(unknownEnvFlags({ GENOME_APPLY_MODE: 'on' })).toEqual([]);
    recordTreatmentEnvBoundaries(db, { GENOME_APPLY_MODE: 'shadow' }, Date.parse('2026-11-08T00:00:00Z'));
    const rows = recordTreatmentEnvBoundaries(db, { GENOME_APPLY_MODE: 'on' }, Date.parse('2026-11-09T00:00:00Z'));
    expect(rows.map((r) => r.experiment_id)).toEqual(expect.arrayContaining(['ACE-001', 'STE-001', 'MAKER-DEPS-001', 'X1', 'F2']));
  });
});

describe('holdout split', () => {
  it("arm = sha256('genome-apply:' + goal id): deterministic, ~10 % holdout, independent of other salts", () => {
    const x = parseInt(sha('genome-apply:goal-7').slice(0, 8), 16) / 0x1_0000_0000;
    expect(genomeApplyArm('goal-7')).toBe(x < GENOME_APPLY_HOLDOUT_RATE ? 'holdout' : 'treatment');
    expect(genomeApplyArm('goal-7')).toBe(genomeApplyArm('goal-7'));
    const n = 4000; const held = Array.from({ length: n }, (_, i) => genomeApplyArm(`g-${i}`)).filter((a) => a === 'holdout').length;
    expect(held / n).toBeGreaterThan(0.08); expect(held / n).toBeLessThan(0.12);
  });
});

describe('only active genomes promoted by the existing rule qualify', () => {
  beforeEach(() => { vi.stubEnv('GENOME_APPLY_MODE', 'on'); });
  it('promoted through evaluateTrials (gated trial evidence) → planned', () => {
    const id = promoted(); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP);
    const { plan } = planGenomeApply(db, { goalId: goal, loopName: 'test-gap-loop', runtime: 'atomic', model: 'llama-router' });
    expect(plan).toMatchObject({ arm: 'treatment', genome: { id }, lines_sha256: genomeLinesSha256(LINES), lane: 'test-gap', species: SPECIES });
  });
  it("an 'active' row without a gated promotion record is never applied", () => {
    db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-raw', 'baseline', 'x', ?, 'dream', 'active', datetime('now'), datetime('now'))").run(JSON.stringify(LINES));
    for (const c of commits) gymRun(c, 'g-raw', true);
    const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP);
    const r = planGenomeApply(db, { goalId: goal, loopName: 'test-gap-loop', runtime: 'atomic', model: 'llama-router' });
    expect(r.plan).toBeNull(); expect(r.reason).toMatch(/promotion/);
  });
  it('a trial or candidate genome is never applied (nothing active besides the baseline)', () => {
    for (const status of ['trial', 'candidate', 'inconclusive']) db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', 'x', ?, 'dream', ?, datetime('now'), datetime('now'))").run(`g-${status}`, JSON.stringify(LINES), status);
    const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP); const file = lease('maker-1');
    expect(planGenomeApply(db, { goalId: goal, loopName: 'test-gap-loop', runtime: 'atomic', model: 'llama-router' }).plan).toBeNull();
    expect(apply('maker-1', goal)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(ASSIGNMENT);
  });
});

describe('delivery: the lines reach the maker assignment exactly once, with a receipt', () => {
  beforeEach(() => { vi.stubEnv('GENOME_APPLY_MODE', 'on'); });
  it('treatment arm: each line once in LOOP_WORK.md; lease records genome id + lines sha256 + assignment sha256; idempotent', () => {
    const id = promoted(); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP); const file = lease('maker-1');
    const r = apply('maker-1', goal);
    expect(r).toMatchObject({ arm: 'treatment', genome_id: id, delivered: true });
    apply('maker-1', goal); // a second call adds nothing
    const text = fs.readFileSync(file, 'utf8');
    for (const l of LINES) expect(occurrences(text, l)).toBe(1);
    expect(text.startsWith(ASSIGNMENT.trimEnd())).toBe(true);
    expect(leaseMeta('maker-1').genome_apply).toMatchObject({ mode: 'on', arm: 'treatment', genome_id: id, lines: 2, lines_sha256: genomeLinesSha256(LINES),
      delivered: true, genome_lines_found: 2, assignment_sha256: sha(text) });
  });
  it('remote maker of the trialled species (remote@workstation/atomic@llama-router) qualifies too', () => {
    promoted(); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP); const file = lease('maker-1', 'remote', 'workstation/atomic@llama-router');
    expect(apply('maker-1', goal)).toMatchObject({ arm: 'treatment', delivered: true });
    expect(occurrences(fs.readFileSync(file, 'utf8'), LINES[0])).toBe(1);
  });
  it('holdout arm: no line in the assignment; the lease records the holdout arm and the genome it withheld', () => {
    const id = promoted(); const goal = goalIn('holdout'); seedGoal(goal, TEST_GAP); const file = lease('maker-1');
    expect(apply('maker-1', goal)).toMatchObject({ arm: 'holdout', genome_id: id, delivered: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(ASSIGNMENT);
    expect(leaseMeta('maker-1').genome_apply).toMatchObject({ arm: 'holdout', genome_id: id, lines_sha256: genomeLinesSha256(LINES), delivered: false });
  });
  it.each(['off', 'shadow'])('%s: unchanged — no line, no receipt', (mode) => {
    promoted(); vi.stubEnv('GENOME_APPLY_MODE', mode); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP); const file = lease('maker-1');
    expect(apply('maker-1', goal)).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(ASSIGNMENT);
    expect(leaseMeta('maker-1').genome_apply).toBeUndefined();
  });
  it('never TG/PL/CV gym runs, non-oracle lanes, goal-less runs or another species', () => {
    promoted(); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP);
    const docGoal = goalIn('treatment', 1000); seedGoal(docGoal, ['doc-drift:README.md']);
    const file = lease('maker-1');
    for (const loop of ['tg-001', 'pl-001', 'cv-001', 'evolution-gym']) expect(apply('maker-1', goal, loop), loop).toBeNull();
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('run-1', 'test-gap-loop', 'closed', 'running', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ gym: { commit: 'h1', species: SPECIES } }));
    expect(apply('maker-1', goal), 'run carrying gym metadata').toBeNull();
    db.prepare("UPDATE loop_runs SET metadata = '{}' WHERE id = 'run-1'").run();
    expect(apply('maker-1', docGoal), 'non-oracle lane').toBeNull();
    expect(apply('maker-1', null), 'no goal').toBeNull();
    lease('maker-2', 'opencode', null);
    expect(apply('maker-2', goal), 'another species').toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(ASSIGNMENT);
    expect(apply('maker-1', goal)).toMatchObject({ delivered: true }); // the same lease on its oracle goal does get it
  });
  it('not applied to a species the genome was never trialled on, even when DREAM_EVOLUTION_SPECIES now names it', () => {
    promoted(); vi.stubEnv('DREAM_EVOLUTION_SPECIES', 'codex'); const goal = goalIn('treatment'); seedGoal(goal, TEST_GAP);
    lease('maker-1', 'codex', null);
    const r = planGenomeApply(db, { goalId: goal, loopName: 'test-gap-loop', runtime: 'codex', model: null });
    expect(r.plan).toBeNull(); expect(r.reason).toMatch(/trialled/);
  });
});

describe('loop daemon: the assignment the maker runs on', () => {
  const stubLoops = () => ({
    startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', loop_name: 'test-gap-loop', findings: [{ id: 'finding-1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
    continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'atomic' }, { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' }] })),
    executeWorker: vi.fn(async () => ({})),
    runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
    retryLoopRun: vi.fn(), executeChecker: vi.fn(async () => ({})),
    verifyLoopRun: vi.fn(() => ({ gates: [{ name: 'checker_verdict', status: 'pass' }] })),
    pruneOrphanedWorktrees: vi.fn(),
  });
  async function daemonRun(arm: 'treatment' | 'holdout') {
    const goal = new GoalService(db).createGoal({ objective: 'Add a test for a.ts', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    const goalId = goalIn(arm, 5000); // the arm is a pure function of the goal id
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
      VALUES ('p-1', 'test', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, datetime('now'), datetime('now'))`).run(JSON.stringify(TEST_GAP));
    db.prepare("UPDATE goals SET id = ?, status = 'decomposed', improvement_id = 'p-1' WHERE id = ?").run(goalId, goal.id);
    const file = lease('maker-1');
    const daemon = new LoopDaemon(db, stubLoops() as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
    const refs = JSON.parse((db.prepare('SELECT evidence_refs_json AS r FROM skill_outcomes WHERE skill_id NOT LIKE ?').get('loop-maker:gym:%') as { r: string }).r) as string[];
    return { text: fs.readFileSync(file, 'utf8'), meta: leaseMeta('maker-1'), refs };
  }
  it('on, treatment: the lines are in the maker assignment once, delivered, credited to the genome and tagged on the outcome', async () => {
    const id = promoted(); vi.stubEnv('GENOME_APPLY_MODE', 'on');
    const { text, meta, refs } = await daemonRun('treatment');
    for (const l of LINES) expect(occurrences(text, l)).toBe(1);
    expect(meta.genome_apply).toMatchObject({ arm: 'treatment', genome_id: id, delivered: true, lines_sha256: genomeLinesSha256(LINES) });
    expect(meta.genome_id).toBe(id);
    expect(refs).toEqual(expect.arrayContaining([`genome-apply:treatment:${id}`, `strategy_genome:${id}`]));
  });
  it('on, holdout: no lines, no strategy credit for the genome, outcome tagged holdout', async () => {
    const id = promoted(); vi.stubEnv('GENOME_APPLY_MODE', 'on');
    const { text, meta, refs } = await daemonRun('holdout');
    expect(occurrences(text, LINES[0])).toBe(0);
    expect(meta.genome_apply).toMatchObject({ arm: 'holdout', genome_id: id });
    expect(meta.genome_id).toBeUndefined();
    expect(refs).toContain(`genome-apply:holdout:${id}`);
    expect(refs.some((r) => r.startsWith('strategy_genome:'))).toBe(false);
  });
  it('off: today — no lines, no receipt, no genome-apply ref (attribution as before)', async () => {
    const id = promoted();
    const { text, meta, refs } = await daemonRun('treatment');
    expect(text).toBe(ASSIGNMENT);
    expect(meta.genome_apply).toBeUndefined();
    expect(meta.genome_id).toBe(id);
    expect(refs.some((r) => r.startsWith('genome-apply:'))).toBe(false);
  });
});

describe('auto-retire (never promotes)', () => {
  const outcome = (arm: 'treatment' | 'holdout', genomeId: string, ok: boolean, extra: string[] = []) => {
    const id = `o${seq++}`;
    db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, model, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap-loop:atomic', ?, 'test-gap-loop', ?, 'llama-router', ?, datetime('now'))")
      .run(id, ok ? 1 : 0, `run-${id}`, JSON.stringify([`loop_run:run-${id}`, `genome-apply:${arm}:${genomeId}`, ...extra]));
  };
  const seed = (genomeId: string, t: [number, number], h: [number, number]) => {
    for (let i = 0; i < t[1]; i++) outcome('treatment', genomeId, i < t[0]);
    for (let i = 0; i < h[1]; i++) outcome('holdout', genomeId, i < h[0]);
  };
  const status = (id: string) => (db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(id) as { status: string }).status;
  beforeEach(() => { vi.stubEnv('GENOME_APPLY_MODE', 'on'); });

  it('≥ 20 delivered outcomes whose Wilson upper bound is below the holdout rate → retired, with an evidence row and a stall', () => {
    const id = promoted(); seed(id, [6, 20], [9, 10]); // 0.30 (Wilson upper ≈ 0.52) vs 0.90
    const decisions = genomeApplyRetireCheck(db);
    expect(decisions).toEqual([expect.objectContaining({ genome_id: id, retired: true })]);
    expect(status(id)).toBe('retired');
    const ev = db.prepare("SELECT decision, subject_id, answers_json FROM judgments WHERE judgment = 'genome_apply_retire'").all() as Array<{ decision: string; subject_id: string; answers_json: string }>;
    expect(ev).toEqual([expect.objectContaining({ decision: 'retired', subject_id: id })]);
    expect(JSON.parse(ev[0].answers_json)).toMatchObject({ treatment: { n: 20, verified: 6 }, holdout: { n: 10, verified: 9 } });
    expect(db.prepare("SELECT decision FROM judgments WHERE judgment = 'stall' AND subject_id = ?").get(`genome_apply:${id}`)).toEqual({ decision: 'open' });
    expect(detectStallsWithHealth(db, Date.now(), process.env).stalls.map((s) => s.subsystem)).toContain(`genome_apply:${id}`);
    expect(genomeApplyRetireCheck(db)).toEqual([]); // once
  });
  it('19 delivered outcomes is not enough; a gap inside the Wilson CI keeps it; a small holdout is insufficient', () => {
    const a = promoted('g-a'); seed(a, [5, 19], [9, 10]);
    expect(genomeApplyRetireCheck(db)).toEqual([]); expect(status(a)).toBe('active');
    outcome('treatment', a, true); // n = 20, 6/20: upper ≈ 0.52 < 0.90 → now it retires
    expect(genomeApplyRetireCheck(db)[0]).toMatchObject({ genome_id: a, retired: true });
  });
  it('within the CI → kept; holdout below 5 → insufficient (kept)', () => {
    const a = promoted('g-a'); seed(a, [12, 20], [7, 10]); // 0.60 (upper ≈ 0.78) vs 0.70
    expect(genomeApplyRetireCheck(db)).toEqual([]); expect(status(a)).toBe('active');
    const ev = genomeApplyEvidence(db);
    expect(ev.genomes?.find((g) => g.genome_id === a)).toMatchObject({ decision: 'keep', treatment: { n: 20, verified: 12, rate: 0.6 }, holdout: { n: 10, verified: 7, rate: 0.7 } });
  });
  it('maker-clean (bandit proxy): infra / no-change zeros and reviewer-attributed failures are not counted', () => {
    const a = promoted('g-a');
    for (let i = 0; i < 20; i++) outcome('treatment', a, false, ['outcome_class:infra_failed']);
    seed(a, [0, 0], [9, 10]);
    expect(genomeApplyEvidence(db).genomes?.find((g) => g.genome_id === a)?.treatment).toMatchObject({ n: 0, verified: 0, rate: null, ci: null });
    expect(genomeApplyRetireCheck(db)).toEqual([]);
  });
  it('never promotes and never touches a non-active genome; off/shadow never retire', () => {
    const a = promoted('g-a'); seed(a, [6, 20], [9, 10]);
    db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-t', 'baseline', 'x', '[]', 'dream', 'trial', datetime('now'), datetime('now'))").run();
    seed('g-t', [20, 20], [0, 10]);
    vi.stubEnv('GENOME_APPLY_MODE', 'shadow'); expect(genomeApplyRetireCheck(db)).toEqual([]); expect(status(a)).toBe('active');
    vi.stubEnv('GENOME_APPLY_MODE', 'on'); genomeApplyRetireCheck(db);
    expect(status(a)).toBe('retired'); expect(status('g-t')).toBe('trial');
    expect((db.prepare("SELECT COUNT(*) AS n FROM maker_genomes WHERE status = 'active'").get() as { n: number }).n).toBe(1); // the baseline only
  });
});

describe('evidence section genome_apply', () => {
  it('delivered vs holdout counts and rates per genome, lease counts and retire decisions; null rates on no data, never 0', () => {
    expect(genomeApplyEvidence(db)).toMatchObject({ mode: 'off', holdout_rate: GENOME_APPLY_HOLDOUT_RATE, genomes: [], retire_decisions: [] });
    const e = buildEvolutionEvidence(db) as unknown as { genome_apply: ReturnType<typeof genomeApplyEvidence> };
    expect(e.genome_apply).toMatchObject({ mode: 'off', genomes: [] });
    db.exec('DROP TABLE skill_outcomes');
    expect(genomeApplyEvidence(db).genomes).toBeNull(); // unreadable = unknown
  });
});
