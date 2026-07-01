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

const realSmokeEnabled = process.env.RUN_REAL_RUNTIME_SMOKE === '1';
const realRuntime = (process.env.REAL_RUNTIME || 'codex').toLowerCase();
const maybeIt = realSmokeEnabled ? it : it.skip;
const defaultOnlyIt = realSmokeEnabled ? it.skip : it;

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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-real-runtime-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), [
    '# Real runtime smoke',
    '',
    'TODO: add one sentence that says the real runtime certification smoke completed.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      'type-check': 'node -e "process.exit(0)"',
      proof: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'real-runtime@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Real Runtime Smoke'], { cwd: repo });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Initial real runtime smoke repo'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

describe('production real runtime integration certification', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-real-runtime-worktrees-'));
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    await startApp();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    if (previousWorktreeRoot) {
      process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
    } else {
      delete process.env.LOOP_WORKTREE_ROOT;
    }
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  defaultOnlyIt('is skipped by default to avoid unattended real runtime execution', () => {
    expect(realSmokeEnabled).toBe(false);
  });

  maybeIt('runs one low-risk integration chain and proof run with a real runtime', async () => {
    expect(['codex', 'opencode']).toContain(realRuntime);

    const readinessResponse = await fetch(`${baseUrl}/swarms/runtime-readiness?runtime=${realRuntime}`);
    expect(readinessResponse.status).toBe(200);
    const readiness = await readinessResponse.json() as any;
    expect(readiness.runtimes[0].ready, JSON.stringify(readiness.runtimes[0].blocked_reasons)).toBe(true);

    const repo = makeRepo();
    try {
      const importedResponse = await fetch(`${baseUrl}/work-items/integrations/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'dashboard_action',
          source_ref: `dashboard:real-runtime:${realRuntime}`,
          title: `Certify ${realRuntime} integration runtime`,
          description: 'Run a bounded low-risk real runtime certification chain.',
          risk_class: 'low',
          recommended_loop: 'doc-drift-and-small-fix-loop',
          metadata: {
            repository_path: repo,
            integration: {
              requested_runtime: realRuntime,
              production_certification: true,
              production_pilot: true,
              manual_interventions: 0,
            },
          },
        }),
      });
      expect(importedResponse.status).toBe(201);
      const imported = await importedResponse.json() as any;
      const workItemId = imported.work_item.id;

      const tickResponse = await fetch(`${baseUrl}/swarms/scheduler/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          max_items: 1,
          plan_triaged: true,
          prepare_planned: true,
          runtime: realRuntime,
          work_item_ids: [workItemId],
        }),
      });
      expect(tickResponse.status).toBe(200);
      const tick = await tickResponse.json() as any;
      const loopRunId = tick.prepared_work_items[0].metadata.loop_run_id;
      const leasesBefore = db.prepare('SELECT role, runtime, status FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(loopRunId) as any[];
      expect(leasesBefore).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'maker', runtime: realRuntime, status: 'prepared' }),
        expect.objectContaining({ role: 'checker', runtime: 'manual', status: 'prepared' }),
      ]));

      const drainResponse = await fetch(`${baseUrl}/swarms/worker-pool/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtime: realRuntime,
          checker_runtime: realRuntime,
          ignore_capacity: true,
          max_workers: 2,
          timeout_ms: 600_000,
          diff_max_lines: 200,
          skip_permissions: process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS === 'true',
        }),
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
      if (closure.status !== 'closed') {
        const leases = db.prepare('SELECT role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY role ASC').all(loopRunId) as any[];
        const run = db.prepare('SELECT status, gates_json, next_actions_json FROM loop_runs WHERE id = ?').get(loopRunId) as any;
        throw new Error(JSON.stringify({
          closure,
          run: {
            status: run?.status,
            gates: run ? JSON.parse(run.gates_json || '[]') : [],
            next_actions: run ? JSON.parse(run.next_actions_json || '[]') : [],
          },
          leases: leases.map((lease) => ({
            role: lease.role,
            runtime: lease.runtime,
            status: lease.status,
            metadata: JSON.parse(lease.metadata || '{}'),
          })),
        }, null, 2));
      }
      expect(closure.status).toBe('closed');
      expect(closure.memory_candidate.promotion_status).toBe('proposed');

      const proofResponse = await fetch(`${baseUrl}/swarms/proof-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtime: realRuntime,
          skip_permissions: process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS === 'true',
        }),
      });
      if (proofResponse.status !== 201) {
        throw new Error(await proofResponse.text());
      }
      expect(proofResponse.status).toBe(201);
      const proof = await proofResponse.json() as any;
      expect(proof.proof_class).toBe('production');
      expect(proof.runtime).toBe(realRuntime);
      expect(proof.production_missing).toEqual([]);
      expect(proof.production_passed).toBe(true);

      const missionResponse = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
      expect(missionResponse.status).toBe(200);
      const mission = await missionResponse.json() as any;
      expect(mission.production_certification).toMatchObject({
        status: 'certified',
        runtime: realRuntime,
        production_passed: true,
        production_missing: [],
      });
      expect(mission.production_pilot.metrics).toMatchObject({
        total_runs: 1,
        completed_runs: 1,
        success_rate: 1,
        checker_rejection_rate: 0,
        manual_intervention_count: 0,
      });
      expect(mission.production_pilot.latest.work_item.id).toBe(workItemId);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 900_000);
});
