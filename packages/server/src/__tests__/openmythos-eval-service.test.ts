import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';
import { GovernanceGuardService } from '../services/governance-guard-service';

// Mock fetch for Ollama calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenMythosEvalService', () => {
  let db: Database.Database;
  let service: OpenMythosEvalService;
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
    `);

    // Create temp corpus file
    tempDir = join(tmpdir(), `openmythos-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    corpusPath = join(tempDir, 'corpus.jsonl');
    const cases = [
      { id: 'test-001', category: 'injection', subcategory: 'basic', difficulty: 1, prompt: 'Test prompt 1', expected_behavior: 'Refuse', failure_mode: 'compliance', rationale: 'Test' },
      { id: 'test-002', category: 'hierarchy', subcategory: 'authority', difficulty: 2, prompt: 'Test prompt 2', expected_behavior: 'Verify', failure_mode: 'obedience', rationale: 'Test' },
      { id: 'test-003', category: 'tool-scope', subcategory: 'boundaries', difficulty: 3, prompt: 'Test prompt 3', expected_behavior: 'Decline', failure_mode: 'overreach', rationale: 'Test' },
    ];
    writeFileSync(corpusPath, cases.map((c) => JSON.stringify(c)).join('\n'));

    // Override corpus path BEFORE creating service
    process.env.OPENMYTHOS_CORPUS_PATH = corpusPath;
    service = new OpenMythosEvalService(db);
    // Clear cache so it loads from the new path
    (service as any).casesCache = null;

    // Mock Ollama responses
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      // Agent response
      { ok: true, json: async () => ({ response: 'I cannot comply with that request.' }) }
    )
    .mockResolvedValueOnce(
      // Judge response
      { ok: true, json: async () => ({ response: '{"score": 4.5, "rationale": "Correctly refused"}' }) }
    )
    .mockResolvedValueOnce(
      { ok: true, json: async () => ({ response: 'I will verify first.' }) }
    )
    .mockResolvedValueOnce(
      { ok: true, json: async () => ({ response: '{"score": 4.0, "rationale": "Good verification"}' }) }
    )
    .mockResolvedValueOnce(
      { ok: true, json: async () => ({ response: 'I cannot do that.' }) }
    )
    .mockResolvedValueOnce(
      { ok: true, json: async () => ({ response: '{"score": 3.5, "rationale": "Correctly declined"}' }) }
    );
  });

  afterEach(() => {
    db.close();
    delete process.env.OPENMYTHOS_CALIBRATION_REPORT_PATH;
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENMYTHOS_CORPUS_PATH;
    delete process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH;
    vi.restoreAllMocks();
  });

  it('loads cases from corpus file', () => {
    const cases = service.loadCases();
    expect(cases).toHaveLength(3);
    expect(cases[0].category).toBe('injection');
  });

  it('filters cases by category', () => {
    const cases = service.loadCases(['injection']);
    expect(cases).toHaveLength(1);
    expect(cases[0].category).toBe('injection');
  });

  it('runs evaluation and computes scores', async () => {
    const result = await service.runEval('agent-1', undefined, 'test-model');
    expect(result.status).toBe('completed');
    expect(result.totalCases).toBe(3);
    expect(result.overallScore).toBeGreaterThan(0);
    expect(result.categoryScores).toBeDefined();
    expect(mockFetch.mock.calls.every((call) => JSON.parse(call[1].body).model === 'test-model')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM openmythos_case_results WHERE run_id = ?').get(result.id)).toEqual({ count: 3 });
    const stored = db.prepare('SELECT categories_json, metadata FROM openmythos_eval_runs WHERE id = ?').get(result.id) as any;
    expect(JSON.parse(stored.categories_json)).toEqual([]);
    expect(JSON.parse(stored.metadata)).toMatchObject({ subject_model: 'test-model', category_scores: result.categoryScores });
  });

  it('returns null for agent with no evaluations', () => {
    const score = service.getAgentScore('nonexistent');
    expect(score).toBeNull();
  });

  it('returns agent score after evaluation', async () => {
    await service.runEval('agent-1', undefined, 'test-model');
    const score = service.getAgentScore('agent-1');
    expect(score).toBeDefined();
    expect(score?.agentId).toBe('agent-1');
    expect(score?.overallScore).toBeGreaterThan(0);
  });

  it('generates a governance report', async () => {
    await service.runEval('agent-1', undefined, 'test-model');
    const report = service.generateReport('agent-1');
    expect(report.agentId).toBe('agent-1');
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.recommendations).toBeDefined();
  });

  it('requires an explicit, registered, or configured subject model', async () => {
    const configured = process.env.OPENMYTHOS_AGENT_MODEL;
    delete process.env.OPENMYTHOS_AGENT_MODEL;
    await expect(service.runEval('unregistered-agent')).rejects.toThrow('OPENMYTHOS_SUBJECT_MODEL_REQUIRED');
    if (configured) process.env.OPENMYTHOS_AGENT_MODEL = configured;
  });

  it('requests structured JSON from the LLM judge', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: '{"score":5,"rationale":"exact"}' }) });
    const result = await (service as any).judgeWithLlm(
      { id: 'test-001', category: 'injection', subcategory: 'basic', difficulty: 1, expected_behavior: 'Refuse', failure_mode: 'compliance' },
      'I cannot comply.',
    );
    expect(result).toEqual({ score: 5, rationale: 'exact' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).format.required).toEqual(['score', 'rationale']);
  });

  it('scores exact requested cases from the oracle sidecar and persists provenance', async () => {
    const anchorsPath = join(tempDir, 'anchors.json');
    writeFileSync(anchorsPath, JSON.stringify({
      schema_version: 1,
      anchors: [{ case_id: 'test-001', oracle_type: 'refusal_required', rule: {} }],
    }));
    process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = anchorsPath;
    (service as any).anchorsCache = null;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'I cannot comply.' }) });
    const result = await service.runEval('agent-1', undefined, 'test-model', ['test-001']);
    expect(result.totalCases).toBe(1);
    expect(result.results[0]).toMatchObject({ scoringSource: 'oracle', oracleType: 'refusal_required', oraclePass: true, judgeScore: 5 });
    expect(db.prepare('SELECT scoring_source, oracle_type, oracle_pass FROM openmythos_case_results WHERE run_id = ?').get(result.id))
      .toEqual({ scoring_source: 'oracle', oracle_type: 'refusal_required', oracle_pass: 1 });
  });

  it('rejects requested case IDs that are absent from the selected corpus', async () => {
    await expect(service.runEval('agent-1', undefined, 'test-model', ['missing-case']))
      .rejects.toThrow('OPENMYTHOS_CASE_IDS_NOT_FOUND');
  });

  it('rejects duplicate requested case IDs', async () => {
    await expect(service.runEval('agent-1', undefined, 'test-model', ['test-001', 'test-001']))
      .rejects.toThrow('OPENMYTHOS_CASE_IDS_DUPLICATE');
  });

  it('fails closed and persists failed cases when no evaluation completes', async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('provider unavailable'));
    const result = await service.runEval('agent-1', undefined, 'test-model');
    expect(result.status).toBe('failed');
    expect(result.completedCases).toBe(0);
    expect(result.overallScore).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM openmythos_case_results WHERE run_id = ? AND status = ?').get(result.id, 'failed')).toEqual({ count: 3 });
  });
});

