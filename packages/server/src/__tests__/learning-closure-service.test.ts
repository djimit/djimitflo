import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createSwarmRoutes } from '../routes/swarms';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

function makeDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database);
  return database;
}

function seedRun(db: Database.Database, id: string, checkerAccepted = true) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, findings_json, plan_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'repo-maintenance-loop', 'closed', 'ready_for_human_merge', JSON.stringify([{ name: 'checker_verdict', status: 'pass', evidence: 'accepted' }]), '[]', '{}', '[]', '{}', now, now);
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`${id}-maker`, id, 'maker', 'mock', 'completed', '{}', now, now);
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`${id}-checker`, id, 'checker', 'mock', checkerAccepted ? 'completed' : 'prepared', checkerAccepted ? '{"verdict":"accepted"}' : '{}', now, now);
  new AgentAssuranceService(db).createTraceSpan({
    trace_id: `trace-${id}`,
    loop_run_id: id,
    span_type: 'worker',
    name: 'mock-worker',
    status: 'ok',
    evidence_ref: `loop:${id}`,
  });
}

describe('loop learning closure', () => {
  it('blocks closure when checker evidence is missing', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-missing-checker', false);
      const result = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-missing-checker' });
      expect(result).toMatchObject({ status: 'blocked' });
      expect(result.blocked_reasons).toContain('checker_not_accepted');
      expect(db.prepare('SELECT COUNT(*) as count FROM agent_eval_runs').get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('creates eval, reflection, memory candidate and regression follow-up', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-regression', true);
      db.prepare(`
        INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, scorecard_json, findings_json, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('previous-eval', 'loop-learning', 'loop', 'loop-regression', 'passed', 0.95, '{}', '[]', '{}', new Date(Date.now() - 1000).toISOString());

      const result = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-regression' });
      expect(result.status).toBe('closed');
      expect(result.eval_run?.target_ref).toBe('loop-regression');
      expect(result.reflection?.source_ref).toBe('loop-regression');
      expect(result.memory_candidate?.source_ref).toBe('loop:loop-regression');
      expect(result.follow_up_work_item?.source).toBe('loop_learning_closure');
      expect(result.score_delta).toBeLessThan(0);
    } finally {
      db.close();
    }
  });

  it('creates skill improvement work when score improves', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-improved', true);
      db.prepare(`
        INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, scorecard_json, findings_json, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('previous-low-eval', 'loop-learning', 'loop', 'loop-improved', 'failed', 0.35, '{}', '[]', '{}', new Date(Date.now() - 1000).toISOString());

      const result = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-improved' });
      expect(result.status).toBe('closed');
      expect(result.score_delta).toBeGreaterThan(0);
      expect(result.skill_improvement_work_item).toMatchObject({
        source: 'loop_learning_closure',
        recommended_loop: 'skill-quality-loop',
      });
      expect(result.follow_up_work_item).toBeNull();
    } finally {
      db.close();
    }
  });

  it('closes loop learning through the swarm API route', async () => {
    const db = makeDb();
    const app = express();
    app.use(express.json());
    app.use('/swarms', createSwarmRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any));
    app.use(errorHandler);
    let server: Server | null = null;
    try {
      seedRun(db, 'loop-route-close', true);
      server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
      });
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/swarms/evolution/close-loop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loop_run_id: 'loop-route-close', promote_memory: false }),
      });
      expect(response.status).toBe(201);
      const result = await response.json() as any;
      expect(result).toMatchObject({
        action: 'closed_loop_learning',
        loop_run_id: 'loop-route-close',
        status: 'closed',
      });
      expect(result.memory_candidate.promotion_status).toBe('proposed');
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
      }
      db.close();
    }
  });
});
