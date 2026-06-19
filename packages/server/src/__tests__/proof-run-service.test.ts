import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let runtimeBinDir = '';

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

function createFakeRuntimeScript(runtime: 'codex' | 'opencode', output: { prompt: number; completion: number; total: number }) {
  if (!runtimeBinDir) {
    runtimeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-proof-runtime-'));
  }
  const file = path.join(runtimeBinDir, runtime);
  const usage = JSON.stringify({
    prompt_tokens: output.prompt,
    completion_tokens: output.completion,
    total_tokens: output.total,
  });
  const script = `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "${runtime} fake-runtime 1.0.0"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "Usage: ${runtime} exec --json --cd <worktree> <prompt>"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "Usage: ${runtime} run --format json --dir <worktree> <prompt>"
  exit 0
fi
echo '{\"verdict\":\"accepted\",\"notes\":\"fake ${runtime} runtime accepted\",\"usage\":${usage}}'
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

function setRuntimeEnv(runtime: 'codex' | 'opencode') {
  const bins = {
    codex: { env: 'CODEX_BIN_PATH', values: { prompt: 1240, completion: 530, total: 1770 } },
    opencode: { env: 'OPENCODE_BIN_PATH', values: { prompt: 860, completion: 320, total: 1180 } },
  } as const;
  const config = bins[runtime];
  process.env[config.env] = createFakeRuntimeScript(runtime, config.values);
}

function clearRuntimeEnv() {
  delete process.env.CODEX_BIN_PATH;
  delete process.env.OPENCODE_BIN_PATH;
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/swarms', createSwarmRoutes(db, auth));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

describe('swarm proof runs', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    await startApp();
    clearRuntimeEnv();
    runtimeBinDir = '';
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    clearRuntimeEnv();
    if (runtimeBinDir) {
      fs.rmSync(runtimeBinDir, { recursive: true, force: true });
      runtimeBinDir = '';
    }
    db.close();
  });

  it('creates a complete persisted proof run, exposes it in mission control, and rolls it back', async () => {
    const createResponse = await fetch(`${baseUrl}/swarms/proof-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'mock' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as any;

    expect(created.passed).toBe(true);
    expect(created.status).toBe('completed');
    expect(created.runtime).toBe('mock');
    expect(created.counts).toMatchObject({
      capabilities: 6,
      panels: 1,
      reviews: 3,
      claims: 3,
      goals: 1,
      loop_runs: 1,
      worker_leases: 2,
      trace_spans: 5,
      checkpoints: 2,
      memory_candidates: 1,
      work_items: 1,
    });
    expect(created.counts.manifests).toBeGreaterThanOrEqual(4);
    expect(created.artifact_refs.goal).toBeTruthy();
    expect(created.artifact_refs.loop_run).toBeTruthy();
    expect(created.artifact_refs.worker_leases).toHaveLength(2);
    expect(created.missing).toEqual({});

    const getResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}`);
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json() as any;
    expect(fetched.id).toBe(created.id);
    expect(fetched.passed).toBe(true);

    const missionResponse = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
    expect(missionResponse.status).toBe(200);
    const mission = await missionResponse.json() as any;
    expect(mission.latest_proof_run.id).toBe(created.id);
    expect(mission.latest_proof_run.counts.worker_leases).toBe(2);
    expect(mission.swarm_truth.active_execution_count).toBe(0);

    const rollbackResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}/rollback`, { method: 'POST' });
    expect(rollbackResponse.status).toBe(200);
    const rolledBack = await rollbackResponse.json() as any;
    expect(rolledBack.status).toBe('rolled_back');
    expect(Object.values(rolledBack.counts).every((count) => count === 0)).toBe(true);

    const missingResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}`);
    expect(missingResponse.status).toBe(404);
  });

  it.each(['codex', 'opencode'] as const)('creates a complete persisted proof run via %s runtime bridge', async (runtime) => {
    setRuntimeEnv(runtime);

    const createResponse = await fetch(`${baseUrl}/swarms/proof-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime }),
    });
    const created = await createResponse.json() as any;

    expect(createResponse.status).toBe(201);
    expect(created.runtime).toBe(runtime);
    expect(created.status).toBe('completed');
    expect(created.passed).toBe(true);
    expect(created.counts.worker_leases).toBe(2);
    expect(created.counts.claims).toBe(3);
    expect(created.counts.manifests).toBeGreaterThanOrEqual(4);

    const missionResponse = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
    expect(missionResponse.status).toBe(200);
    const mission = await missionResponse.json() as any;
    expect(mission.latest_proof_run.id).toBe(created.id);
    expect(mission.swarm_truth.active_execution_count).toBe(0);

    const getResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}`);
    expect(getResponse.status).toBe(200);
    expect((await getResponse.json() as any).runtime).toBe(runtime);
  });
});
