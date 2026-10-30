import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { PredictiveAnalyticsService } from '../services/predictive-analytics-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { SelfHealingService } from '../services/self-healing-service';
import { runtimeHealth } from '../services/runtime-health';
import { MetaEvolutionService } from '../services/meta-evolution-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { learningCurveView } from '../services/swarm-learning-curve';
import { knowledgeFitness } from '../services/knowledge-fitness';
import { createMetricsHandler } from '../routes/metrics';
import { TelegramBotService } from '../services/telegram-bot-service';
import { BackgroundWorkerService } from '../services/background-worker-service';
import { createSwarmRoutes } from '../routes/swarms';
import { buildEvidencePack } from '../services/commons-evidence-pack';
import { ReflectionEngine } from '../services/reflection-engine';
import { AgiGoalReasoningEngine } from '../services/agi-goal-reasoning-engine';
import { attributionSummary } from '../services/outcome-attribution';
import { ReviewerIndependenceService } from '../services/reviewer-independence-service';
import { earnedAutonomy } from '../services/earned-autonomy';
import { approvalOutcomes } from '../services/intelligence-metrics';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';
import { detectStalls } from '../services/stall-watch';

/**
 * Follow-up to U3 (#1090): every loop quality / learning aggregate counts real runs only. The fixture is two real runs plus
 * synthetic PR-review runs (two marked at write time, one historical: repo-maintenance-loop + a 'manual' maker). Each
 * aggregate is computed on the full DB and on a DB holding the real rows only; the two must be equal.
 */
const H = 3_600_000;
const DAY = 24 * H;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();

type Lease = { role: string; runtime: string; status: string; meta?: Record<string, unknown> };
function seed(db: Database.Database, withSynthetic: boolean) {
  const goal = (id: string, status: string, updatedAgo: number) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, created_at, updated_at)
    VALUES (?, 'o', 'low', ?, ?, ?)`).run(id, status, iso(now - 4 * DAY), iso(now - updatedAgo));
  const run = (id: string, loop: string, status: string, ago: number, o: { goal?: string; meta?: Record<string, unknown>; gates?: unknown[]; findings?: unknown[] }, leases: Lease[]) => {
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, repository_path, findings_json, gates_json, metadata, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'closed', ?, '/repo', ?, ?, ?, ?, ?, ?)`).run(id, o.goal ?? null, loop, status, JSON.stringify(o.findings ?? []), JSON.stringify(o.gates ?? []),
      JSON.stringify(o.meta ?? {}), iso(now - ago), iso(now - ago + 60_000), status === 'completed' ? iso(now - ago + 60_000) : null);
    leases.forEach((l, i) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${id}-${i}`, id, l.role, l.runtime, l.status, JSON.stringify(l.meta ?? {}), iso(now - ago), iso(now - ago + 60_000)));
  };
  const approve = (id: string, runId: string) => {
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES (?, 't', 'd', 'completed', 'low', 'low', 'local', ?)")
      .run(`t-${id}`, JSON.stringify({ loop_run_id: runId }));
    db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, metadata, created_at)
      VALUES (?, ?, 'approved', 'low', 'tool_call', 'm', '{}', 'human:op', ?, ?)`).run(id, `t-${id}`, JSON.stringify({ loop_run_id: runId }), iso(now - H));
  };

  goal('g-real', 'completed', H);
  run('r-real', 'test-gap', 'completed', 2 * H, { goal: 'g-real', gates: [{ name: 'tests', status: 'pass' }], findings: [{ id: 'f-real', message: 'real finding' }] }, [
    { role: 'maker', runtime: 'opencode', status: 'completed', meta: { execution_task_id: 't-a-real', runtime_usage: { total_tokens: 1000 } } },
    { role: 'checker', runtime: 'codex', status: 'completed', meta: { runtime_usage: { total_tokens: 300 } } },
  ]);
  run('r-real2', 'test-gap', 'failed', 3 * H, { gates: [{ name: 'tests', status: 'fail' }] }, [
    { role: 'maker', runtime: 'opencode', status: 'failed', meta: { exit_status: 1, failure: { stage: 'runtime', stderr_class: 'crash' } } },
  ]);
  approve('a-real', 'r-real');
  if (!withSynthetic) return;

  goal('g-syn', 'running', 3 * DAY);
  goal('g-hist', 'running', 3 * DAY);
  run('r-syn', 'repo-maintenance-loop', 'completed', H / 2, { goal: 'g-syn', meta: { synthetic: true, synthetic_reason: 'pr_review' }, findings: [{ id: 'f-syn', message: 'Automated review for PR #7: x' }] }, [
    { role: 'maker', runtime: 'manual', status: 'completed', meta: { execution_task_id: 't-a-syn', synthetic: true } },
    { role: 'checker', runtime: 'codex', status: 'completed', meta: { runtime_usage: { total_tokens: 5000 } } },
  ]);
  run('r-hist', 'repo-maintenance-loop', 'failed', H / 3, { goal: 'g-hist', gates: [{ name: 'pr_gate', status: 'fail' }] }, [
    { role: 'maker', runtime: 'manual', status: 'completed' },
    { role: 'checker', runtime: 'manual', status: 'failed', meta: { failure: { stage: 'runtime', stderr_class: 'gh' } } },
  ]);
  run('r-blk', 'repo-maintenance-loop', 'blocked', H / 4, { meta: { synthetic: true, synthetic_reason: 'pr_review' } }, [
    { role: 'maker', runtime: 'manual', status: 'failed', meta: { failure_reason: 'gh unavailable' } },
  ]);
  approve('a-syn', 'r-syn');
}

