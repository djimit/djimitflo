import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
// Isolation for the loop filesystem. ProofRunService hardcodes
// `repository_path = process.cwd()` (proof-run-service.ts insertLoopRun), so a
// proof run's `git worktree add` locks the source repo's .git/worktree.lock.
// Under parallel vitest forks that share the real monorepo this races and
// surfaces as WORKTREE_CREATE_FAILED -> 500. Chdir into a per-test temp git
// repo (unique git dir) + per-test LOOP_WORKTREE_ROOT/LOOP_EVIDENCE_ROOT removes
// the shared-monorepo lock race deterministically.
let tempRepoDir = '';
let originalCwd = '';
let worktreeRoot = '';
let evidenceRoot = '';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-proof-repo-'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'proof-run temp repo\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      'type-check': 'node -e "process.exit(0)"',
      'proof:test': 'node -e "process.exit(0)"',
      'proof:lint': 'node -e "process.exit(0)"',
      'proof:type-check': 'node -e "process.exit(0)"',
    },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'proof-test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Proof Test'], { cwd: dir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'Initial proof repo'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

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
    // Isolate the loop filesystem BEFORE startApp/proof-run: chdir to a fresh
    // temp git repo so `repository_path = process.cwd()` points at a repo with a
    // unique git dir (no shared-monorepo worktree.lock race), and give the loop
    // its own per-test worktree + evidence roots.
    originalCwd = process.cwd();
    tempRepoDir = makeTempRepo();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-proof-worktrees-'));
    evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-proof-evidence-'));
    process.chdir(tempRepoDir);
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    process.env.LOOP_EVIDENCE_ROOT = evidenceRoot;
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
    if (originalCwd) {
      try { process.chdir(originalCwd); } catch { /* original cwd may be gone */ }
    }
    delete process.env.LOOP_WORKTREE_ROOT;
    delete process.env.LOOP_EVIDENCE_ROOT;
    if (tempRepoDir) { fs.rmSync(tempRepoDir, { recursive: true, force: true }); tempRepoDir = ''; }
    if (worktreeRoot) { fs.rmSync(worktreeRoot, { recursive: true, force: true }); worktreeRoot = ''; }
    if (evidenceRoot) { fs.rmSync(evidenceRoot, { recursive: true, force: true }); evidenceRoot = ''; }
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
    expect(created.proof_class).toBe('demo');
    expect(created.production_passed).toBe(false);
    expect(created.production_missing).toEqual(expect.arrayContaining(['non_mock_runtime']));
    expect(created.status).toBe('completed');
    expect(created.runtime).toBe('mock');
    expect(created.counts).toMatchObject({
      capabilities: 6,
      panels: 1,
      reviews: 3,
      claims: 3,
      goals: 1,
      loop_runs: 1,
      worker_leases: 4,
      trace_spans: 5,
      checkpoints: 2,
      memory_candidates: 1,
      work_items: 1,
    });
    expect(created.counts.spawn_trees).toBe(1);
    expect(created.counts.sub_agent_spawns).toBe(2);
    expect(created.counts.manifests).toBeGreaterThanOrEqual(4);
    expect(created.artifact_refs.goal).toBeTruthy();
    expect(created.artifact_refs.loop_run).toBeTruthy();
    expect(created.artifact_refs.worker_leases).toHaveLength(4);
    expect(created.missing).toEqual({});

    const getResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}`);
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json() as any;
    expect(fetched.id).toBe(created.id);
    expect(fetched.passed).toBe(true);
    expect(fetched.production_passed).toBe(false);

    const missionResponse = await fetch(`${baseUrl}/swarms/intelligence/mission-control`);
    expect(missionResponse.status).toBe(200);
    const mission = await missionResponse.json() as any;
    expect(mission.latest_proof_run.id).toBe(created.id);
    expect(mission.latest_proof_run.counts.worker_leases).toBe(4);
    expect(mission.swarm_truth.active_execution_count).toBe(0);

    const rollbackResponse = await fetch(`${baseUrl}/swarms/proof-runs/${created.id}/rollback`, { method: 'POST' });
    expect(rollbackResponse.status).toBe(200);
    const rolledBack = await rollbackResponse.json() as any;
    expect(rolledBack.status).toBe('rolled_back');
    expect(rolledBack.production_passed).toBe(false);
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
    expect(created.proof_class).toBe('production');
    expect(created.production_passed).toBe(true);
    expect(created.production_missing).toEqual([]);
    expect(created.counts.worker_leases).toBe(4);
    expect(created.counts.spawn_trees).toBe(1);
    expect(created.counts.sub_agent_spawns).toBe(2);
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

    const maker = db.prepare("SELECT metadata FROM worker_leases WHERE role = 'maker'").get() as { metadata: string };
    const makerMetadata = JSON.parse(maker.metadata) as { deterministic_checks?: Array<{ name: string; status: string }> };
    expect(makerMetadata.deterministic_checks?.map((check) => [check.name, check.status])).toEqual([
      ['proof:test', 'pass'],
      ['proof:lint', 'pass'],
      ['proof:type-check', 'pass'],
    ]);

    const subAgents = db.prepare(`
      SELECT role, status, metadata
      FROM worker_leases
      WHERE role IN ('planner', 'memory_curator')
      ORDER BY role
    `).all() as Array<{ role: string; status: string; metadata: string }>;
    expect(subAgents.map((lease) => [lease.role, lease.status])).toEqual([
      ['memory_curator', 'completed'],
      ['planner', 'completed'],
    ]);
    for (const lease of subAgents) {
      expect(JSON.parse(lease.metadata).runtime_usage.total_tokens).toBeGreaterThan(0);
    }

    const claims = (db.prepare('SELECT claim FROM swarm_claims').all() as Array<{ claim: string }>).map((row) => row.claim);
    expect(claims).toContain(`Runtime ${runtime} executed maker and checker workers through the process runtime bridge.`);
    expect(claims).not.toContain('The remaining runtime upgrade is replacing mock execution with Codex/OpenCode process spawn.');
  });

  it('returns a deterministic 503 PROOF_RUN_RUNTIME_FAILED when worktree creation fails', async () => {
    // Point cwd at a non-git dir so createWorktree's `git rev-parse`/`git worktree add`
    // fails. createRuntimeProofRun wraps that as PROOF_RUN_RUNTIME_FAILED; the route
    // must map it to a stable 503 (not a bare 500 INTERNAL_ERROR).
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-proof-nongit-'));
    process.chdir(nonGitDir);
    try {
      const res = await fetch(`${baseUrl}/swarms/proof-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: 'codex' }),
      });
      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.error.code).toBe('PROOF_RUN_RUNTIME_FAILED');
    } finally {
      process.chdir(tempRepoDir);
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
