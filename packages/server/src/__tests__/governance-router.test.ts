import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { LlmRouterService } from '../services/llm-router-service';

const OLLAMA_MODEL = 'qwen2.5:14b-instruct-q4_K_M'; // the router's ollama provider model

function insertEvalRun(db: Database, run: {
  id: string;
  subjectModel: string;
  categoryScores: Record<string, number>;
  finishedAt?: string;
}) {
  db.prepare(`
    INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
    VALUES (?, ?, 'completed', 78, 78, 3.0, ?, ?, ?)
  `).run(
    run.id,
    `nightly:${run.subjectModel}`,
    run.finishedAt ?? '2026-07-15T10:00:00.000Z',
    run.finishedAt ?? '2026-07-15T10:05:00.000Z',
    JSON.stringify({ subject_model: run.subjectModel, category_scores: run.categoryScores }),
  );
}

describe('LlmRouterService governance routing', () => {
  let db: Database;
  let service: LlmRouterService;
  const previousFloor = process.env.GOVERNANCE_ROUTER_FLOOR;

  beforeEach(() => {
    delete process.env.GOVERNANCE_ROUTER_FLOOR;
    db = createTestDb();
    service = new LlmRouterService(db);
    // ollama needs no API key; a successful call marks it active
    service.recordPerformance({ provider: 'ollama', taskType: 'chat', latencyMs: 100, success: true });
  });

  afterEach(() => {
    db.close();
    if (previousFloor === undefined) delete process.env.GOVERNANCE_ROUTER_FLOOR;
    else process.env.GOVERNANCE_ROUTER_FLOOR = previousFloor;
  });

  it('prefers the provider whose model has the best benchmark score for the risk category', () => {
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { injection: 4.2 } });

    const decision = service.route({ taskType: 'chat', prompt: 'handle untrusted input', riskCategory: 'injection' });

    expect(decision.provider).toBe('ollama');
    expect(decision.model).toBe(OLLAMA_MODEL);
    expect(decision.reason).toContain('Governance');
    expect(decision.reason).toContain('injection');
    expect(decision.reason).toContain('4.20');
  });

  it('falls back to static routing when the only scored model is below the floor', () => {
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { overthinking: 1.7 } });

    const decision = service.route({ taskType: 'chat', prompt: 'x', riskCategory: 'overthinking' });

    // ollama is still the first healthy static candidate, but via the static path
    expect(decision.reason).not.toContain('Governance');
  });

  it('the floor is configurable via GOVERNANCE_ROUTER_FLOOR', () => {
    process.env.GOVERNANCE_ROUTER_FLOOR = '1.5';
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { overthinking: 1.7 } });

    const decision = service.route({ taskType: 'chat', prompt: 'x', riskCategory: 'overthinking' });

    expect(decision.reason).toContain('Governance');
  });

  it('the latest eval run wins when a model was re-benchmarked', () => {
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { injection: 4.5 }, finishedAt: '2026-07-14T10:00:00.000Z' });
    insertEvalRun(db, { id: 'r2', subjectModel: OLLAMA_MODEL, categoryScores: { injection: 2.0 }, finishedAt: '2026-07-15T10:00:00.000Z' });

    const decision = service.route({ taskType: 'chat', prompt: 'x', riskCategory: 'injection' });

    // dropped below the default floor of 3 → static routing
    expect(decision.reason).not.toContain('Governance');
  });

  it('behaves exactly as before when no riskCategory is given', () => {
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { injection: 4.2 } });

    const decision = service.route({ taskType: 'chat', prompt: 'x' });

    expect(decision.reason).not.toContain('Governance');
    expect(decision.provider).toBe('ollama');
  });

  it('ignores governance data for categories with no scores', () => {
    insertEvalRun(db, { id: 'r1', subjectModel: OLLAMA_MODEL, categoryScores: { injection: 4.2 } });

    const decision = service.route({ taskType: 'chat', prompt: 'x', riskCategory: 'cross-lingual' });

    expect(decision.reason).not.toContain('Governance');
  });
});
