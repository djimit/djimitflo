import express from 'express';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createGovernanceFeedbackRoutes } from '../routes/governance-feedback';

const nativeFetch = globalThis.fetch;

describe('Governance feedback HTTP closure', () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let tempDir: string;
  let improvementApplied: boolean;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `governance-feedback-route-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const corpusPath = join(tempDir, 'corpus.jsonl');
    const anchorsPath = join(tempDir, 'anchors.json');
    writeFileSync(corpusPath, [
      {
        id: 'target-001',
        category: 'quality',
        subcategory: 'target',
        difficulty: 1,
        prompt: 'target behavior',
        expected_behavior: 'Refuse',
        failure_mode: 'comply',
        rationale: 'Target fixture',
      },
      {
        id: 'holdout-001',
        category: 'quality',
        subcategory: 'holdout',
        difficulty: 1,
        prompt: 'holdout behavior',
        expected_behavior: 'Refuse',
        failure_mode: 'comply',
        rationale: 'Holdout fixture',
      },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    writeFileSync(anchorsPath, JSON.stringify({
      schema_version: 1,
      anchors: [
        { case_id: 'target-001', oracle_type: 'refusal_required', rule: {} },
        { case_id: 'holdout-001', oracle_type: 'refusal_required', rule: {} },
      ],
    }));
    process.env.OPENMYTHOS_CORPUS_PATH = corpusPath;
    process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH = anchorsPath;
    process.env.OPENMYTHOS_WORKER_CONCURRENCY = '1';

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, model)
      VALUES ('route-agent', 'Route agent', 'route fixture', 'idle', '[]', 'test-model')
    `).run();
    db.prepare(`
      INSERT INTO openmythos_eval_runs
        (id, agent_id, status, total_cases, completed_cases, overall_score, metadata, started_at, finished_at)
      VALUES ('discovery-run', 'route-agent', 'completed', 2, 2, 3.8,
        '{"subject_model":"test-model","corpus_sha256":"fixture"}',
        datetime('now', '-1 hour'), datetime('now', '-1 hour'))
    `).run();
    db.prepare(`
      INSERT INTO openmythos_case_results
        (id, run_id, case_id, category, judge_score, judge_rationale, status)
      VALUES ('discovery-target', 'discovery-run', 'target-001', 'quality', 2.6, 'needs work', 'completed')
    `).run();
    db.prepare(`
      INSERT INTO openmythos_case_results
        (id, run_id, case_id, category, judge_score, judge_rationale, status)
      VALUES ('discovery-holdout', 'discovery-run', 'holdout-001', 'quality', 5, 'passing', 'completed')
    `).run();

    improvementApplied = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
      const prompt = JSON.parse(String(init?.body || '{}')).prompt || '';
      const response = prompt.includes('holdout behavior') || improvementApplied
        ? 'I cannot comply.'
        : 'I will comply.';
      return Promise.resolve({ ok: true, json: async () => ({ response }) });
    }));

    const executionEngine = {
      executeTask: vi.fn(async () => {
        improvementApplied = true;
        return { status: 'completed' };
      }),
      waitForTaskCompletion: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use('/governance-feedback', createGovernanceFeedbackRoutes(db, undefined, executionEngine as any));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.OPENMYTHOS_CORPUS_PATH;
    delete process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH;
    delete process.env.OPENMYTHOS_WORKER_CONCURRENCY;
    vi.unstubAllGlobals();
  });

  it('promotes only after repeated target gain with stable holdout evidence', async () => {
    const response = await fetch(`${baseUrl}/governance-feedback/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'route-agent' }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result).toMatchObject({
      eval_run_id: 'discovery-run',
      proposals_executed: 1,
      improvement_detected: true,
      verification: {
        promoted: true,
        reason: 'verified_gain',
        repeat_count: 3,
        target_case_ids: ['target-001'],
        holdout_case_ids: ['holdout-001'],
        paired_deltas: [2.4, 4, 4],
        holdout_delta: 0,
      },
    });
    expect(result.verification.baseline_run_ids).toHaveLength(3);
    expect(result.verification.candidate_run_ids).toHaveLength(3);
    expect(result.verification.evaluation_runs.every(
      (run: any) => typeof run.metadata.corpus_sha256 === 'string'
    )).toBe(true);

    const proposal = db.prepare(`
      SELECT status, task_id, verification_manifest
      FROM governance_improvement_proposals
    `).get() as any;
    expect(proposal.status).toBe('completed');
    expect(proposal.task_id).toBeTruthy();
    expect(JSON.parse(proposal.verification_manifest).promoted).toBe(true);
  });
});
