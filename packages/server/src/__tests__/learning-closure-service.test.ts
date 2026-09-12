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
import { SelfImprovementService } from '../services/self-improvement-service';

function makeDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database);
  return database;
}

function seedRun(db: Database.Database, id: string, checkerAccepted = true, repositoryPath = '/repo/default') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, gates_json, findings_json, plan_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'repo-maintenance-loop', 'closed', 'ready_for_human_merge', repositoryPath, JSON.stringify([{ name: 'checker_verdict', status: 'pass', evidence: 'accepted' }]), '[]', '{}', '[]', '{}', now, now);
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`${id}-maker`, id, 'maker', 'mock', 'completed', '{}', now, now);
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`${id}-checker`, id, 'checker', 'manual', checkerAccepted ? 'completed' : 'prepared', checkerAccepted
    ? JSON.stringify({ verdict: 'accepted', maker_lease_id: `${id}-maker` })
    : JSON.stringify({ maker_lease_id: `${id}-maker` }), now, now);
  const assurance = new AgentAssuranceService(db);
  assurance.createTraceSpan({
    trace_id: `trace-${id}`,
    loop_run_id: id,
    span_type: 'worker',
    name: 'mock-worker',
    status: 'ok',
    evidence_ref: `loop:${id}`,
  });
  assurance.createCheckpoint({ loop_run_id: id, label: 'verified' });
  db.prepare(`
    INSERT INTO swarm_runner_manifests (
      id, decision_id, loop_run_id, action, policy_version, runtime_contract_json,
      capacity_snapshot_json, budget_snapshot_json, gate_refs_json, blocked_reasons_json, metadata, created_at
    ) VALUES (?, ?, ?, 'complete', 'test-v1', '{}', '{}', '{}', '["checker_verdict"]', '[]', '{}', ?)
  `).run(`manifest-${id}`, `decision-${id}`, id, now);
}

