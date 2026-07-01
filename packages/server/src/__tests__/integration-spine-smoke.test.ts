import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createWorkItemRoutes } from '../routes/work-items';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;
let previousWorktreeRoot: string | undefined;
let worktreeRoot: string;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/work-items', createWorkItemRoutes(db, auth));
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-integration-spine-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'TODO: document integration spine smoke\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      'type-check': 'node -e "process.exit(0)"',
    },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'integration-spine@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Integration Spine Smoke'], { cwd: repo });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Initial integration spine smoke repo'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

describe('agentic OS integration spine smoke', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-integration-spine-worktrees-'));
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
    if (previousWorktreeRoot) {
      process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
    } else {
      delete process.env.LOOP_WORKTREE_ROOT;
    }
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('runs one imported integration event through worker, checker and learning closure', async () => {
    const repo = makeRepo();
    try {
      const importedResponse = await fetch(`${baseUrl}/work-items/integrations/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'dashboard_action',
          source_ref: 'dashboard:integration-spine-smoke',
          title: 'Prove integration spine smoke',
          description: 'Import, plan, execute, check and close one bounded smoke run.',
          risk_class: 'low',
          recommended_loop: 'doc-drift-and-small-fix-loop',
          metadata: {
            repository_path: repo,
            integration: {
              requested_runtime: 'mock',
              production_pilot: true,
              manual_interventions: 0,
            },
          },
        }),
      });
      expect(importedResponse.status).toBe(201);
      const imported = await importedResponse.json() as any;
      const workItemId = imported.work_item.id;
      expect(imported.work_item.metadata.integration).toMatchObject({
        source: 'dashboard_action',
        source_ref: 'dashboard:integration-spine-smoke',
        requested_runtime: 'mock',
      });

      const tickResponse = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          max_items: 1,
          plan_triaged: true,
          prepare_planned: true,
          runtime: 'mock',
          work_item_ids: [workItemId],
        }),
      });
      expect(tickResponse.status).toBe(200);
      const tick = await tickResponse.json() as any;
      expect(tick.planned_work_items).toHaveLength(1);
      expect(tick.prepared_work_items).toHaveLength(1);
      expect(tick.prepared_work_items[0]).toMatchObject({
        id: workItemId,
        status: 'leased',
        assigned_runtime: 'mock',
      });
      const loopRunId = tick.prepared_work_items[0].metadata.loop_run_id;

      const leasesBefore = db.prepare('SELECT role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(loopRunId) as any[];
      expect(leasesBefore).toHaveLength(2);
      expect(leasesBefore).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', runtime: 'mock', status: 'prepared' }),
        expect.objectContaining({ role: 'checker', runtime: 'manual', status: 'prepared' }),
      ]));
      const makerBefore = leasesBefore.find((lease) => lease.role === 'maker');
      expect(JSON.parse(makerBefore.metadata)).toMatchObject({
        requested_runtime: 'mock',
        effective_runtime: 'mock',
      });

      const goal = db.prepare('SELECT metadata FROM goals WHERE id = ?').get(tick.prepared_work_items[0].parent_goal_id) as any;
      expect(JSON.parse(goal.metadata)).toMatchObject({ source_work_item_id: workItemId });

      const planResponse = await fetch(`${baseUrl}/swarms/worker-pool/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true }),
      });
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as any;
      expect(plan.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', eligible: true, next_action: 'execute_maker', effective_runtime: 'mock' }),
      ]));

      const drainResponse = await fetch(`${baseUrl}/swarms/worker-pool/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', ignore_capacity: true, max_workers: 2, timeout_ms: 10_000, diff_max_lines: 20 }),
      });
      expect(drainResponse.status).toBe(200);
      const drain = await drainResponse.json() as any;
      expect(drain.started.map((item: any) => item.decision.next_action)).toEqual(['execute_maker', 'execute_checker']);

      const closeResponse = await fetch(`${baseUrl}/swarms/evolution/close-loop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loop_run_id: loopRunId, work_item_id: workItemId, promote_memory: false }),
      });
      expect(closeResponse.status).toBe(201);
      const closure = await closeResponse.json() as any;
      expect(closure).toMatchObject({
        action: 'closed_loop_learning',
        loop_run_id: loopRunId,
        status: 'closed',
        blocked_reasons: [],
      });
      expect(closure.eval_run.id).toEqual(expect.any(String));
      expect(closure.reflection.id).toEqual(expect.any(String));
      expect(closure.memory_candidate).toMatchObject({
        source_ref: `loop:${loopRunId}`,
        promotion_status: 'proposed',
      });

      const workItem = db.prepare('SELECT status, metadata FROM work_items WHERE id = ?').get(workItemId) as any;
      const metadata = JSON.parse(workItem.metadata);
      expect(workItem.status).toBe('done');
      expect(metadata.integration).toMatchObject({
        source: 'dashboard_action',
        source_ref: 'dashboard:integration-spine-smoke',
      });
      expect(metadata.fleet_outcome).toMatchObject({
        loop_run_id: loopRunId,
        status: 'done',
        reason: 'ready_for_human_merge',
      });
      expect((db.prepare('SELECT COUNT(*) as count FROM agent_trace_spans WHERE loop_run_id = ?').get(loopRunId) as any).count).toBeGreaterThan(0);
      expect((db.prepare('SELECT COUNT(*) as count FROM swarm_runner_manifests WHERE loop_run_id = ?').get(loopRunId) as any).count).toBeGreaterThan(0);

      const missionResponse = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
      expect(missionResponse.status).toBe(200);
      const mission = await missionResponse.json() as any;
      expect(mission.integration_spine.latest).toMatchObject({
        source: 'dashboard_action',
        source_ref: 'dashboard:integration-spine-smoke',
        work_item: {
          id: workItemId,
          status: 'done',
          assigned_runtime: 'mock',
        },
        loop: {
          id: loopRunId,
        },
        requested_runtime: 'mock',
        next_safe_action: 'Review reflection and memory candidates',
      });
      expect(mission.integration_spine.latest.leases).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', effective_runtime: 'mock', status: 'completed' }),
        expect.objectContaining({ role: 'checker', effective_runtime: 'mock', status: 'completed' }),
      ]));
      expect(mission.integration_spine.latest.eval_run.id).toBe(closure.eval_run.id);
      expect(mission.integration_spine.next_safe_action).toBe('Review reflection and memory candidates');
      expect(mission.production_pilot).toMatchObject({
        metrics: {
          total_runs: 1,
          completed_runs: 1,
          success_rate: 1,
          checker_rejection_rate: 0,
          reflection_candidates: 1,
          memory_candidates: 1,
          manual_intervention_count: 0,
        },
        next_safe_action: 'Review reflection and memory candidates',
      });
      expect(mission.production_pilot.latest.work_item.id).toBe(workItemId);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
