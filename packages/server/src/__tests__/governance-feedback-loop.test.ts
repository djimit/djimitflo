import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { GovernanceFeedbackLoopService, type FeedbackLoopConfig } from '../services/governance-feedback-loop';
import { RiskLevel } from '@djimitflo/shared';

describe('GovernanceFeedbackLoopService', () => {
  let db: Database;
  let service: GovernanceFeedbackLoopService;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS openmythos_eval_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        total_cases INTEGER NOT NULL DEFAULT 0,
        categories_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS openmythos_case_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        category TEXT NOT NULL,
        difficulty INTEGER NOT NULL DEFAULT 1,
        response TEXT,
        judge_score REAL DEFAULT 0,
        judge_rationale TEXT,
        scoring_source TEXT NOT NULL DEFAULT 'judge',
        oracle_type TEXT,
        oracle_pass INTEGER,
        latency_ms INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'skipped')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const config: Partial<FeedbackLoopConfig> = {
      min_score_threshold: 3.0,
      max_proposals_per_cycle: 5,
      auto_authorize_below_risk: RiskLevel.MEDIUM,
      require_verification: true,
    };

    service = new GovernanceFeedbackLoopService(db, config);
  });

  afterEach(() => {
    db.close();
  });

  describe('analyzeFailures', () => {
    it('returns empty array when no eval runs exist', () => {
      const failures = service.analyzeFailures('agent-1');
      expect(failures).toEqual([]);
    });

    it('identifies failing cases below threshold', () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, ?, 'completed', 3, '{}', datetime('now'), datetime('now'))
      `).run(runId, 'agent-1');

      const cases = [
        { case_id: 'case-1', category: 'injection', score: 1.5 },
        { case_id: 'case-2', category: 'injection', score: 2.0 },
        { case_id: 'case-3', category: 'hallucination', score: 4.5 },
      ];

      for (const c of cases) {
        db.prepare(`
          INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
          VALUES (?, ?, ?, ?, ?, 'test rationale', 'test', 1, 'completed')
        `).run(`${c.case_id}-id`, runId, c.case_id, c.category, c.score);
      }

      const failures = service.analyzeFailures('agent-1');
      expect(failures.length).toBeGreaterThan(0);

      const injectionFailure = failures.find(f => f.category === 'injection');
      expect(injectionFailure).toBeDefined();
      expect(injectionFailure!.case_ids).toContain('case-1');
      expect(injectionFailure!.case_ids).toContain('case-2');
      expect(injectionFailure!.avg_score).toBeCloseTo(1.75, 1);
    });

    it('sorts failures by severity (critical first)', () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, ?, 'completed', 4, '{}', datetime('now'), datetime('now'))
      `).run(runId, 'agent-1');

      const cases = [
        { case_id: 'c1', category: 'low_risk', score: 2.9 },
        { case_id: 'c2', category: 'critical_risk', score: 0.5 },
        { case_id: 'c3', category: 'high_risk', score: 1.8 },
      ];

      for (const c of cases) {
        db.prepare(`
          INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
          VALUES (?, ?, ?, ?, ?, 'rationale', 'test', 1, 'completed')
        `).run(`${c.case_id}-id`, runId, c.case_id, c.category, c.score);
      }

      const failures = service.analyzeFailures('agent-1');
      expect(failures[0].severity).toBe(RiskLevel.CRITICAL);
      expect(failures[0].category).toBe('critical_risk');
    });

    it('does not include passing cases (score >= threshold)', () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, ?, 'completed', 2, '{}', datetime('now'), datetime('now'))
      `).run(runId, 'agent-1');

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'pass-1', 'quality', 4.5, 'good', 'test', 1, 'completed')
      `).run('pass-1-id', runId);

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'pass-2', 'quality', 3.5, 'ok', 'test', 1, 'completed')
      `).run('pass-2-id', runId);

      const failures = service.analyzeFailures('agent-1');
      expect(failures).toEqual([]);
    });
  });

  describe('createProposals', () => {
    it('creates proposals for each failure category', () => {
      const failures = [
        {
          category: 'injection',
          subcategory: 'prompt_injection',
          severity: RiskLevel.HIGH,
          case_ids: ['c1', 'c2'],
          avg_score: 1.5,
          failure_mode: 'contradictory_behavior',
          recommendation: 'Fix injection governance',
        },
        {
          category: 'hallucination',
          subcategory: 'factual',
          severity: RiskLevel.MEDIUM,
          case_ids: ['c3'],
          avg_score: 2.5,
          failure_mode: 'hallucination',
          recommendation: 'Fix hallucination',
        },
      ];

      const proposals = service.createProposals(failures);
      expect(proposals).toHaveLength(2);
      expect(proposals[0].status).toBe('proposed');
      expect(proposals[0].target_finding_ids).toEqual(['c1', 'c2']);
      expect(proposals[0].proposed_action).toBe('code_fix');
    });

    it('maps policy failures to policy_update action', () => {
      const failures = [{
        category: 'governance_policy',
        subcategory: 'scope',
        severity: RiskLevel.HIGH,
        case_ids: ['c1'],
        avg_score: 2.0,
        failure_mode: 'scope_violation',
        recommendation: 'Update policy',
      }];

      const proposals = service.createProposals(failures);
      expect(proposals[0].proposed_action).toBe('policy_update');
    });

    it('respects max_proposals_per_cycle', () => {
      const failures = Array.from({ length: 10 }, (_, i) => ({
        category: `cat_${i}`,
        subcategory: 'x',
        severity: RiskLevel.MEDIUM,
        case_ids: [`c${i}`],
        avg_score: 2.0,
        failure_mode: 'quality_deficit',
        recommendation: `Fix ${i}`,
      }));

      const proposals = service.createProposals(failures);
      expect(proposals.length).toBeLessThanOrEqual(5);
    });
  });

  describe('authorizeProposals', () => {
    it('auto-authorizes low-risk proposals', () => {
      const proposals = [{
        id: 'p1',
        title: 'Fix injection',
        description: 'Fix it',
        category: 'injection',
        target_finding_ids: ['c1'],
        proposed_action: 'code_fix' as const,
        risk_level: RiskLevel.LOW,
        status: 'proposed' as const,
        decision_id: null,
        created_at: new Date().toISOString(),
      }];

      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      const results = service.authorizeProposals(proposals, principal);
      expect(results[0].proposal.status).toBe('authorized');
      expect(results[0].decision?.decision).toBe('allow');
      expect(results[0].decision?.capability_token).toBeDefined();
    });

    it('requires approval for restricted data', () => {
      const proposals = [{
        id: 'p1',
        title: 'Fix critical',
        description: 'Fix it',
        category: 'injection',
        target_finding_ids: ['c1'],
        proposed_action: 'code_fix' as const,
        risk_level: RiskLevel.CRITICAL,
        status: 'proposed' as const,
        decision_id: null,
        created_at: new Date().toISOString(),
      }];

      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      const results = service.authorizeProposals(proposals, principal);
      expect(results[0].proposal.status).toBe('proposed');
      expect(results[0].decision?.decision).toBe('require_approval');
    });

    it('rejects proposals from viewers', () => {
      const proposals = [{
        id: 'p1',
        title: 'Fix',
        description: 'Fix it',
        category: 'quality',
        target_finding_ids: ['c1'],
        proposed_action: 'code_fix' as const,
        risk_level: RiskLevel.LOW,
        status: 'proposed' as const,
        decision_id: null,
        created_at: new Date().toISOString(),
      }];

      const principal = {
        sub: 'viewer-1',
        email: 'viewer@test.com',
        role: 'viewer',
        iat: 0,
        exp: 0,
      };

      const results = service.authorizeProposals(proposals, principal);
      expect(results[0].proposal.status).toBe('rejected');
      expect(results[0].decision?.decision).toBe('deny');
    });
  });

  describe('runFeedbackLoop', () => {
    it('returns early when no failures detected', async () => {
      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      const result = await service.runFeedbackLoop('agent-no-data', principal);
      expect(result.failures_detected).toBe(0);
      expect(result.proposals_created).toBe(0);
    });

    it('runs full loop when failures exist', async () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, ?, 'completed', 2, '{}', datetime('now'), datetime('now'))
      `).run(runId, 'agent-1');

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'c1', 'injection', 1.0, 'failed', 'test', 0, 'completed')
      `).run('c1-id', runId);

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'c2', 'injection', 1.5, 'failed', 'test', 0, 'completed')
      `).run('c2-id', runId);

      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      const result = await service.runFeedbackLoop('agent-1', principal);
      expect(result.failures_detected).toBeGreaterThan(0);
      expect(result.proposals_created).toBeGreaterThan(0);
      expect(result.loop_id).toMatch(/^gfl-/);
    });
  });

  describe('verifyImprovement', () => {
    it('returns no improvement when no data', () => {
      const result = service.verifyImprovement('agent-1', 'run-baseline');
      expect(result.improved).toBe(false);
      expect(result.delta).toBe(0);
    });

    it('detects score improvement', () => {
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES ('run-baseline', 'agent-1', 'completed', 2, '{}', datetime('now', '-2 hours'), datetime('now', '-1 hour'))
      `).run();

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, 'run-baseline', 'c1', 'injection', 1.0, 'bad', 'test', 0, 'completed')
      `).run('base-c1');

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, 'run-baseline', 'c2', 'injection', 1.5, 'bad', 'test', 0, 'completed')
      `).run('base-c2');

      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES ('run-latest', 'agent-1', 'completed', 2, '{}', datetime('now', '-1 hour'), datetime('now'))
      `).run();

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, 'run-latest', 'c1', 'injection', 3.5, 'good', 'test', 1, 'completed')
      `).run('latest-c1');

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, 'run-latest', 'c2', 'injection', 4.0, 'good', 'test', 1, 'completed')
      `).run('latest-c2');

      const result = service.verifyImprovement('agent-1', 'run-baseline');
      expect(result.improved).toBe(true);
      expect(result.delta).toBeGreaterThan(0);
    });
  });

  describe('getLoopHistory', () => {
    it('returns empty history initially', () => {
      const history = service.getLoopHistory();
      expect(history).toEqual([]);
    });

    it('returns history after loop runs', async () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, 'agent-1', 'completed', 1, '{}', datetime('now'), datetime('now'))
      `).run(runId);

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'c1', 'quality', 1.0, 'bad', 'test', 0, 'completed')
      `).run('c1-hist', runId);

      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      await service.runFeedbackLoop('agent-1', principal);

      const history = service.getLoopHistory();
      expect(history.length).toBe(1);
      expect(history[0].failures_detected).toBeGreaterThan(0);
    });
  });

  describe('detectDormantCapabilities', () => {
  it('returns empty when detection disabled', () => {
    const serviceDisabled = new GovernanceFeedbackLoopService(db, {
      enable_dormant_capability_detection: false,
    });
    const result = serviceDisabled.detectDormantCapabilities();
    expect(result).toEqual([]);
  });

  it('returns empty when no capabilities exist', () => {
    const dormant = service.detectDormantCapabilities();
    expect(dormant).toEqual([]);
  });

  it('detects never-used capabilities', () => {
    db.prepare(`
      INSERT INTO swarm_capabilities (id, owner, kind, version, status, risk_ceiling, input_schema_ref, output_schema_ref, removal_strategy)
      VALUES ('cap-1', 'test-owner', 'skill', '1.0.0', 'candidate', 'low', '', '', 'manual_review')
    `).run();

    const dormant = service.detectDormantCapabilities();
    expect(dormant.length).toBe(1);
    expect(dormant[0].capability_id).toBe('cap-1');
    expect(dormant[0].last_used_at).toBeNull();
    expect(dormant[0].recommendation).toContain('candidate status');
  });

  it('does not flag validated/recently-used capabilities', () => {
    db.prepare(`
      INSERT INTO swarm_capabilities (id, owner, kind, version, status, risk_ceiling, input_schema_ref, output_schema_ref, removal_strategy)
      VALUES ('cap-3', 'test-owner', 'skill', '1.0.0', 'validated', 'low', '', '', 'manual_review')
    `).run();

    const dormant = service.detectDormantCapabilities();
    expect(dormant).toEqual([]);
  });
});

describe('getProposalsByStatus', () => {
    it('returns proposals filtered by status', async () => {
      const runId = 'run-1';
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, metadata, started_at, finished_at)
        VALUES (?, 'agent-1', 'completed', 1, '{}', datetime('now'), datetime('now'))
      `).run(runId);

      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, judge_score, judge_rationale, oracle_type, oracle_pass, status)
        VALUES (?, ?, 'c1', 'quality', 1.0, 'bad', 'test', 0, 'completed')
      `).run('c1-prop', runId);

      const principal = {
        sub: 'admin-1',
        email: 'admin@test.com',
        role: 'admin',
        iat: 0,
        exp: 0,
      };

      await service.runFeedbackLoop('agent-1', principal);

      const authorized = service.getProposalsByStatus('proposed');
      expect(authorized.length).toBeGreaterThan(0);
    });
  });
});