async function economy(db: Database.Database) {
  const app = express();
  app.use('/swarms', createSwarmRoutes(db));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/swarms/economy`)).json() as { recent_runs: Array<{ run_id: string }> };
    return body.recent_runs.map((r) => r.run_id);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function prometheus(db: Database.Database) {
  process.env.METRICS_TOKEN = 'kpi-test';
  let text = '';
  const res = { status: () => res, end: () => undefined, set: () => res, send: (b: string) => { text = b; } } as any;
  createMetricsHandler(db)({ headers: { authorization: 'Bearer kpi-test' } } as any, res);
  delete process.env.METRICS_TOKEN;
  return text.split('\n').filter((l) => /^djimitflo_(loop_runs|worker_leases)\{/.test(l)).sort();
}

async function telegramTotals(db: Database.Database) {
  const bot = new TelegramBotService(db) as any;
  let text = '';
  bot.sendMessage = async (_chat: number, t: string) => { text = t; };
  await bot.sendMissionControl(1);
  return text.split('\n').filter((l) => /^Total (loops|leases)/.test(l));
}

const CASES: Array<[string, (db: Database.Database) => unknown]> = [
  ['predictive-analytics patterns (per runtime)', (db) => new PredictiveAnalyticsService(db).analyzePatterns().filter((p) => p.pattern.startsWith('runtime:'))],
  ['predictive-analytics getStats', (db) => new PredictiveAnalyticsService(db).getStats()],
  ['predictive-analytics predict (last 100 runs)', (db) => new PredictiveAnalyticsService(db).predict({ goalType: '', runtime: '', mode: '' }).successProbability],
  ['predictive-analytics checkDataQuality completeness', (db) => { const q = new PredictiveAnalyticsService(db).checkDataQuality(); return [q.failureMetadataCompleteness, q.blockReasonCompleteness]; }],
  ['swarm-status fleetPools (24 h outcomes)', (db) => ((new SwarmStatusService(db) as any).fleetPools({ load_average: [0], total_memory_bytes: 1, free_memory_bytes: 1, cpu_threads: 8 }) as any[])
    .map((p) => [p.runtime, p.completed_24h, p.failed_24h, p.failure_rate_24h, p.tokens_per_successful_worker])],
  ['self-healing loop failure rate', (db) => new SelfHealingService(db).checkHealth().find((c) => c.name === 'loop_failure_rate')!.message],
  ['runtime-health 30 d lease outcomes', (db) => runtimeHealth(db, now).map((r) => [r.runtime, r.leases_30d])],
  // a synthetic review checker's completion is no evidence that the runtime succeeds at loop work
  ['runtime-health last_success_at', (db) => runtimeHealth(db, now).map((r) => [r.runtime, r.last_success_at])],
  ['meta-evolution maker completion rate', (db) => new MetaEvolutionService(db, new SwarmIntelligenceService(db)).evaluate().maker_lease_completion_rate],
  ['swarm-learning-curve runs and cohorts', (db) => { const v = learningCurveView(db, now); return [v.runs.map((r) => r.run_id), v.cohorts.map((c) => [c.loop_name, c.windows.recent.n])]; }],
  ['knowledge-fitness runs in window', (db) => knowledgeFitness(db, now).runs],
  ['Prometheus loop_runs / worker_leases gauges', prometheus],
  ['telegram mission-control totals', telegramTotals],
  ['background health message', (db) => (new BackgroundWorkerService(db) as any).taskHealthCheck()],
  ['background metrics snapshot (loops)', async (db) => /\d+ loops/.exec(await (new BackgroundWorkerService(db) as any).taskMetricsAggregation())?.[0]],
  ['/economy recent runs', economy],
  ['commons-evidence-pack runs and failing gates', (db) => { const p = buildEvidencePack(db); return [p.loop_runs, p.top_failing_gates]; }],
  ['reflection-engine correlateWithOutcomes', (db) => new ReflectionEngine(db).correlateWithOutcomes()],
  ['agi-goal-reasoning loop health', (db) => { const o = new AgiGoalReasoningEngine(db).observe(); return [o.observations[0], o.anomalies]; }],
  ['outcome-attribution failure_capture', (db) => attributionSummary(db, now).failure_capture],
  ['reviewer-independence latest', (db) => new ReviewerIndependenceService(db).latest().map((a) => a.loop_run_id).sort()],
  ['earned-autonomy classes', (db) => earnedAutonomy(db, now).map((c) => c.cls)],
  ['ADQ approval outcomes', (db) => approvalOutcomes(db, iso(now - 30 * DAY)).map((r) => r.id)],
  ['compliance approval coverage', (db) => (new ComplianceAuditService(db) as any).checkApprovalCoverage(iso(now - DAY), iso(now + H))[0].evidence],
  ['funnel hygiene zombieGoals', (db) => new ImprovementFunnelService(db).compute().hygiene.zombieGoals],
  ['stall-watch goals running after their run ended', (db) => detectStalls(db, now).filter((s) => s.subsystem === 'goals').map((s) => s.detail)],
];

describe('synthetic PR-review runs are out of the remaining loop quality / learning aggregates', () => {
  let full: Database.Database;
  let real: Database.Database;
  beforeEach(() => {
    full = new Database(':memory:'); full.exec(schema); runMigrations(full); seed(full, true);
    real = new Database(':memory:'); real.exec(schema); runMigrations(real); seed(real, false);
  });
  afterEach(() => { full.close(); real.close(); });

  it.each(CASES)('%s', async (_name, aggregate) => {
    expect(await aggregate(full)).toEqual(await aggregate(real));
  });
});
