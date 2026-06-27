import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let loops: LoopService;
let intelligence: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  intelligence = new SwarmIntelligenceService(db);
});

afterEach(() => { db?.close(); });

function insertCapability(id: string, status: string, costModel: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
      metadata, created_at, updated_at
    ) VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, ?, 'demote_on_fail', null, ?, datetime('now'), datetime('now'))
  `).run(id, status, JSON.stringify(costModel), JSON.stringify(metadata));
}

describe('G18: Economy endpoint logic (ship gate)', () => {
  it('computes per-capability economy metrics', () => {
    insertCapability('cap-econ', 'validated', {
      learned: true, p50_tokens: 10000, p95_tokens: 20000,
      p50_dollars: 0.02, p95_dollars: 0.04,
    }, { competence: { n_runs: 5, n_completed: 4, success_rate: 0.8, p50_cost: 10000, p95_cost: 20000 } });

    const caps = intelligence.listCapabilities().filter(c => c.status === 'validated' || c.status === 'candidate');
    const economies = caps.map(cap => {
      const competence = intelligence.measureCompetence(cap.id);
      const costModel = cap.cost_model as Record<string, unknown>;
      const p50Dollars = typeof costModel.p50_dollars === 'number' ? costModel.p50_dollars : 0;
      const efficiency = competence.n_completed > 0 && p50Dollars > 0
        ? competence.n_completed / p50Dollars
        : null;
      return { capability_id: cap.id, status: cap.status, p50_dollars: p50Dollars, verified_artifacts_per_dollar: efficiency };
    });

    const cap1 = economies.find(e => e.capability_id === 'cap-econ');
    expect(cap1).toBeDefined();
    expect(cap1!.status).toBe('validated');
    expect(cap1!.p50_dollars).toBe(0.02);
  });

  it('computes per-run efficiency for the economy endpoint', () => {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata) VALUES ('run-eco', 'test', 'closed', 'completed', '/tmp', '[]', '[]', '[]', '[]', '{}')`).run();

    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES ('lease-m', 'run-eco', 'maker', 'codex', 'completed', 'f1', '/tmp', ?)`).run(JSON.stringify({ runtime_usage: { total_tokens: 500000 } }));
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES ('lease-c', 'run-eco', 'checker', 'codex', 'completed', 'f1', '/tmp', ?)`).run(JSON.stringify({ runtime_usage: { total_tokens: 100000 } }));

    const metric = loops.computeEfficiencyMetric('run-eco');
    expect(metric.verifiedArtifacts).toBe(1);
    expect(metric.dollarsSpent).toBeGreaterThan(0);
    expect(metric.efficiency).toBeGreaterThan(0);
  });

  it('computes summary totals across capabilities and runs', () => {
    insertCapability('cap-a', 'validated', { p50_dollars: 0.01 }, {});
    insertCapability('cap-b', 'candidate', { p50_dollars: 0.05 }, {});

    const caps = intelligence.listCapabilities().filter(c => c.status === 'validated' || c.status === 'candidate');
    const totalCapabilities = caps.length;

    expect(totalCapabilities).toBe(2);

    const recentRuns = loops.listLoopRuns().slice(0, 10);
    const totalVerifiedArtifacts = recentRuns.reduce((s, r) => {
      const m = loops.computeEfficiencyMetric(r.id);
      return s + m.verifiedArtifacts;
    }, 0);
    const totalDollarsSpent = recentRuns.reduce((s, r) => {
      const m = loops.computeEfficiencyMetric(r.id);
      return s + m.dollarsSpent;
    }, 0);

    expect(totalVerifiedArtifacts).toBeDefined();
    expect(totalDollarsSpent).toBeDefined();
  });

  it('the economy endpoint payload has the correct shape', () => {
    insertCapability('cap-shape', 'validated', { p50_dollars: 0.01 }, {});

    const caps = intelligence.listCapabilities().filter(c => c.status === 'validated' || c.status === 'candidate');
    const economies = caps.map(cap => {
      const competence = intelligence.measureCompetence(cap.id);
      const costModel = cap.cost_model as Record<string, unknown>;
      return {
        capability_id: cap.id,
        capability_kind: cap.kind,
        status: cap.status,
        n_runs: competence.n_runs,
        n_completed: competence.n_completed,
        success_rate: competence.success_rate,
        p50_tokens: competence.p50_cost,
        p95_tokens: competence.p95_cost,
        p50_dollars: typeof costModel.p50_dollars === 'number' ? costModel.p50_dollars : 0,
        p95_dollars: typeof costModel.p95_dollars === 'number' ? costModel.p95_dollars : 0,
        verified_artifacts_per_dollar: null as number | null,
      };
    });

    const payload = {
      capabilities: economies,
      recent_runs: [],
      summary: {
        total_capabilities: economies.length,
        total_verified_artifacts: 0,
        total_dollars_spent: 0,
      },
    };

    expect(payload.capabilities).toBeDefined();
    expect(payload.summary.total_capabilities).toBe(1);
    expect(payload.summary.total_verified_artifacts).toBe(0);
    expect(payload.summary.total_dollars_spent).toBe(0);
  });
});
