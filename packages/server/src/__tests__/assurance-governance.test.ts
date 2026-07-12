import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentAssuranceService } from '../services/agent-assurance-service';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AgentAssuranceService Governance', () => {
  let db: Database.Database;
  let service: AgentAssuranceService;
  let tempDir: string;
  let corpusPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE openmythos_eval_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        total_cases INTEGER DEFAULT 0, completed_cases INTEGER DEFAULT 0, overall_score REAL DEFAULT 0,
        status TEXT DEFAULT 'pending', categories_json TEXT DEFAULT '[]',
        judge_model TEXT DEFAULT 'qwen2.5:14b', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE openmythos_case_results (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL, category TEXT NOT NULL,
        difficulty INTEGER DEFAULT 1, response TEXT, judge_score REAL DEFAULT 0,
        judge_rationale TEXT, scoring_source TEXT DEFAULT 'judge', oracle_type TEXT, oracle_pass INTEGER,
        latency_ms INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (run_id) REFERENCES openmythos_eval_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE agent_eval_runs (
        id TEXT PRIMARY KEY, suite_name TEXT NOT NULL, target_type TEXT NOT NULL,
        target_ref TEXT, status TEXT NOT NULL, score REAL NOT NULL,
        scorecard_json TEXT DEFAULT '{}', findings_json TEXT DEFAULT '[]',
        source TEXT DEFAULT 'internal', benchmark_version TEXT, judge_model TEXT,
        metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    tempDir = join(tmpdir(), `assurance-gov-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    corpusPath = join(tempDir, 'corpus.jsonl');
    const cases = [
      { id: 'gov-001', category: 'injection', subcategory: 'basic', difficulty: 1, prompt: 'Test', expected_behavior: 'Refuse', failure_mode: 'compliance', rationale: 'Test' },
      { id: 'gov-002', category: 'hierarchy', subcategory: 'authority', difficulty: 2, prompt: 'Test', expected_behavior: 'Verify', failure_mode: 'obedience', rationale: 'Test' },
    ];
    writeFileSync(corpusPath, cases.map((c) => JSON.stringify(c)).join('\n'));
    process.env.OPENMYTHOS_CORPUS_PATH = corpusPath;

    service = new AgentAssuranceService(db);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'I cannot comply.' }) });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: '{"score": 4.0, "rationale": "Good"}' }) });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENMYTHOS_CORPUS_PATH;
    vi.restoreAllMocks();
  });

  it('runGovernanceEval stores result with openmythos_benchmark source', async () => {
    const result = await service.runGovernanceEval('agent-1', undefined, 'test-model');
    expect(result.evalId).toBeDefined();
    expect(result.overallScore).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM agent_eval_runs WHERE source = 'openmythos_benchmark'").get() as any;
    expect(row).toBeDefined();
    expect(row.suite_name).toBe('openmythos-governance');
  });

  it('getGovernanceTrend returns historical scores', async () => {
    await service.runGovernanceEval('agent-1', undefined, 'test-model');
    const trend = service.getGovernanceTrend('agent-1');
    expect(trend.length).toBeGreaterThan(0);
    expect(trend[0].score).toBeGreaterThan(0);
  });

  it('checkGovernanceDegradation detects score drops', async () => {
    // Insert a high previous score (older)
    db.prepare(`
      INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, source, created_at)
      VALUES ('prev-high', 'openmythos-governance', 'capability', 'agent-1', 'passed', 0.9, 'openmythos_benchmark', datetime('now', '-2 hours'))
    `).run();

    // Insert a lower recent score (newer)
    db.prepare(`
      INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, source, created_at)
      VALUES ('recent-low', 'openmythos-governance', 'capability', 'agent-1', 'failed', 0.2, 'openmythos_benchmark', datetime('now', '-1 hour'))
    `).run();

    const degradation = service.checkGovernanceDegradation('agent-1', 0.5);
    expect(degradation.degraded).toBe(true);
    expect(degradation.drop).toBeGreaterThan(0.5);
  });

  it('generateGovernanceReport returns structured report', async () => {
    await service.runGovernanceEval('agent-1', undefined, 'test-model');
    const report = await service.generateGovernanceReport('agent-1');
    expect(report.agentId).toBe('agent-1');
    expect(report.status).toMatch(/pass|warn|fail/);
    expect(report.recommendations).toBeDefined();
  });
});
