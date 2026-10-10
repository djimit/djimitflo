import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { attributeOutcome, recordOutcomeAttribution, type AttributionLease } from '../services/outcome-attribution';
import { chooseSpecies } from '../services/runtime-bandit';
import { fitnessPosterior } from '../services/fitness-view';
import { assignmentContext } from '../services/assignment-context';
import { earnedAutonomy } from '../services/earned-autonomy';
import { operatorCockpit } from '../services/operator-cockpit';
import { createHealthRoutes } from '../routes/health';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createTestDb } from './helpers/test-db';

const maker = (status: string, metadata: AttributionLease['metadata'] = { exit_status: 0, completed_at: 'x', changed_files: ['a.ts'] }): AttributionLease => ({ id: 'm', role: 'maker', status, metadata });
const reviewer = (role: string, status: string, verdict?: string): AttributionLease => ({ role, status, metadata: { maker_lease_id: 'm', ...(verdict ? { verdict } : {}) } });

describe('attributeOutcome', () => {
  it('verified when every gate passed, with merge survival once known', () => {
    expect(attributeOutcome({ failed_gates: [], maker: maker('completed'), reviewers: [] })).toMatchObject({ outcome: 'verified', survived: null });
    expect(attributeOutcome({ failed_gates: [], maker: maker('completed'), reviewers: [], pr_outcome: { survived: true } }).survived).toBe(true);
  });
  it('reviewer_failure: maker completed, reviewer timed out / missing / inconclusive', () => {
    for (const reviewers of [[reviewer('checker', 'failed')], [], [reviewer('checker', 'completed', 'insufficient_evidence')]]) {
      expect(attributeOutcome({ failed_gates: ['checker_verdict: Every completed maker lease requires an accepted checker verdict.'], maker: maker('completed'), reviewers }).outcome).toBe('reviewer_failure');
    }
    expect(attributeOutcome({ failed_gates: ['security_checker_verdict'], maker: maker('completed'), reviewers: [reviewer('checker', 'completed', 'accepted'), reviewer('security_checker', 'failed')] }).outcome).toBe('reviewer_failure');
  });
  it('maker_failure: a reviewer that ran said no, or the maker\'s own checks/diff/scope failed', () => {
    expect(attributeOutcome({ failed_gates: ['checker_verdict'], maker: maker('completed'), reviewers: [reviewer('checker', 'completed', 'rejected')] }).outcome).toBe('maker_failure');
    expect(attributeOutcome({ failed_gates: ['checker_verdict'], maker: maker('completed'), reviewers: [reviewer('checker', 'completed', 'needs_revision')] }).outcome).toBe('maker_failure');
    expect(attributeOutcome({ failed_gates: ['tests_lint_typecheck', 'checker_verdict'], maker: maker('completed'), reviewers: [] }).outcome).toBe('maker_failure');
    expect(attributeOutcome({ failed_gates: ['maker_completion'], maker: maker('failed', { failure_reason: 'maker_runtime_exit_zero', exit_status: 1, changed_files: ['README.md'] }), reviewers: [] }).outcome).toBe('maker_failure');
  });
  it('environment_failure: the maker never ran, timed out, a check tool was missing, no change, or the worktree vanished', () => {
    const env = (failed_gates: string[], m: AttributionLease | null) => attributeOutcome({ failed_gates, maker: m, reviewers: [] }).outcome;
    expect(env(['maker_completion'], null)).toBe('environment_failure');
    expect(env(['maker_completion'], maker('failed', { timed_out: true }))).toBe('environment_failure');
    expect(env(['maker_completion'], maker('failed', {}))).toBe('environment_failure');
    expect(env(['tests_lint_typecheck'], maker('completed', { exit_status: 0, completed_at: 'x', changed_files: ['a.ts'], deterministic_checks: [{ exit_status: 127 }] }))).toBe('environment_failure');
    expect(env(['checker_verdict'], maker('completed', { exit_status: 0, completed_at: 'x', changed_files: [] }))).toBe('environment_failure');
    expect(env(['worktree_isolation'], maker('completed'))).toBe('environment_failure');
  });
  it('an operator annotation wins (newest first)', () => {
    expect(attributeOutcome({ failed_gates: ['tests_lint_typecheck'], maker: maker('completed'), reviewers: [],
      annotations: [{ decision: 'maker_failure', created_at: '2026-10-01' }, { decision: 'reviewer_failure', created_at: '2026-10-08' }] })).toMatchObject({ outcome: 'reviewer_failure', reason: 'annotation' });
  });
});

// ---- consumers ----
const LOOP = 'doc-drift-and-small-fix-loop';
let db: Database.Database; let checkout: string;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 86_400_000;

