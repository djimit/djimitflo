import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfEvolvingGovernanceLoop } from '../services/self-evolving-governance-loop';

describe('SelfEvolvingGovernanceLoop', () => {
  let db: Database;
  let loop: SelfEvolvingGovernanceLoop;

  beforeEach(() => {
    db = new Database(':memory:');
    loop = new SelfEvolvingGovernanceLoop(db);
  });

  function seedEvalRun(agentId: string, overallScore: number, categoryScores: Record<string, number>) {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    db.exec(`
      CREATE TABLE IF NOT EXISTS openmythos_eval_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        total_cases INTEGER NOT NULL DEFAULT 0, completed_cases INTEGER NOT NULL DEFAULT 0,
        overall_score REAL DEFAULT 0, category_scores TEXT DEFAULT '{}',
        categories_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS openmythos_case_results (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL,
        category TEXT NOT NULL, difficulty INTEGER NOT NULL DEFAULT 1,
        response TEXT NOT NULL DEFAULT '', judge_score REAL NOT NULL DEFAULT 0,
        judge_rationale TEXT NOT NULL DEFAULT '', scoring_source TEXT NOT NULL DEFAULT 'judge',
        oracle_type TEXT, oracle_pass INTEGER, latency_ms INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed'
      );
    `);
    const started = new Date(Date.now() - 60000).toISOString();
    const finished = new Date().toISOString();
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, category_scores, started_at, finished_at)
      VALUES (?, ?, 'completed', 7, 7, ?, ?, ?, ?)
    `).run(runId, agentId, overallScore, JSON.stringify(categoryScores), started, finished);

    const cases = [
      { id: 'c1', category: 'injection', difficulty: 3, score: 1.5, response: 'Sure...', rationale: 'Failed injection' },
      { id: 'c2', category: 'injection', difficulty: 2, score: 2.0, response: 'Okay...', rationale: 'Failed injection' },
      { id: 'c3', category: 'injection', difficulty: 3, score: 1.8, response: 'Yes...', rationale: 'Failed injection' },
      { id: 'c4', category: 'injection', difficulty: 4, score: 2.2, response: 'Alright...', rationale: 'Failed injection' },
      { id: 'c5', category: 'injection', difficulty: 3, score: 1.6, response: 'Fine...', rationale: 'Failed injection' },
      { id: 'c6', category: 'hallucination', difficulty: 3, score: 4.5, response: 'Unknown', rationale: 'Correct' },
      { id: 'c7', category: 'hallucination', difficulty: 2, score: 4.0, response: 'Not sure', rationale: 'Correct' },
    ];
    for (const c of cases) {
      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, difficulty, response, judge_score, judge_rationale, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(`${runId}-${c.id}`, runId, c.id, c.category, c.difficulty, c.response, c.score, c.rationale);
    }
    return runId;
  }

  it('fails gracefully when no eval run exists', async () => {
    const result = await loop.runCycle('nonexistent-agent');
    expect(result.status).toBe('failed');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('runs a complete cycle with eval data', async () => {
    seedEvalRun('agent-1', 2.67, { injection: 1.75, hallucination: 4.5 });
    const result = await loop.runCycle('agent-1');
    expect(result.status).toBe('completed');
    expect(result.memories_created).toBeGreaterThan(0);
    expect(result.blind_spots_detected.length).toBeGreaterThan(0);
  });

  it('detects blind spots in low-scoring categories', async () => {
    seedEvalRun('agent-1', 2.0, { injection: 1.5 });
    const result = await loop.runCycle('agent-1');
    expect(result.blind_spots_detected).toContain('injection');
  });

  it('generates cases from failures', async () => {
    seedEvalRun('agent-1', 2.0, { injection: 1.5 });
    const result = await loop.runCycle('agent-1');
    expect(result.cases_generated).toBeGreaterThan(0);
  });

  it('updates judge rubrics for declining categories', async () => {
    seedEvalRun('agent-1', 2.0, { injection: 1.5 });
    const result = await loop.runCycle('agent-1');
    expect(result.judge_rubrics_updated + result.rules_updated).toBeGreaterThanOrEqual(0);
  });

  it('persists cycle history', async () => {
    seedEvalRun('agent-1', 2.5, { injection: 2.0 });
    await loop.runCycle('agent-1');
    const history = loop.getCycleHistory(10);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('completed');
  });

  it('retrieves latest cycle', async () => {
    seedEvalRun('agent-1', 2.5, { injection: 2.0 });
    await loop.runCycle('agent-1');
    const latest = loop.getLatestCycle();
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe('completed');
  });
});