describe('loop learning closure', () => {
  it.each([
    ['unresolved gate', "UPDATE loop_runs SET gates_json='[{\"name\":\"pending_check\",\"status\":\"warning\"}]' WHERE id='guarded-closure'", 'gate_not_passed'],
    ['missing security review', "UPDATE loop_runs SET metadata='{\"risk_class\":\"high\"}' WHERE id='guarded-closure'", 'security_checker_not_accepted'],
    ['operator pause', "UPDATE loop_runs SET metadata='{\"operator_paused\":true}' WHERE id='guarded-closure'", 'operator_paused'],
  ])('blocks learning closure for %s without new evaluation effects', (_label, mutation, reason) => {
    const db = makeDb();
    try {
      seedRun(db, 'guarded-closure');
      db.exec(mutation);
      expect(new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'guarded-closure' })).toMatchObject({ status: 'blocked', blocked_reasons: expect.arrayContaining([reason]) });
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_eval_runs').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('revalidates a stored closure after cancellation without deleting historical learning records', () => {
    const db = makeDb();
    try {
      seedRun(db, 'stale-closure');
      const knowledge = new KnowledgeRuntimeService(db);
      expect(knowledge.closeLoop({ loop_run_id: 'stale-closure' }).status).toBe('closed');
      db.prepare("UPDATE loop_runs SET status='cancelled' WHERE id='stale-closure'").run();
      expect(knowledge.closeLoop({ loop_run_id: 'stale-closure' })).toMatchObject({ status: 'blocked', blocked_reasons: expect.arrayContaining(['run_not_reviewed_terminal']) });
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_eval_runs').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('rejects legacy runtime verdict strings without the shared runtime proof contract', () => {
    const db = makeDb();
    try {
      seedRun(db, 'legacy-runtime');
      db.prepare("UPDATE worker_leases SET runtime='mock' WHERE id='legacy-runtime-checker'").run();
      expect(new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'legacy-runtime' })).toMatchObject({ status: 'blocked', blocked_reasons: expect.arrayContaining(['checker_not_accepted']) });
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('binds completed verified improvement to evaluating with actual closure evidence, never applied', () => {
    const db = makeDb();
    try {
      seedRun(db, 'improvement-closure');
      const proposals = new SelfImprovementService(db);
      const [proposal] = proposals.generateFromBuildErrors(['Fixture-only regression']);
      db.prepare("UPDATE self_improvements SET status='verified' WHERE id=?").run(proposal.id);
      db.prepare("INSERT INTO goals(id,objective,status,risk_class,improvement_id) VALUES ('improvement-goal','Fixture improvement','completed','low',?)").run(proposal.id);
      db.prepare("UPDATE loop_runs SET goal_id='improvement-goal' WHERE id='improvement-closure'").run();
      const knowledge = new KnowledgeRuntimeService(db);
      const early = knowledge.closeLoop({ loop_run_id: 'improvement-closure' });
      expect(early.status).toBe('closed');
      expect(proposals.getImprovement(proposal.id).status).toBe('verified');
      db.prepare("UPDATE loop_runs SET status='completed' WHERE id='improvement-closure'").run();
      const closed = knowledge.closeLoop({ loop_run_id: 'improvement-closure' });
      expect(closed.eval_run?.id).toBe(early.eval_run?.id);
      expect(proposals.getImprovement(proposal.id)).toMatchObject({ status: 'evaluating', evidenceRefs: expect.arrayContaining([
        'build:test-failure', 'loop:improvement-closure', `eval:${closed.eval_run!.id}`, `reflection:${closed.reflection!.id}`,
      ]) });
      knowledge.closeLoop({ loop_run_id: 'improvement-closure' });
      expect(proposals.getImprovement(proposal.id).status).toBe('evaluating');
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('rolls back new closure artifacts if binding would overwrite malformed improvement evidence', () => {
    const db = makeDb();
    try {
      seedRun(db, 'atomic-closure');
      const [proposal] = new SelfImprovementService(db).generateFromBuildErrors(['Atomic closure fixture']);
      db.prepare("UPDATE self_improvements SET status='verified',evidence_refs_json='not-json' WHERE id=?").run(proposal.id);
      db.prepare("INSERT INTO goals(id,objective,status,risk_class,improvement_id) VALUES ('atomic-goal','Fixture','completed','low',?)").run(proposal.id);
      db.prepare("UPDATE loop_runs SET goal_id='atomic-goal',status='completed' WHERE id='atomic-closure'").run();
      expect(() => new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'atomic-closure' })).toThrow();
      expect(db.prepare('SELECT status,evidence_refs_json FROM self_improvements WHERE id=?').get(proposal.id)).toEqual({ status: 'verified', evidence_refs_json: 'not-json' });
      for (const table of ['loop_learning_closures', 'agent_eval_runs', 'reflection_candidates', 'memory_candidates']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally { db.close(); }
  });

  it('does not close a cancelled run merely because old maker/checker evidence remains', () => {
    const db = makeDb();
    try {
      seedRun(db, 'cancelled-closure');
      db.prepare("UPDATE loop_runs SET status='cancelled' WHERE id='cancelled-closure'").run();
      expect(new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'cancelled-closure' })).toMatchObject({ status: 'blocked' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_eval_runs').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('does not close a multi-maker run while another active maker remains unfinished', () => {
    const db = makeDb();
    try {
      seedRun(db, 'partial-closure');
      db.prepare("INSERT INTO worker_leases(id,loop_run_id,role,runtime,status,metadata) VALUES ('unfinished-maker','partial-closure','maker','mock','prepared','{}')").run();
      expect(new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'partial-closure' })).toMatchObject({ status: 'blocked' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM loop_learning_closures').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

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
      seedRun(db, 'loop-regression-baseline', true);
      seedRun(db, 'loop-regression', true);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'maker', 'mock', 'completed', ?, ?, ?)
      `).run('loop-regression-retried-maker', 'loop-regression', JSON.stringify({ superseded_by_maker_lease_id: 'loop-regression-maker' }), now, now);
      db.prepare(`
        INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, scorecard_json, findings_json, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('previous-eval', 'loop-learning', 'loop', 'loop-regression-baseline', 'passed', 1, '{}', '[]', '{}', new Date(Date.now() - 1000).toISOString());

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
      seedRun(db, 'loop-improved-baseline', true);
      seedRun(db, 'loop-improved', true);
      db.prepare(`
        INSERT INTO agent_eval_runs (id, suite_name, target_type, target_ref, status, score, scorecard_json, findings_json, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('previous-low-eval', 'loop-learning', 'loop', 'loop-improved-baseline', 'failed', 0.35, '{}', '[]', '{}', new Date(Date.now() - 1000).toISOString());

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

  it('compares a new run with the latest run of the same loop', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-baseline', true);
      const baseline = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-baseline' });
      seedRun(db, 'loop-next', true);
      const next = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-next' });
      expect(next.previous_score).toBe(baseline.eval_run?.score);
      expect(next.score_delta).toBe(0);
      expect(next.eval_run?.scorecard).toMatchObject({ maker_completed: true, checker_accepted: true, deterministic: true });
    } finally {
      db.close();
    }
  });

  it('does not compare runs from another repository', () => {
    const db = makeDb();
    try {
      seedRun(db, 'repo-a-loop', true, '/repo/a');
      new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'repo-a-loop' });
      seedRun(db, 'repo-b-loop', true, '/repo/b');
      const result = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'repo-b-loop' });
      expect(result.previous_score).toBeNull();
      expect(result.score_delta).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is idempotent for the same loop run', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-idempotent');
      const knowledge = new KnowledgeRuntimeService(db);
      const first = knowledge.closeLoop({ loop_run_id: 'loop-idempotent' });
      const second = knowledge.closeLoop({ loop_run_id: 'loop-idempotent' });
      expect(second.eval_run?.id).toBe(first.eval_run?.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_eval_runs WHERE target_ref = 'loop-idempotent'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM reflection_candidates WHERE source_ref = 'loop-idempotent'").get()).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_candidates WHERE source_ref = 'loop:loop-idempotent'").get()).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('blocks closure when a required evidence type is missing', () => {
    const db = makeDb();
    try {
      seedRun(db, 'loop-missing-manifest');
      db.prepare("DELETE FROM swarm_runner_manifests WHERE loop_run_id = 'loop-missing-manifest'").run();
      const result = new KnowledgeRuntimeService(db).closeLoop({ loop_run_id: 'loop-missing-manifest' });
      expect(result.status).toBe('blocked');
      expect(result.blocked_reasons).toContain('runner_manifests_missing');
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_eval_runs').get()).toMatchObject({ count: 0 });
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