/** one maker run with its proposal outcome, skill outcome, approval and (runs 1–3) a read of rule rA */
function run(n: number, outcome: 'verified' | 'regressed', annotate?: { on: 'run' | 'proposal'; decision: string }) {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, '["test-gap:x"]', ?, ?)`).run(`s${n}`, outcome, iso(DAY), iso(DAY / 2));
  db.prepare(`INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 'o', 'low', 'completed')`).run(`g${n}`, `s${n}`);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?, ?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(`r${n}`, `g${n}`, LOOP, iso(DAY), iso(DAY));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)`).run(`l${n}`, `r${n}`, JSON.stringify({ execution_task_id: `t${n}` }), iso(DAY), iso(DAY));
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, created_at) VALUES (?, ?, 'approved', 'high', 'high_risk_action', 'm', '{}', 'dennis', ?)`).run(`a${n}`, `t${n}`, iso(DAY));
  new SkillEvolutionEngine(db).recordOutcome(`loop-maker:${LOOP}:opencode`, { success: outcome === 'verified', tokensUsed: 0, durationMs: 1, domain: LOOP, taskId: `r${n}`, agentId: `l${n}`, evidenceRefs: [`loop_run:r${n}`, 'genome:gA'] });
  if (n < 4) db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)').run(`acc${n}`, 'rA', `loop-maker:r${n}`, iso(DAY));
  if (annotate) {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'outcome_attribution', ?, ?, ?, 'annotation', ?, 'x', ?)`)
      .run(`j${n}`, annotate.on === 'run' ? 'loop_run' : 'self_improvement', annotate.on === 'run' ? `r${n}` : `s${n}`, annotate.decision, annotate.decision, iso(DAY / 4));
  }
}

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'));
  // an old rule: shown only while its fitness (verified − regressed reads) is > 0
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
    VALUES ('rA', 't', 'Run the focused test first.', 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(iso(30 * DAY), iso(30 * DAY));
  run(1, 'verified');
  run(2, 'regressed', { on: 'proposal', decision: 'reviewer_failure' }); // the 08-10 operator annotations
  run(3, 'regressed', { on: 'run', decision: 'environment_failure' });   // computed at settle time
  run(4, 'regressed');                                                   // a real maker failure
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(checkout, { recursive: true, force: true }); });

describe('maker-side learners count only maker_failure when OUTCOME_ATTRIBUTION_ENABLED', () => {
  const species = [{ runtime: 'opencode' }, { runtime: 'codex' }];
  it('runtime bandit', () => {
    expect(chooseSpecies(db, LOOP, species, () => 0.5)?.posterior[0]).toMatchObject({ runs: 4, ok: 1 }); // off: old behaviour
    vi.stubEnv('OUTCOME_ATTRIBUTION_ENABLED', 'true');
    expect(chooseSpecies(db, LOOP, species, () => 0.5)?.posterior[0]).toMatchObject({ runs: 2, ok: 1 });
  });
  it('fitness view', () => {
    expect(fitnessPosterior(db, LOOP, species, NOW, {})[0].sources.production).toEqual({ n: 4, ok: 1 });
    expect(fitnessPosterior(db, LOOP, species, NOW, { OUTCOME_ATTRIBUTION_ENABLED: 'true' })[0].sources.production).toEqual({ n: 2, ok: 1 });
  });
  it('memory-rule fitness (M5)', () => {
    const ctx = (env: NodeJS.ProcessEnv) => assignmentContext(db, { id: 'next', goal_id: null }, checkout, 'maker-next', { LOOP_MEMORY_RULES_ENABLED: 'true', ...env }).rules.map((r) => r.id);
    expect(ctx({})).toEqual([]); // read by 1 verified + 2 regressed runs: fitness −1, an old rule is left out
    expect(ctx({ OUTCOME_ATTRIBUTION_ENABLED: 'true' })).toEqual(['rA']); // both regressions were not the maker's: fitness +1
  });
  it('earned autonomy (U1) class counts', () => {
    expect(earnedAutonomy(db, NOW, {})[0]).toMatchObject({ verified: 1, regressed: 3, non_maker: 0 });
    expect(earnedAutonomy(db, NOW, { OUTCOME_ATTRIBUTION_ENABLED: 'true' })[0]).toMatchObject({ verified: 1, regressed: 1, non_maker: 2 });
  });
  it('production genome win rates and the regressions guardrail', () => {
    const off = operatorCockpit(db, NOW, {});
    expect(off.genomes.find((g) => g.scope === 'production')).toMatchObject({ genome: 'gA', outcomes: 4, wins: 1 });
    // the third regression carries no attribution: unknown (Cockpit 3.0), no longer silently the maker's
    expect(off.guardrails[0]).toMatchObject({ name: 'regressions', value: 3, split: { maker: 0, reviewer: 1, environment: 1, unknown: 1 } });
    const on = operatorCockpit(db, NOW, { OUTCOME_ATTRIBUTION_ENABLED: 'true' });
    expect(on.genomes.find((g) => g.scope === 'production')).toMatchObject({ genome: 'gA', outcomes: 2, wins: 1 });
    expect(on.guardrails[0]).toMatchObject({ name: 'regressions', value: 0, state: 'DEGRADED', split: { maker: 0, reviewer: 1, environment: 1, unknown: 1 } });
  });
});

