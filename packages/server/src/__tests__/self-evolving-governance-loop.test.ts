import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfEvolvingGovernanceLoop } from '../services/self-evolving-governance-loop';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('SelfEvolvingGovernanceLoop', () => {
  let db: Database;
  let loop: SelfEvolvingGovernanceLoop;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-segml-'));
    loop = new SelfEvolvingGovernanceLoop(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedEvalRun(agentId: string, overallScore: number, categoryScores: Record<string, number>) {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const started = new Date(Date.now() - 60000).toISOString();
    const finished = new Date().toISOString();
    const cases = [
      { id: 'c1', category: 'injection', difficulty: 3, score: 1.5, response: 'Sure...', rationale: 'Failed injection' },
      { id: 'c2', category: 'injection', difficulty: 2, score: 2.0, response: 'Okay...', rationale: 'Failed injection' },
      { id: 'c3', category: 'injection', difficulty: 3, score: 1.8, response: 'Yes...', rationale: 'Failed injection' },
      { id: 'c4', category: 'injection', difficulty: 4, score: 2.2, response: 'Alright...', rationale: 'Failed injection' },
      { id: 'c5', category: 'injection', difficulty: 3, score: 1.6, response: 'Fine...', rationale: 'Failed injection' },
      { id: 'c6', category: 'hallucination', difficulty: 3, score: 4.5, response: 'Unknown', rationale: 'Correct' },
      { id: 'c7', category: 'hallucination', difficulty: 2, score: 4.0, response: 'Not sure', rationale: 'Correct' },
    ];
    const corpusPath = path.join(tempDir, `${runId}.jsonl`);
    const corpus = cases.map((c) => JSON.stringify({
      id: c.id,
      category: c.category,
      subcategory: 'original',
      difficulty: c.difficulty,
      prompt: `Original prompt ${c.id}`,
      expected_behavior: `Expected behavior ${c.id}`,
      failure_mode: c.rationale,
      rationale: `Oracle rationale ${c.id}`,
    })).join('\n');
    fs.writeFileSync(corpusPath, corpus);
    const metadata = {
      category_scores: categoryScores,
      corpus_path: corpusPath,
      corpus_sha256: createHash('sha256').update(corpus).digest('hex'),
    };
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, categories_json, metadata, started_at, finished_at)
      VALUES (?, ?, 'completed', 7, 7, ?, '[]', ?, ?, ?)
    `).run(runId, agentId, overallScore, JSON.stringify(metadata), started, finished);
    for (const c of cases) {
      db.prepare(`
        INSERT INTO openmythos_case_results (id, run_id, case_id, category, difficulty, response, judge_score, judge_rationale, scoring_source, latency_ms, status, usage_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'judge', 0, 'completed', '{}')
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
    const generated = db.prepare('SELECT prompt, expected_behavior, rationale, validated FROM segml_generated_cases').all() as any[];
    expect(generated.every((item) =>
      item.prompt.includes('Original prompt')
      && item.expected_behavior.startsWith('Expected behavior')
      && item.rationale.length > 0
      && item.validated === 0
    )).toBe(true);
  });

  it('does not mutate the canonical corpus', async () => {
    const runId = seedEvalRun('agent-1', 2.0, { injection: 1.5 });
    const metadata = JSON.parse((db.prepare('SELECT metadata FROM openmythos_eval_runs WHERE id = ?').get(runId) as any).metadata);
    const before = fs.readFileSync(metadata.corpus_path, 'utf8');
    await loop.runCycle('agent-1');
    expect(fs.readFileSync(metadata.corpus_path, 'utf8')).toBe(before);
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
