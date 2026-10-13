import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { claimCommittee, enqueueCommittee, recordCommittee } from '../services/committee-swarm';
import { forecastScores, forecastScoresV2 } from '../services/forecast-scoring';
import { sourceRate } from '../services/forecasters';
import { fitnessPosterior, recordFitnessShadow } from '../services/fitness-view';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { assignmentContext } from '../services/assignment-context';
import { BASELINE_GENOME } from '../services/genome-registry';
import { holdoutValidity, promoteGenome } from '../services/genome-promotion';
import { RemoteGymService } from '../services/remote-gym-service';
import { infraFailing, triedTasks } from '../services/evolution-gym-service';
import { classifyTgFailure, pairedTable, tgObservation } from '../services/tg-001';

// E2 global invariant: no valid observation ≠ negative observation. A generation / parse / infra failure is never scored as a
// semantic "no" (Brier loss, fitness 0, species failure, retired genome).
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const prop = (id: string, status: string, created = ago(3)) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?)`).run(id, id, status, created, created);
const forecast = (judgment: string, subject: string, p: number, at = ago(2)) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
  VALUES (?, ?, 'self_improvement', ?, '', 'shadow', 'yes', '', ?, ?)`).run(`${judgment}-${subject}`, judgment, subject, JSON.stringify({ p }), at);

describe('committee / forecasts', () => {
  it('a failed member answer (p null, empty, boolean, or carrying an error) is not a forecast of 0', async () => {
    vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
    prop('p1', 'proposed');
    const job = enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' })!;
    await claimCommittee(db, 'workstation');
    const n = recordCommittee(db, job, 'workstation', [
      { member: 'cm-oracle', p: null, error: 'timeout' }, { member: 'cm-skeptic', p: '' }, { member: 'cm-engineer', p: false },
      { member: 'cm-oracle', p: 0, error: 'parse failed' }, { member: 'cm-skeptic', p: 0.7 },
    ]);
    expect(n).toBe(1);
    const rows = db.prepare("SELECT judgment, answers_json FROM judgments WHERE judgment LIKE 'forecast:committee:%'").all() as Array<{ judgment: string; answers_json: string }>;
    expect(rows.map((r) => [r.judgment, JSON.parse(r.answers_json).p])).toEqual([['forecast:committee:cm-skeptic', 0.7]]);
    // the committee's own aggregate is the valid member alone, not dragged to 0 by the failed ones
    expect(JSON.parse((db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'forecast:committee'").get() as { answers_json: string }).answers_json).p).toBe(0.7);
  });

  it('a proposal that ended infra_failed is not a resolved negative: no Brier loss for its forecasters (V1, V2, base rate)', () => {
    prop('ok', 'verified'); prop('bad', 'regressed'); prop('infra', 'infra_failed');
    for (const id of ['ok', 'bad', 'infra']) forecast('forecast:f', id, id === 'bad' ? 0.1 : 0.9);
    const v1 = forecastScores(db).find((s) => s.forecaster === 'forecast:f')!;
    expect(v1).toMatchObject({ n: 2, positives: 1 });
    expect(v1.brier).toBeCloseTo(0.01, 6); // (0.9-1)² and (0.1-0)², the infra row would add (0.9-0)²
    const v2 = forecastScoresV2(db, { boot: 10 }).forecasters.find((s) => s.forecaster === 'forecast:f')!;
    expect(v2.n).toBe(2);
    expect(sourceRate(db, 'gap_analysis')).toBeCloseTo((1 + 1) / (2 + 2)); // 1 verified of 2 resolved, Laplace
  });
});

describe('memory + skill fitness', () => {
  const lane = 'doc-drift-and-small-fix-loop';
  const NOW = Date.parse('2026-10-03T12:00:00Z');
  const outcome = (skill: string, model: string, success: boolean, refs: string[] = []) => db.prepare(`INSERT INTO skill_outcomes
    (id, skill_id, success, tokens_used, duration_ms, domain, model, evidence_refs_json, created_at) VALUES (?, ?, ?, 0, 0, 'x', ?, ?, ?)`)
    .run(`${Math.random()}`, skill, success ? 1 : 0, model, JSON.stringify(refs), new Date(NOW).toISOString());

  it('the fitness-view shadow pick reads the clean posterior: infra / no-change zeros do not sink a species', () => {
    vi.stubEnv('FITNESS_SHADOW_ENABLED', 'true');
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES ('r1', 'l', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))").run();
    // opencode: 2 wins + 6 infra/no-change zeros; codex: 2 wins + 2 real regressions
    for (let i = 0; i < 2; i++) { outcome(`loop-maker:${lane}:opencode`, '', true); outcome(`loop-maker:${lane}:codex`, '', true); }
    for (let i = 0; i < 3; i++) { outcome(`loop-maker:${lane}:opencode`, '', false, ['outcome_class:infra_failed']); outcome(`loop-maker:${lane}:opencode`, '', false, ['outcome_class:no_change']); }
    for (let i = 0; i < 2; i++) outcome(`loop-maker:${lane}:codex`, '', false, ['outcome_class:regressed']);
    recordFitnessShadow(db, 'r1', lane, [{ runtime: 'codex' }, { runtime: 'opencode' }], 'codex', NOW);
    const meta = JSON.parse((db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'fitness_shadow'").get() as { metadata: string }).metadata);
    expect(meta.would_pick).toBe('opencode');
  });

  it('skill reliability leaves out infra / no-change zeros; only such zeros is insufficient evidence (null), not 0', () => {
    const skills = new SkillEvolutionEngine(db);
    outcome('loop-maker:l:opencode', '', false, ['outcome_class:infra_failed']);
    outcome('loop-maker:l:opencode', '', false, ['outcome_class:no_change']);
    expect(skills.measuredTraits('loop-maker:l:opencode').reliability).toBeNull();
    outcome('loop-maker:l:opencode', '', true); outcome('loop-maker:l:opencode', '', false, ['outcome_class:regressed']);
    expect(skills.measuredTraits('loop-maker:l:opencode').reliability).toBeCloseTo(0.5);
  });

  it('memory-rule fitness: reads by infra_failed / no_change runs cost a rule nothing; real regressions do (test-only)', () => {
    vi.stubEnv('LOOP_MEMORY_RULES_ENABLED', 'true');
    const now = new Date().toISOString();
    const rule = (id: string, content: string) => db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, source_ref, status, promotion_status, sensitivity, created_at, updated_at)
      VALUES (?, ?, ?, 'engineering_rule', 'x', 'promoted', 'promoted', 'normal', ?, ?)`).run(id, id, content, now, now);
    const readBy = (ruleId: string, runId: string, status: string) => {
      db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 's', ?, 0.5, ?, ?)`).run(`s-${runId}`, status, now, now);
      db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)").run(`g-${runId}`, `s-${runId}`, now, now);
      db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?, ?, 'l', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)").run(runId, `g-${runId}`, now, now);
      db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)').run(`a-${runId}`, ruleId, `loop-maker:${runId}`, now);
    };
    rule('m-infra', 'Infra rule.'); rule('m-reg', 'Regressing rule.');
    for (const [i, st] of ['infra_failed', 'infra_failed', 'no_change'].entries()) readBy('m-infra', `ri${i}`, st);
    for (let i = 0; i < 2; i++) readBy('m-reg', `rr${i}`, 'regressed');
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES ('now', 'l', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', ?, ?)").run(now, now);
    const ids = assignmentContext(db, { id: 'now', goal_id: null }, '/nonexistent-checkout', 'maker').rules.map((r) => r.id);
    expect(ids).toContain('m-infra');
    expect(ids).not.toContain('m-reg');
  });
});