describe('recording and credit', () => {
  function settled(id: string, gatesPass: boolean, reviewerStatus: 'completed' | 'failed') {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', 'executing', '["test-gap:y","kb:pages/testing.md"]', ?, ?)`).run(`s-${id}`, iso(DAY), iso(DAY));
    db.prepare(`INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 'o', 'low', 'running')`).run(`g-${id}`, `s-${id}`);
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?, ?, ?, 'closed', 'running', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(id, `g-${id}`, LOOP, iso(DAY), iso(DAY));
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'completed', ?)`).run(`m-${id}`, id, JSON.stringify({ model: 'ollama/kimi-k2.6:cloud', exit_status: 0, completed_at: 'x', changed_files: ['a.test.ts'], genome: { id: 'gB' } }));
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'checker', 'opencode', ?, ?)`).run(`c-${id}`, id, reviewerStatus, JSON.stringify({ maker_lease_id: `m-${id}`, ...(reviewerStatus === 'completed' ? { verdict: 'accepted' } : { failure_reason: 'checker_runtime_failed:exit=1,timed_out=true' }) }));
    db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata) VALUES (?, ?, 'assignment_context', 'info', 'm', ?)`).run(`e-${id}`, id, JSON.stringify({ rule_ids: ['rA'], examples: ['packages/x.test.ts — Add tests'] }));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'enforce', 'yes', 'ok', ?)`).run(`jp-${id}`, `s-${id}`, iso(DAY));
    return gatesPass ? [] : ['checker_verdict'];
  }
  const rows = (id: string) => db.prepare("SELECT subject_type, mode, decision FROM judgments WHERE judgment = 'outcome_attribution' AND subject_id = ?").all(id);

  it('is off by default: nothing recorded', () => {
    expect(recordOutcomeAttribution(db, 'rv', 'm-rv', settled('rv', true, 'completed'), {})).toBeNull();
    expect(rows('rv')).toEqual([]);
  });

  it('records one annotation per settled run and credits the contributors of a verified run', () => {
    const env = { OUTCOME_ATTRIBUTION_ENABLED: 'true' };
    expect(recordOutcomeAttribution(db, 'rv', 'm-rv', settled('rv', true, 'completed'), env)?.outcome).toBe('verified');
    expect(recordOutcomeAttribution(db, 'rv', 'm-rv', [], env)).toBeNull(); // once per run
    expect(rows('rv')).toEqual([{ subject_type: 'loop_run', mode: 'annotation', decision: 'verified' }]);
    const credits = db.prepare('SELECT kind, ref FROM outcome_credits WHERE run_id = ? ORDER BY kind, ref').all('rv');
    expect(credits).toEqual([
      { kind: 'example', ref: 'packages/x.test.ts' }, { kind: 'genome', ref: 'gB' }, { kind: 'judgment', ref: 'proposal_prescreen' },
      { kind: 'knowledge', ref: 'kb:pages/testing.md' }, { kind: 'maker', ref: 'opencode@ollama/kimi-k2.6:cloud' }, { kind: 'memory_rule', ref: 'rA' },
      { kind: 'model', ref: 'ollama/kimi-k2.6:cloud' }, { kind: 'reviewer', ref: 'checker:opencode' },
    ]);

    expect(recordOutcomeAttribution(db, 'rr', 'm-rr', settled('rr', false, 'failed'), env)?.outcome).toBe('reviewer_failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_credits WHERE run_id = ?').get('rr')).toEqual({ n: 0 }); // failures credit nobody
    expect(db.prepare("SELECT status FROM self_improvements WHERE id = 's-rr'").get()).toEqual({ status: 'executing' }); // never touched
  });

  it('GET /api/health/attribution needs read:evidence and summarises classes and top contributors', async () => {
    const env = { OUTCOME_ATTRIBUTION_ENABLED: 'true' };
    recordOutcomeAttribution(db, 'rv', 'm-rv', settled('rv', true, 'completed'), env);
    recordOutcomeAttribution(db, 'rr', 'm-rr', settled('rr', false, 'failed'), env);
    const authDb = createTestDb();
    const authService = new AuthService(authDb);
    const viewer = authService.generateToken(authService.createUser('attr-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, createAuthMiddleware(authService)));
    expect((await request(app).get('/api/health/attribution')).status).toBe(401);
    const res = await request(app).get('/api/health/attribution').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    expect(res.body.classes).toEqual({ maker_failure: 0, reviewer_failure: 2, environment_failure: 1, verified: 1 });
    expect(res.body.credited_runs).toBe(1);
    expect(res.body.top_contributors).toContainEqual({ kind: 'maker', ref: 'opencode@ollama/kimi-k2.6:cloud', credits: 1 });
    authDb.close();
  });
});
