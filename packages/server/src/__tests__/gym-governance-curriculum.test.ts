import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GymGovernanceCurriculum } from '../services/gym-governance-curriculum';
import { SkillEvolutionGym } from '../services/skill-evolution-gym';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('GymGovernanceCurriculum', () => {
  let db: Database.Database;
  let curriculum: GymGovernanceCurriculum;
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
      CREATE TABLE gym_evaluations (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, score REAL NOT NULL,
        metrics_json TEXT NOT NULL, eval_type TEXT DEFAULT 'functional',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    tempDir = join(tmpdir(), `gym-gov-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    corpusPath = join(tempDir, 'corpus.jsonl');
    const cases = [
      { id: 'g-001', category: 'overthinking', subcategory: 'basic', difficulty: 1, prompt: 'Test', expected_behavior: 'Be concise', failure_mode: 'verbose', rationale: 'Test' },
      { id: 'g-002', category: 'contradiction', subcategory: 'basic', difficulty: 2, prompt: 'Test', expected_behavior: 'Be consistent', failure_mode: 'contradict', rationale: 'Test' },
      { id: 'g-003', category: 'canary', subcategory: 'detection', difficulty: 1, prompt: 'Test', expected_behavior: 'Detect', failure_mode: 'miss', rationale: 'Test' },
    ];
    writeFileSync(corpusPath, cases.map((c) => JSON.stringify(c)).join('\n'));
    process.env.OPENMYTHOS_CORPUS_PATH = corpusPath;

    curriculum = new GymGovernanceCurriculum(db);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'Good response' }) });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: '{"score": 4.0, "rationale": "Good"}' }) });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENMYTHOS_CORPUS_PATH;
    vi.restoreAllMocks();
  });

  it('returns curriculum phases for simple skills', () => {
    const phases = curriculum.getCurriculumForSkill({ complexity: 'simple' });
    expect(phases.length).toBe(2); // Phases 1-2
  });

  it('returns all phases for autonomous skills', () => {
    const phases = curriculum.getCurriculumForSkill({ complexity: 'autonomous' });
    expect(phases.length).toBe(4); // All phases
  });

  it('returns all phases for high-risk skills', () => {
    const phases = curriculum.getCurriculumForSkill({ complexity: 'simple', risk_class: 'high' });
    expect(phases.length).toBe(4); // All phases regardless of complexity
  });

  it('runs phase evaluation', async () => {
    const result = await curriculum.runPhaseEvaluation('skill-1', 1, 'test-model');
    expect(result.skillId).toBe('skill-1');
    expect(result.phase).toBe(1);
    expect(result.overallScore).toBeGreaterThan(0);
    expect(typeof result.passed).toBe('boolean');
  });

  it('runs full curriculum', async () => {
    const result = await curriculum.runFullCurriculum({ id: 'skill-1', complexity: 'simple', model: 'test-model' });
    expect(result.skillId).toBe('skill-1');
    expect(result.results.length).toBeGreaterThan(0);
    expect(typeof result.certified).toBe('boolean');
  });

  it('gets skill status', async () => {
    await curriculum.runPhaseEvaluation('skill-1', 1, 'test-model');
    // Force store certification by running full curriculum
    await curriculum.runFullCurriculum({ id: 'skill-1', complexity: 'autonomous', model: 'test-model' });
    const status = curriculum.getSkillStatus('skill-1');
    expect(status.skillId).toBe('skill-1');
    expect(status.currentPhase).toBeGreaterThanOrEqual(1);
  });

  it('retests skill', async () => {
    const result = await curriculum.retestSkill({ id: 'skill-1', complexity: 'simple', model: 'test-model' });
    expect(result.skillId).toBe('skill-1');
    expect(typeof result.stillCertified).toBe('boolean');
    expect(typeof result.previousStatus).toBe('boolean');
  });
});

describe('SkillEvolutionGym Governance', () => {
  let db: Database.Database;
  let gym: SkillEvolutionGym;
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
      CREATE TABLE gym_evaluations (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, score REAL NOT NULL,
        metrics_json TEXT NOT NULL, eval_type TEXT DEFAULT 'functional',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    tempDir = join(tmpdir(), `gym-gov-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    corpusPath = join(tempDir, 'corpus.jsonl');
    const cases = [
      { id: 'g-001', category: 'injection', subcategory: 'basic', difficulty: 1, prompt: 'Test', expected_behavior: 'Refuse', failure_mode: 'comply', rationale: 'Test' },
    ];
    writeFileSync(corpusPath, cases.map((c) => JSON.stringify(c)).join('\n'));
    process.env.OPENMYTHOS_CORPUS_PATH = corpusPath;

    gym = new SkillEvolutionGym(db);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'Good' }) });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: '{"score": 4.5, "rationale": "Good"}' }) });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENMYTHOS_CORPUS_PATH;
    vi.restoreAllMocks();
  });

  it('runGovernanceEvaluation stores result with governance type', async () => {
    const result = await gym.runGovernanceEvaluation('skill-1', undefined, 'test-model');
    expect(result.score).toBeGreaterThan(0);
    expect(typeof result.passed).toBe('boolean');

    const row = db.prepare("SELECT * FROM gym_evaluations WHERE eval_type = 'governance_benchmark'").get() as any;
    expect(row).toBeDefined();
  });

  it('getGovernanceHistory returns historical scores', async () => {
    await gym.runGovernanceEvaluation('skill-1', undefined, 'test-model');
    const history = gym.getGovernanceHistory('skill-1');
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].score).toBeGreaterThan(0);
  });
});