describe('genome promotion', () => {
  const ISO = '2026-10-11T12:00:00.000Z';
  const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
    .run(id, BASELINE_GENOME, ISO, ISO);
  beforeEach(() => {
    db.prepare("INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)").run(BASELINE_GENOME, ISO, ISO);
  });

  it('unknown holdout validity (the deciding loop_runs cannot be read) → inconclusive, never active and never retired', () => {
    trial('g1');
    db.exec('DROP TABLE loop_runs');
    const r = promoteGenome(db, 'g1', 'mined', ['c1', 'c2'], 'would promote', ISO);
    expect(r).toMatchObject({ promoted: false, validity: { state: 'unknown' } });
    expect(r.validity.reason).toMatch(/^holdout_validity_unknown: /);
    expect(db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get('g1')).toEqual({ status: 'inconclusive' });
  });

  it('unknown is never valid: the mutant holdout with no deciding tasks is unknown, and an unknown result never reads as exhausted', () => {
    const v = holdoutValidity(db, 'mutant', []);
    expect(v.state).toBe('unknown');
    expect(v.candidates).toBeNull();
  });
});

describe('TG + gym oracle (tests only — tg-001.ts / remote-gym-service.ts unchanged)', () => {
  const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });

  it('a gym infra discard records no skill outcome, so the species fitness posterior is unchanged', () => {
    vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
    const svc = new RemoteGymService(db, () => [TASK('c1')] as never);
    const before = fitnessPosterior(db, 'l', [{ runtime: 'remote', model: 'workstation/atomic@llama-router' }])[0];
    const { runId } = svc.claim('workstation', ['atomic@llama-router']) as { runId: string };
    svc.record(runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
    expect(fitnessPosterior(db, 'l', [{ runtime: 'remote', model: 'workstation/atomic@llama-router' }])[0]).toEqual(before);
    // one infra discard keeps the task open for the species (it was not a real attempt)
    expect(triedTasks(db, 'atomic@llama-router').has('c1')).toBe(false);
    // infra trips the breaker (operational), it never becomes a species failure
    expect(infraFailing(db, 'atomic@llama-router', ago(24))).toBe(false);
  });

  it('TG oracle: infra-exhausted / invalid / pending are not failures and never enter the paired table', () => {
    expect(tgObservation('infra_exhausted', 'discarded')).toBe('INFRA_CENSORED');
    expect(tgObservation('invalid', 'discarded')).toBe('INVALID');
    expect(tgObservation('done', null)).toBe('INVALID');
    expect(tgObservation('claimed', null)).toBe('pending');
    expect(classifyTgFailure('discarded', 'infra: npm ci failed', {})).toBe('INFRASTRUCTURE_FAILURE');
    const t = pairedTable([
      { task_key: 'k1', arm: 'A', status: 'success' }, { task_key: 'k1', arm: 'B', status: 'INFRA_CENSORED' },
      { task_key: 'k2', arm: 'A', status: 'INVALID' }, { task_key: 'k2', arm: 'B', status: 'failure' },
      { task_key: 'k3', arm: 'A', status: 'success' }, { task_key: 'k3', arm: 'B', status: 'failure' },
    ], 'A', 'B');
    expect(t).toMatchObject({ n_pairs: 1, A_only: 1, both_fail: 0 });
  });
});
