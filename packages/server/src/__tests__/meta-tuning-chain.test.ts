import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { LoopService, type LoopRunRecord } from '../services/loop-service';

let db: Database.Database;
let cognitive: CognitiveLoopClosureService;
let meta: MetaOrchestrationService;
let loops: LoopService;
const run = { id: 'fixture-run', goal_id: null, loop_name: 'doc-drift' } as unknown as LoopRunRecord;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  cognitive = new CognitiveLoopClosureService(db);
  meta = new MetaOrchestrationService(db);
  loops = new LoopService(db); loops.setMetaOrchestration(meta);
});
afterEach(() => { cognitive.stop(); meta.stop(); db.close(); });

function record(index: number, outcome: 'success' | 'failure' | 'partial' | 'cancelled' = 'success', totalTokens = 2000) {
  return cognitive.recordEpisode({
    loopRunId: `fixture-${index}`, goalId: 'fixture', goalType: 'doc-drift', mode: 'closed',
    startedAt: '2026-09-09T00:00:00Z', completedAt: new Date(Date.UTC(2026, 8, 9, 0, 0, index + 1)).toISOString(),
    durationMs: 1000, outcome, strategy: 'fixture', actions: [],
    metrics: { totalLeases: 1, completedLeases: outcome === 'success' ? 1 : 0, failedLeases: outcome === 'failure' ? 1 : 0,
      totalTokens, totalCostDollars: 999, diffLinesChanged: 1, filesModified: 1, gatesPassed: 1, gatesFailed: 0 },
    metadata: { synthetic: true, provider_executed: false },
  });
}

it('uses real canonical episodes to change the next effective budget decision with durable audit evidence', async () => {
  for (let i = 0; i < 20; i++) record(i);
  expect(loops.getTokenBudget(run)).toEqual({ source: 'none' });
  expect(loops.evaluateTokenBudget(run, { total_tokens: 3001 }, 'fixture-lease').gate.status).toBe('skipped');
  expect(await meta.runAutoTuning()).toEqual({ evaluated: 1, applied: 1 });
  expect(meta.getActiveLoopTuning('doc-drift')).toMatchObject({ recommendedConcurrency: 3, recommendedBudget: { maxTokens: 3000 }, confidence: 0.9 });
  expect(loops.getTokenBudget(run)).toEqual({ maxTokens: 3000, source: 'meta' });
  expect(loops.evaluateTokenBudget(run, { total_tokens: 3001 }, 'fixture-lease')).toMatchObject({ exhausted: true, gate: { status: 'fail' }, budget: { source: 'meta', maxTokens: 3000 } });
  expect(loops.getMakerLeaseBudget(run, {})).toEqual({ maxMakerWorkers: 3, source: 'meta' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='loop_tuning_applied'").get()).toEqual({ n: 1 });
  // A new service instance reads the same durable configuration without retuning.
  const restarted = new LoopService(db); restarted.setMetaOrchestration(new MetaOrchestrationService(db));
  expect(restarted.evaluateTokenBudget(run, { total_tokens: 3001 }, 'fixture-lease').exhausted).toBe(true);
});

it('preserves exact token boundaries, unknown usage and explicit operator limits', async () => {
  for (let i = 0; i < 20; i++) record(i);
  await meta.runAutoTuning();
  for (const tokens of [2999, 3000]) expect(loops.evaluateTokenBudget(run, { total_tokens: tokens }, 'fixture-lease').gate.status).toBe('pass');
  expect(loops.evaluateTokenBudget(run, null, 'fixture-lease')).toMatchObject({ exhausted: false, gate: { status: 'skipped' }, budget: { source: 'meta' } });
  db.prepare("INSERT INTO goals(id,objective,status,risk_class,budget_json) VALUES('explicit-goal','fixture','created','low',?)").run(JSON.stringify({ max_tokens: 1000, max_tokens_per_worker: 500, max_maker_workers: 1 }));
  const explicit = { ...run, goal_id: 'explicit-goal' };
  expect(loops.getTokenBudget(explicit)).toMatchObject({ maxTokens: 1000, maxTokensPerWorker: 500, source: 'goal' });
  expect(loops.evaluateTokenBudget(explicit, { total_tokens: 501 }, 'fixture-lease').exhausted).toBe(true);
  expect(loops.getMakerLeaseBudget(explicit, {})).toEqual({ maxMakerWorkers: 1, source: 'goal' });
});

it('does not count historical duplicate loop rows as independent tuning confidence', async () => {
  const original = record(0);
  for (let i = 0; i < 19; i++) db.prepare(`INSERT INTO cognitive_episodes
    (id,loop_run_id,goal_type,started_at,completed_at,duration_ms,outcome,metrics_json)
    SELECT ?,loop_run_id,goal_type,started_at,completed_at,duration_ms,outcome,metrics_json FROM cognitive_episodes WHERE id=?`)
    .run(`duplicate-${i}`, original.id);
  expect(await meta.runAutoTuning()).toEqual({ evaluated: 0, applied: 0 });
  expect(meta.getLoopTuning('doc-drift').confidence).toBe(0.3);
  expect(meta.getActiveLoopTuning('doc-drift')).toBeNull();
});

it('keeps failures, partial and cancelled outcomes in the non-success denominator', async () => {
  for (let i = 0; i < 20; i++) record(i, i < 5 ? 'success' : i < 10 ? 'failure' : i < 15 ? 'partial' : 'cancelled');
  expect(await meta.runAutoTuning()).toEqual({ evaluated: 1, applied: 1 });
  expect(meta.getLoopTuning('doc-drift')).toMatchObject({ recommendedConcurrency: 1, recommendedGateThresholds: { diffMaxLines: 100, minSuccessRate: 0.5 }, confidence: 0.9 });
});

it.each(['{broken', '{}', '{"totalTokens":-1}', '{"totalTokens":"2000"}'])('does not silently apply tuning from invalid canonical metrics %s', async metrics => {
  for (let i = 0; i < 20; i++) record(i);
  db.prepare("UPDATE cognitive_episodes SET metrics_json=? WHERE loop_run_id='fixture-19'").run(metrics);
  await expect(meta.runAutoTuning()).rejects.toThrow('META_TUNING_INVALID_EPISODE_EVIDENCE');
  expect(meta.getActiveLoopTuning('doc-drift')).toBeNull();
  expect(db.prepare('SELECT COUNT(*) AS n FROM meta_tuning_log WHERE applied=1').get()).toEqual({ n: 0 });
});