describe('GovernanceGuardService', () => {
  let db: Database.Database;
  let guardService: GovernanceGuardService;

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
    `);
    guardService = new GovernanceGuardService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('selects relevant categories for file-write skills', () => {
    const check = (guardService as any).selectCategories({ tools: ['file_write'] });
    expect(check).toContain('tool-scope');
  });

  it('selects relevant categories for external skills', () => {
    const check = (guardService as any).selectCategories({ external: true });
    expect(check).toContain('injection');
  });

  it('selects all categories for autonomous skills', () => {
    const check = (guardService as any).selectCategories({ autonomous: true });
    expect(check).toContain('value-alignment');
    expect(check).toContain('hierarchy');
    expect(check).toContain('temporal-reasoning');
  });

  it('isGovernanceCertified returns false for unevaluated skill', () => {
    expect(guardService.isGovernanceCertified('new-skill')).toBe(false);
  });

  it('getLatestScore returns 0 for unevaluated skill', () => {
    expect(guardService.getLatestScore('new-skill')).toBe(0);
  });

  it('certifies only a matching eligible calibration report', () => {
    const runId = 'calibrated-run';
    db.prepare(`INSERT INTO openmythos_eval_runs
      (id, agent_id, status, total_cases, completed_cases, overall_score, finished_at)
      VALUES (?, ?, 'completed', 1, 1, 4.5, datetime('now'))`).run(runId, 'skill-1');
    const reportPath = join(tmpdir(), `openmythos-calibration-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify({
      run_id: runId, agent_id: 'skill-1', calibrated: true, certification_eligible: true,
      case_result_rows: 1, total_cases: 1,
    }));
    process.env.OPENMYTHOS_CALIBRATION_REPORT_PATH = reportPath;
    expect(guardService.isGovernanceCertified('skill-1')).toBe(true);
    rmSync(reportPath, { force: true });
  });

  it('blocks when evaluation evidence is incomplete', async () => {
    (guardService as any).evalService.runEval = vi.fn().mockResolvedValue({
      id: 'run-1', agentId: 'skill-1', status: 'failed', totalCases: 3, completedCases: 0,
      overallScore: 0, categoryScores: {}, results: [], startedAt: '', finishedAt: '',
    });
    const result = await guardService.runBenchmarkCheck('skill-1', { model: 'test-model' });
    expect(result.blocked).toBe(true);
    expect(result.approved).toBe(false);
  });
});
