import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { LoopBudgetService, type LoopBudgetDataAccess } from '../services/loop-budget-service';
import type { LoopRunRecord, WorkerLeaseRecord } from '../services/loop-service';
import { swarmEventBus } from '../services/swarm-event-bus';

describe('LoopBudgetService', () => {
  let db: Database.Database;
  let dataAccess: LoopBudgetDataAccess;
  let service: LoopBudgetService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        budget_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'created',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE loop_runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        loop_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'closed',
        status TEXT NOT NULL DEFAULT 'created',
        repository_path TEXT,
        state_file TEXT,
        findings_json TEXT DEFAULT '[]',
        plan_json TEXT DEFAULT '{}',
        gates_json TEXT DEFAULT '[]',
        next_actions_json TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE worker_leases (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'codex',
        status TEXT NOT NULL DEFAULT 'prepared',
        finding_id TEXT,
        worktree_path TEXT,
        metadata TEXT DEFAULT '{}',
        budget_json TEXT DEFAULT '{}',
        capability_id TEXT,
        parent_lease_id TEXT,
        spawn_tree_id TEXT,
        depth INTEGER DEFAULT 0,
        spawned_by_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE loop_events (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        metadata_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);

    dataAccess = {
      getGoal: (id: string) => {
        const row = db.prepare('SELECT id, budget_json FROM goals WHERE id = ?').get(id) as { id: string; budget_json: string } | undefined;
        return row ? { id: row.id, budget: JSON.parse(row.budget_json) } : undefined as unknown as { id: string; budget: Record<string, unknown> };
      },
      getLoopRun: (id: string) => {
        const row = db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) throw new Error('LOOP_RUN_NOT_FOUND');
        return {
          ...row,
          metadata: JSON.parse((row.metadata_json as string) || '{}'),
          findings: JSON.parse((row.findings_json as string) || '[]'),
          gates: JSON.parse((row.gates_json as string) || '[]'),
        } as unknown as LoopRunRecord;
      },
      listWorkerLeases: (runId: string) => {
        return (db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ?').all(runId) as Record<string, unknown>[]).map((row) => ({
          ...row,
          metadata: JSON.parse((row.metadata as string) || '{}'),
          budget: JSON.parse((row.budget_json as string) || '{}'),
        })) as unknown as WorkerLeaseRecord[];
      },
      recordLoopEvent: () => { /* no-op in tests */ },
    };

    service = new LoopBudgetService(db, dataAccess);
  });

  afterEach(() => {
    db.close();
    swarmEventBus.removeAllListeners();
  });

  describe('computeDollarCost', () => {
    it('computes cost for codex at $2/Mtok', () => {
      expect(service.computeDollarCost('codex', 1_000_000)).toBe(2.0);
      expect(service.computeDollarCost('codex', 500_000)).toBe(1.0);
    });

    it('computes cost for claude at $3/Mtok', () => {
      expect(service.computeDollarCost('claude', 1_000_000)).toBe(3.0);
    });

    it('computes cost for opencode at $0.5/Mtok', () => {
      expect(service.computeDollarCost('opencode', 1_000_000)).toBe(0.5);
    });

    it('returns zero for free runtimes', () => {
      expect(service.computeDollarCost('mock', 1_000_000)).toBe(0);
      expect(service.computeDollarCost('editor', 1_000_000)).toBe(0);
      expect(service.computeDollarCost('pi', 1_000_000)).toBe(0);
    });

    it('defaults unknown runtimes to $2/Mtok', () => {
      expect(service.computeDollarCost('unknown-runtime', 1_000_000)).toBe(2.0);
    });

    it('handles zero tokens', () => {
      expect(service.computeDollarCost('codex', 0)).toBe(0);
    });
  });

  describe('allocateDollarBudget', () => {
    it('allocates findings by competence-to-cost ratio', () => {
      const findings = [
        { finding_id: 'f1', capability_id: 'c1', p50_dollars: 1, competence: 0.9 },
        { finding_id: 'f2', capability_id: 'c2', p50_dollars: 2, competence: 0.5 },
        { finding_id: 'f3', capability_id: 'c3', p50_dollars: 0.5, competence: 0.8 },
      ];
      const result = service.allocateDollarBudget(findings, 2);
      // f3 has best ratio (0.8/0.5=1.6), then f1 (0.9/1=0.9), then f2 (0.5/2=0.25)
      expect(result.allocated).toContain('f3');
      expect(result.allocated).toContain('f1');
      expect(result.deferred).toContain('f2');
    });

    it('returns empty for empty findings', () => {
      const result = service.allocateDollarBudget([], 10);
      expect(result.allocated).toEqual([]);
      expect(result.deferred).toEqual([]);
      expect(result.budgetInsufficient).toBe(false);
    });

    it('marks budgetInsufficient when nothing fits', () => {
      const findings = [
        { finding_id: 'f1', capability_id: 'c1', p50_dollars: 100, competence: 0.9 },
      ];
      const result = service.allocateDollarBudget(findings, 1);
      expect(result.allocated).toEqual([]);
      expect(result.budgetInsufficient).toBe(true);
    });
  });

  describe('computeEfficiencyMetric', () => {
    it('returns zero for run with no leases', () => {
      const result = service.computeEfficiencyMetric('nonexistent');
      expect(result.verifiedArtifacts).toBe(0);
      expect(result.dollarsSpent).toBe(0);
      expect(result.efficiency).toBe(0);
    });

    it('computes efficiency from completed maker leases', () => {
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'test', 'closed', 'completed', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l1', 'r1', 'maker', 'mock', 'completed', '{"runtime_usage":{"total_tokens":1000},"runtime":"mock"}', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l2', 'r1', 'maker', 'mock', 'completed', '{"runtime_usage":{"total_tokens":2000},"runtime":"mock"}', datetime('now'), datetime('now'))`).run();

      const result = service.computeEfficiencyMetric('r1');
      expect(result.verifiedArtifacts).toBe(2);
      expect(result.dollarsSpent).toBe(0); // mock is free
      expect(result.efficiency).toBe(0);
    });
  });

  describe('adjustConcurrency', () => {
    it('increases concurrency limit', () => {
      delete process.env.RUNTIME_MAX_CONCURRENCY;
      const result = service.adjustConcurrency(true);
      expect(result.success).toBe(true);
      expect(result.dynamicLimit).toBe(6); // default 5 + 1
    });

    it('decreases concurrency limit with floor of 1', () => {
      process.env.RUNTIME_MAX_CONCURRENCY = '1';
      const result = service.adjustConcurrency(false);
      expect(result.dynamicLimit).toBe(1);
      delete process.env.RUNTIME_MAX_CONCURRENCY;
    });

    it('emits aimd_state event on the swarm event bus', () => {
      const events: unknown[] = [];
      swarmEventBus.subscribe((e) => events.push(e));
      service.adjustConcurrency(true);
      expect(events).toHaveLength(1);
      expect((events[0] as { type: string }).type).toBe('aimd_state');
      swarmEventBus.removeAllListeners();
    });

    it('reports active and queue depth', () => {
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l1', 'r1', 'maker', 'mock', 'running', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l2', 'r1', 'checker', 'mock', 'prepared', datetime('now'), datetime('now'))`).run();

      const result = service.adjustConcurrency(true);
      expect(result.active).toBe(1);
      expect(result.queueDepth).toBe(1);
    });
  });

  describe('getMakerLeaseBudget', () => {
    it('returns goal budget when goal exists', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_maker_workers":3}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.getMakerLeaseBudget(run);
      expect(result.maxMakerWorkers).toBe(3);
      expect(result.source).toBe('goal');
    });

    it('falls back to request budget', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getMakerLeaseBudget(run, 7);
      expect(result.maxMakerWorkers).toBe(7);
      expect(result.source).toBe('request');
    });

    it('defaults to 5 when no goal or request', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getMakerLeaseBudget(run);
      expect(result.maxMakerWorkers).toBe(5);
      expect(result.source).toBe('default');
    });

    it('caps at 100 workers', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getMakerLeaseBudget(run, 200);
      expect(result.maxMakerWorkers).toBe(100);
    });
  });

  describe('getRetryBudget', () => {
    it('returns goal retry budget', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_retries":5}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const maker = { budget: {} } as WorkerLeaseRecord;
      const result = service.getRetryBudget(run, maker);
      expect(result.maxRetries).toBe(5);
      expect(result.source).toBe('goal');
    });

    it('falls back to lease budget', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const maker = { budget: { max_retries: 3 } } as WorkerLeaseRecord;
      const result = service.getRetryBudget(run, maker);
      expect(result.maxRetries).toBe(3);
      expect(result.source).toBe('lease');
    });

    it('defaults to 1 retry', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const maker = { budget: {} } as WorkerLeaseRecord;
      const result = service.getRetryBudget(run, maker);
      expect(result.maxRetries).toBe(1);
      expect(result.source).toBe('default');
    });
  });

  describe('getFailureThreshold', () => {
    it('returns goal threshold', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_failure_count":7}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.getFailureThreshold(run);
      expect(result.maxFailureCount).toBe(7);
      expect(result.source).toBe('goal');
    });

    it('defaults to 3', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getFailureThreshold(run);
      expect(result.maxFailureCount).toBe(3);
      expect(result.source).toBe('default');
    });
  });

  describe('getTokenBudget', () => {
    it('returns none for run without goal', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getTokenBudget(run);
      expect(result.source).toBe('none');
      expect(result.maxTokens).toBeUndefined();
    });

    it('parses token budget from goal', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens":10000,"max_tokens_per_worker":5000,"max_tokens_per_diff_line":100}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.getTokenBudget(run);
      expect(result.maxTokens).toBe(10000);
      expect(result.maxTokensPerWorker).toBe(5000);
      expect(result.maxTokensPerDiffLine).toBe(100);
      expect(result.source).toBe('goal');
    });
  });

  describe('getWallClockBudget', () => {
    it('returns none for run without goal', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.getWallClockBudget(run);
      expect(result.source).toBe('none');
    });

    it('parses wall clock budget from goal', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_runtime_ms":3600000}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.getWallClockBudget(run);
      expect(result.maxRuntimeMs).toBe(3600000);
      expect(result.source).toBe('goal');
    });
  });

  describe('evaluateTokenBudget', () => {
    it('skips when no budget configured', () => {
      const run = { id: 'r1', goal_id: null } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, null, 'lease-1');
      expect(result.gate.status).toBe('skipped');
      expect(result.exhausted).toBe(false);
    });

    it('skips when no runtime usage reported', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens":10000}', 'created', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, null, 'lease-1');
      expect(result.gate.status).toBe('skipped');
    });

    it('passes when under budget', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens":10000}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, { total_tokens: 5000 }, 'lease-1');
      expect(result.gate.status).toBe('pass');
      expect(result.exhausted).toBe(false);
    });

    it('fails when over total budget', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens":1000}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, { total_tokens: 1500 }, 'lease-1');
      expect(result.gate.status).toBe('fail');
      expect(result.exhausted).toBe(true);
    });

    it('fails when per-worker budget exceeded', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens_per_worker":100}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, { total_tokens: 200 }, 'lease-1');
      expect(result.gate.status).toBe('fail');
      expect(result.exhausted).toBe(true);
    });

    it('detects efficiency exceeded per diff line', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_tokens":10000,"max_tokens_per_diff_line":100}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      const run = { id: 'r1', goal_id: 'g1' } as LoopRunRecord;
      const result = service.evaluateTokenBudget(run, { total_tokens: 500 }, 'lease-1', 2);
      expect(result.efficiencyExceeded).toBe(true); // 500/2 = 250 > 100
    });
  });

  describe('sumRuntimeTokens', () => {
    it('sums tokens from lease metadata', () => {
      const leases = [
        { metadata: { runtime_usage: { total_tokens: 1000 } } },
        { metadata: { runtime_usage: { total_tokens: 2000 } } },
        { metadata: {} },
      ] as unknown as WorkerLeaseRecord[];
      expect(service.sumRuntimeTokens(leases)).toBe(3000);
    });

    it('handles empty array', () => {
      expect(service.sumRuntimeTokens([])).toBe(0);
    });

    it('ignores invalid token values', () => {
      const leases = [
        { metadata: { runtime_usage: { total_tokens: 'invalid' } } },
        { metadata: { runtime_usage: { total_tokens: -100 } } },
        { metadata: { runtime_usage: { total_tokens: 500 } } },
      ] as unknown as WorkerLeaseRecord[];
      expect(service.sumRuntimeTokens(leases)).toBe(500);
    });
  });

  describe('countLoopFailures', () => {
    it('counts maker failures', () => {
      const leases = [
        { role: 'maker', status: 'failed', metadata: {} },
        { role: 'maker', status: 'completed', metadata: {} },
        { role: 'maker', status: 'failed', metadata: {} },
      ] as unknown as WorkerLeaseRecord[];
      expect(service.countLoopFailures(leases)).toBe(2);
    });

    it('counts checker verdict failures', () => {
      const leases = [
        { role: 'checker', status: 'completed', metadata: { verdict: 'needs_revision' } },
        { role: 'security_checker', status: 'completed', metadata: { verdict: 'rejected' } },
        { role: 'checker', status: 'completed', metadata: { verdict: 'accepted' } },
      ] as unknown as WorkerLeaseRecord[];
      expect(service.countLoopFailures(leases)).toBe(2);
    });

    it('returns zero for no failures', () => {
      const leases = [
        { role: 'maker', status: 'completed', metadata: {} },
      ] as unknown as WorkerLeaseRecord[];
      expect(service.countLoopFailures(leases)).toBe(0);
    });
  });

  describe('escalateIfFailureThresholdExceeded', () => {
    it('does not escalate when under threshold', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_failure_count":5}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l1', 'r1', 'maker', 'mock', 'failed', datetime('now'), datetime('now'))`).run();

      const result = service.escalateIfFailureThresholdExceeded('r1', 'test');
      expect(result.status).toBe('running');
    });

    it('escalates when failure threshold exceeded', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_failure_count":2}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'running', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l1', 'r1', 'maker', 'mock', 'failed', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l2', 'r1', 'maker', 'mock', 'failed', datetime('now'), datetime('now'))`).run();

      const result = service.escalateIfFailureThresholdExceeded('r1', 'test');
      expect(result.status).toBe('escalated');
    });

    it('does not re-escalate already escalated runs', () => {
      db.prepare(`INSERT INTO goals (id, objective, budget_json, status, created_at, updated_at) VALUES ('g1', 'test', '{"max_failure_count":1}', 'created', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'g1', 'test', 'closed', 'escalated', datetime('now'), datetime('now'))`).run();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l1', 'r1', 'maker', 'mock', 'failed', datetime('now'), datetime('now'))`).run();

      const recordEventSpy = vi.spyOn(dataAccess, 'recordLoopEvent');
      const result = service.escalateIfFailureThresholdExceeded('r1', 'test');
      expect(result.status).toBe('escalated');
      expect(recordEventSpy).not.toHaveBeenCalled();
      recordEventSpy.mockRestore();
    });
  });
});
