import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { createTestDb } from './helpers/test-db';

import { errorHandler } from '../middleware/error-handler';
import { createGoalRoutes } from '../routes/goals';
import { createSwarmRoutes } from '../routes/swarms';
import { createWorkItemRoutes } from '../routes/work-items';

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

let db: Database.Database;
let server: Server;
let baseUrl: string;
let tempRoot: string;
let previousOkfBase: string | undefined;
let previousWorktreeRoot: string | undefined;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/goals', createGoalRoutes(db, auth));
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use('/work-items', createWorkItemRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function writeOkf(root: string) {
  const okfBase = path.join(root, 'okf');
  fs.mkdirSync(path.join(okfBase, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'validate_okf.py'), 'print("OK: smoke OKF valid")\n', 'utf8');
  fs.writeFileSync(path.join(okfBase, 'skills', 'smoke.md'), [
    '---',
    'title: Smoke Skill',
    'allowed_actions: [maker:mock, checker:mock]',
    'forbidden_actions: [deploy]',
    'required_evidence: [worker_lease, checker_verdict]',
    'risk_ceiling: low',
    'eval_threshold: 0.5',
    'removal_strategy: disable if smoke eval fails',
    '---',
    '# Smoke Skill',
  ].join('\n'), 'utf8');
  return okfBase;
}

function writeRepo(root: string) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n\nTODO: add real documentation\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      'type-check': 'node -e "process.exit(0)"',
    },
  }, null, 2), 'utf8');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'runner@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Runner Test'], { cwd: repo });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Initial smoke repo'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

describe('learning flywheel smoke', () => {
  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-learning-flywheel-'));
    previousOkfBase = process.env.OKF_BASE;
    previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    process.env.OKF_BASE = writeOkf(tempRoot);
    process.env.LOOP_WORKTREE_ROOT = path.join(tempRoot, 'worktrees');
    db = createTestDb();
    db.pragma('foreign_keys = ON');
    
    
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
    if (previousOkfBase) process.env.OKF_BASE = previousOkfBase;
    else delete process.env.OKF_BASE;
    if (previousWorktreeRoot) process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
    else delete process.env.LOOP_WORKTREE_ROOT;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('validates OKF, syncs capabilities, runs mock workers and closes learning without promotion', async () => {
    const runtime = await (await fetch(`${baseUrl}/swarms/knowledge/runtime`)).json() as any;
    expect(runtime.validate_okf.status).toBe('pass');
    expect(runtime.counts.skills).toBe(1);

    const drySync = await fetch(`${baseUrl}/swarms/knowledge/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    });
    expect(drySync.status).toBe(200);
    expect((await drySync.json() as any).created).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as count FROM swarm_capabilities').get()).toMatchObject({ count: 0 });

    const applySync = await fetch(`${baseUrl}/swarms/knowledge/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    });
    expect(applySync.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) as count FROM swarm_capabilities').get()).toMatchObject({ count: 1 });

    const batch = {
      change: 'smoke-change',
      goals: [{
        id: 'smoke-goal',
        title: 'Run learning flywheel smoke',
        risk: 'low',
        target: 'packages/server',
        acceptance: ['Smoke closes loop learning'],
      }],
    };
    const preview = await fetch(`${baseUrl}/goals/batch/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ total: 1, valid: 1, writes: 0 });

    const appliedGoals = await fetch(`${baseUrl}/goals/batch/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
    expect(appliedGoals.status).toBe(201);

    const repo = writeRepo(tempRoot);
    const workItemResponse = await fetch(`${baseUrl}/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Smoke worker assignment',
        description: 'Run maker and checker through mock worker pool.',
        source: 'learning_flywheel_smoke',
        source_ref: 'smoke:worker',
        risk_class: 'low',
        status: 'triaged',
        recommended_loop: 'doc-drift-and-small-fix-loop',
        metadata: { repository_path: repo },
      }),
    });
    expect(workItemResponse.status).toBe(201);
    const workItem = await workItemResponse.json() as any;

    const tick = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_item_ids: [workItem.id], plan_triaged: true, prepare_planned: true, runtime: 'mock' }),
    });
    expect(tick.status).toBe(200);
    const tickBody = await tick.json() as any;
    const loopRunId = tickBody.prepared_work_items[0].metadata.loop_run_id;
    expect(loopRunId).toEqual(expect.any(String));

    const drained = await fetch(`${baseUrl}/swarms/worker-pool/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'mock', checker_runtime: 'mock', max_workers: 2, ignore_capacity: true, timeout_ms: 10_000, diff_max_lines: 20 }),
    });
    expect(drained.status).toBe(200);
    const drainBody = await drained.json() as any;
    expect(drainBody.started.map((item: any) => item.decision.next_action)).toEqual(['execute_maker', 'execute_checker']);

    const closed = await fetch(`${baseUrl}/swarms/evolution/close-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loop_run_id: loopRunId, work_item_id: workItem.id, promote_memory: false }),
    });
    expect(closed.status).toBe(201);
    const closure = await closed.json() as any;
    expect(closure).toMatchObject({
      status: 'closed',
      loop_run_id: loopRunId,
      memory_candidate: { promotion_status: 'proposed' },
    });
    expect(db.prepare("SELECT COUNT(*) as count FROM memory_candidates WHERE status = 'promoted'").get()).toMatchObject({ count: 0 });
  }, 30000);
});
