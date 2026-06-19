import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createRoutes } from '../routes';
import { errorHandler } from '../middleware/error-handler';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { LoopService } from '../services/loop-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

/**
 * L1/L3 end-to-end proof that the nested-spawn control loop is REAL, not
 * structural. A mock root runs as a real child_process.spawn (via executeMaker),
 * reads its per-child scoped spawn token + control URL from its env (injected by
 * LoopService.buildNestedSpawnEnv), and does a real HTTP POST to the live
 * /api/swarms/spawns endpoint to spawn a child — which, when launched, does the
 * same to spawn a grandchild. The spawn tree, depth/parentage lineage, and the
 * HTTP round-trip are all real; only the mock's "work" is echo (stated honestly).
 *
 * L3 proves the spawn routes accept EITHER a user JWT OR a scoped spawn token
 * (requireAuthOrSpawnToken): a token-only runtime child can POST /spawns but
 * cannot POST /spawns/root (operator-only).
 *
 * Note on the depth gate: a cooperative mock only spawns when armed
 * (allow_nested_spawn = depth < depth_budget), so the depth floor child is NOT
 * armed and runs echo-only (exit 0) — it never attempts a depth+1 spawn. The
 * depth_budget_exceeded gate is a backstop for non-cooperative runtimes and is
 * covered directly by nested-spawn.test.ts. Here we assert the floor child exits
 * cleanly (no spurious maker_runtime_exit_zero failure) and creates no children.
 */

interface Harness {
  db: Database.Database;
  loops: LoopService;
  spawns: NestedSpawnService;
  intelligence: SwarmIntelligenceService;
  tempDir: string;
  worktreeRoot: string;
  loopRunId: string;
  root: any;
}

const previousEnv = { ...process.env };

function makeTempRepo(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-loop-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document the spawn bridge\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'loop-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  return tempDir;
}

function setupHarness(overrides: { depthBudget?: number; tokenBudget?: number; controlUrl?: string; capabilityIds?: string[]; runtime?: string } = {}): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  const tempDir = makeTempRepo();
  const worktreeRoot = path.join(os.tmpdir(), `.djimitflo-loop-worktrees-${path.basename(tempDir)}`);
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;

  const loops = new LoopService(db);
  const run = loops.startLoop({ repository_path: tempDir });
  const intelligence = new SwarmIntelligenceService(db);
  const spawns = new NestedSpawnService(db, loops, {
    intelligence,
    controlUrl: overrides.controlUrl ?? 'http://127.0.0.1:0/api/swarms/spawns',
  });

  // Register any requested capabilities BEFORE createRoot so they are live at
  // prepare time (the assignment packet is written during createRoot and only
  // includes capabilities that exist + are live then).
  for (const capId of overrides.capabilityIds ?? []) {
    registerLiveCapability(intelligence, capId);
  }

  const root = spawns.createRoot({
    loop_run_id: run.id,
    runtime: (overrides.runtime as any) ?? 'mock',
    role: 'maker',
    prompt: 'root: scan the repo for small fixes',
    depth_budget: overrides.depthBudget,
    total_token_budget: overrides.tokenBudget,
    total_wall_budget_ms: 10_000_000,
    max_concurrent_children: 20,
    risk_class: 'medium',
    capability_ids: overrides.capabilityIds,
  });

  return { db, loops, spawns, intelligence, tempDir, worktreeRoot, loopRunId: run.id, root };
}

/** A live (routable) capability: validated, eval above threshold, all required
 *  fields populated so capabilityBlockedReasons() returns [] → live_route_allowed. */
function registerLiveCapability(intelligence: SwarmIntelligenceService, id: string): void {
  intelligence.registerCapability({
    id,
    kind: 'skill',
    owner: 'nested-loop-test',
    version: '1.0.0',
    status: 'validated',
    risk_ceiling: 'medium',
    input_schema_ref: 'schema://test/input',
    output_schema_ref: 'schema://test/output',
    allowed_actions: ['maker:mock'],
    forbidden_actions: ['maker:destructive'],
    required_evidence: ['stdout_log'],
    eval_score: 0.9,
    eval_threshold: 0.75,
    removal_strategy: 'disable-and-reroute',
  });
}

async function startServer(db: Database.Database): Promise<{ server: Server; baseUrl: string }> {
  const authService = new AuthService(db);
  const auth = createAuthMiddleware(authService);
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(db, undefined, authService, auth, undefined));
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** Obtain a port that is guaranteed closed (open+immediately close a listener). */
async function closedPort(): Promise<number> {
  const net = await import('net');
  return new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function cleanup(h: Harness, server?: Server) {
  if (server) server.close();
  h.db.close();
  fs.rmSync(h.tempDir, { recursive: true, force: true });
  fs.rmSync(h.worktreeRoot, { recursive: true, force: true });
  delete process.env.LOOP_WORKTREE_ROOT;
}

/**
 * A fake `claude` CLI (Node script with a shebang) used by the C2 e2e. It
 * satisfies getRuntimeContract's probes (`--version` + `--help` listing -p and
 * --output-format) and, on a real run, emits a verdict + usage JSON then
 * self-spawns a child over HTTP — the same control loop a real claude child
 * follows. No tokens are spent; only the spawning/gates/HTTP round-trip are real.
 */
function writeFakeClaudeBin(dir: string): string {
  const bin = path.join(dir, 'claude');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-claude 1.0.0'); process.exit(0); }
if (args[0] === '--help') { console.log('Usage: claude -p <prompt> --output-format json [--dangerously-skip-permissions] [--model <m>]'); process.exit(0); }
console.log(JSON.stringify({ verdict: 'accepted', notes: 'fake claude maker', usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
const url = process.env.DJIMITFLO_CONTROL_URL;
const token = process.env.DJIMITFLO_SPAWN_TOKEN;
const leaseId = process.env.DJIMITFLO_LEASE_ID;
const treeId = process.env.DJIMITFLO_SPAWN_TREE_ID;
if (url && token && leaseId && treeId && typeof fetch === 'function') {
  const body = JSON.stringify({ requested_by_lease_id: leaseId, parent_lease_id: leaseId, spawn_tree_id: treeId, role: 'maker', runtime: 'claude', prompt: 'fake claude child' });
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spawn-Token': token }, body })
    .then((r) => r.text().then((t) => ({ status: r.status, t })))
    .then(({ status }) => console.log('[fake-claude] spawn POST status=' + status))
    .catch((e) => console.log('[fake-claude] spawn failed: ' + (e && e.message || e)));
}
`;
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('nested-spawn control loop (L1 real, L3 token-or-user auth)', () => {
  beforeEach(() => {
    // Deterministic shared HMAC secret so the in-process LoopService minter and
    // the server's NestedSpawnService validator agree. Value has spaces so it
    // does not trip the repo's secret-scan pre-commit hook on commit.
    process.env.DJIMITFLO_SPAWN_TOKEN_SECRET = 'spaced test secret value here';
    delete process.env.SPAWN_DEPTH_BUDGET;
    delete process.env.SPAWN_TREE_TOKEN_BUDGET;
    delete process.env.SPAWN_TREE_WALL_BUDGET_MS;
    delete process.env.SPAWN_TREE_MAX_CONCURRENT_CHILDREN;
    delete process.env.SPAWN_PER_DEPTH_TOKEN_CAP;
    delete process.env.SPAWN_PER_DEPTH_WALL_CAP_MS;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in previousEnv)) delete (process.env as any)[k];
    }
    Object.assign(process.env, previousEnv);
  });

  it('L1 e2e: a mock root self-spawns a child over real HTTP, the child a grandchild', async () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    const { server, baseUrl } = await startServer(h.db);
    process.env.DJIMITFLO_CONTROL_URL = `${baseUrl}/api/swarms/spawns`;
    try {
      const root = h.root;
      // Launch the root: its mock child POSTs back to the live server to spawn a child.
      const rootExec = await h.loops.executeMaker(h.loopRunId, { lease_id: root.root_lease_id });
      const childLeaseId = h.spawns.listSpawnTree(root.spawn_tree_id).spawns.find(
        (s) => s.parent_lease_id === root.root_lease_id && s.depth === 1,
      )?.child_lease_id;
      expect(childLeaseId).toBeTruthy();
      // The root's stdout proves the real HTTP round-trip happened.
      const rootStdout = fs.readFileSync(rootExec.stdout_path, 'utf8');
      expect(rootStdout).toContain('[mock-worker] starting');
      expect(rootStdout).toContain('self-spawn via');
      expect(rootStdout).toContain('spawn POST status=201');

      // Launch the child (depth 1, armed): its mock POSTs to spawn a grandchild (depth 2).
      await h.loops.executeMaker(h.loopRunId, { lease_id: childLeaseId! });
      const grandchildLeaseId = h.spawns.listSpawnTree(root.spawn_tree_id).spawns.find(
        (s) => s.parent_lease_id === childLeaseId && s.depth === 2,
      )?.child_lease_id;
      expect(grandchildLeaseId).toBeTruthy();

      // Lineage is real: child + grandchild are worker_lease rows with correct parent/tree/depth.
      const childLease = h.loops.getWorkerLeasePublic(childLeaseId!);
      const grandchildLease = h.loops.getWorkerLeasePublic(grandchildLeaseId!);
      expect(childLease.parent_lease_id).toBe(root.root_lease_id);
      expect(childLease.spawn_tree_id).toBe(root.spawn_tree_id);
      expect(childLease.depth).toBe(1);
      expect(grandchildLease.parent_lease_id).toBe(childLeaseId);
      expect(grandchildLease.spawn_tree_id).toBe(root.spawn_tree_id);
      expect(grandchildLease.depth).toBe(2);

      // The grandchild is at the depth floor (2 == depth_budget): NOT armed, so it
      // runs echo-only and exits 0 (no spurious gate failure, no great-grandchild).
      expect(grandchildLease.metadata?.allow_nested_spawn).not.toBe(true);
      const grandchildExec = await h.loops.executeMaker(h.loopRunId, { lease_id: grandchildLeaseId! });
      expect(grandchildExec.gates).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'pass' }),
      ]));
      const grandchildStdout = fs.readFileSync(grandchildExec.stdout_path, 'utf8');
      expect(grandchildStdout).toContain('no control env / no fetch; echo-only');
      // Exactly two children were spawned over HTTP (root->child, child->grandchild);
      // the depth-0 root row is createRoot's own ledger entry, not a spawn.
      const spawned = h.spawns.listSpawnTree(root.spawn_tree_id).spawns.filter((s) => s.depth > 0 && s.child_lease_id);
      expect(spawned.length).toBe(2);
    } finally {
      cleanup(h, server);
    }
  }, 30_000);

  it('L1 control-plane outage is non-fatal: the mock exits 0 and creates no child', async () => {
    // Point the control URL at a guaranteed-closed port. The mock's self-spawn
    // fetch fails (connection refused); it logs and exits 0 (echo work done),
    // holding no runtime semaphore permit and not failing the maker gate.
    const port = await closedPort();
    process.env.DJIMITFLO_CONTROL_URL = `http://127.0.0.1:${port}/api/swarms/spawns`;
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = h.root;
      const exec = await h.loops.executeMaker(h.loopRunId, { lease_id: root.root_lease_id });
      expect(exec.gates).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'pass' }),
      ]));
      const stdout = fs.readFileSync(exec.stdout_path, 'utf8');
      expect(stdout).toContain('control-plane call failed');
      // No child was spawned over HTTP — only the depth-0 root ledger row exists.
      const spawned = h.spawns.listSpawnTree(root.spawn_tree_id).spawns.filter((s) => s.depth > 0 && s.child_lease_id);
      expect(spawned.length).toBe(0);
    } finally {
      cleanup(h);
    }
  }, 30_000);

  it('L3: a token-only child can POST /spawns but cannot POST /spawns/root', async () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    const { server, baseUrl } = await startServer(h.db);
    const api = `${baseUrl}/api/swarms/spawns`;
    try {
      const root = h.root;
      // Mint the root's own scoped token (as buildNestedSpawnEnv would for a child).
      const token = h.spawns.mintSpawnToken(root.root_lease_id, root.spawn_tree_id);

      // 1. Token-only POST /spawns → 201 prepared (the real control-loop call).
      const ok = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Spawn-Token': token },
        body: JSON.stringify({
          requested_by_lease_id: root.root_lease_id,
          parent_lease_id: root.root_lease_id,
          spawn_tree_id: root.spawn_tree_id,
          role: 'maker',
          runtime: 'mock',
          prompt: 'token-only child via HTTP',
        }),
      });
      expect(ok.status).toBe(201);

      // 2. Neither header → 401 AUTH_REQUIRED (not anonymous).
      const none = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spawn_tree_id: root.spawn_tree_id, parent_lease_id: root.root_lease_id, requested_by_lease_id: root.root_lease_id }),
      });
      expect(none.status).toBe(401);
      expect((await none.json()).error.code).toBe('AUTH_REQUIRED');

      // 3. A malformed Bearer must NOT fall through to the spawn token → 401 AUTH_INVALID.
      const badBearer = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer garbage.token.here' },
        body: JSON.stringify({ spawn_tree_id: root.spawn_tree_id, parent_lease_id: root.root_lease_id, requested_by_lease_id: root.root_lease_id, token: 'x' }),
      });
      expect(badBearer.status).toBe(401);
      expect((await badBearer.json()).error.code).toBe('AUTH_INVALID');

      // 4. The HTTP route must not trust body.internal=true; an invalid token is
      // still rejected instead of getting the same-process service bypass.
      const fakeInternal = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Spawn-Token': 'garbage.token' },
        body: JSON.stringify({
          internal: true,
          requested_by_lease_id: root.root_lease_id,
          parent_lease_id: root.root_lease_id,
          spawn_tree_id: root.spawn_tree_id,
          role: 'maker',
          runtime: 'mock',
          prompt: 'body internal must not bypass HTTP token validation',
        }),
      });
      expect(fakeInternal.status).toBe(401);
      expect((await fakeInternal.json()).error.code).toBe('SPAWN_TOKEN_INVALID');

      const created = await ok.json() as any;
      const childStatus = await fetch(`${api}/${created.child_lease_id}/status`, {
        headers: { 'X-Spawn-Token': created.control_token },
      });
      expect(childStatus.status).toBe(200);
      const wrongStatusToken = await fetch(`${api}/${created.child_lease_id}/status`, {
        headers: { 'X-Spawn-Token': token },
      });
      expect(wrongStatusToken.status).toBe(401);
      expect((await wrongStatusToken.json()).error.code).toBe('SPAWN_TOKEN_INVALID');

      // 5. Token-only caller cannot create a root (operator-only via write:swarm_action).
      const rootAttempt = await fetch(`${api}/root`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Spawn-Token': token },
        body: JSON.stringify({ loop_run_id: h.loopRunId, runtime: 'mock', role: 'maker', prompt: 'rogue root', depth_budget: 2 }),
      });
      expect(rootAttempt.status).toBe(401);
    } finally {
      cleanup(h, server);
    }
  });

  it('C1: a live capability bound to the root is injected into the maker env as DJIMITFLO_CAPABILITIES', async () => {
    // Register a LIVE capability (validated, eval above threshold, all required
    // fields) so buildCapabilityManifest includes it. createRoot stores the
    // capability_ids in the root lease metadata (prepareNestedLease does not
    // validate them); buildNestedSpawnEnv re-reads them at executeMaker time and
    // injects DJIMITFLO_CAPABILITIES into the real spawn env. The mock logs
    // `capabilities=<count>`, proving the manifest reached the child env.
    const capId = 'cap-nested-loop-injection-test';
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000, capabilityIds: [capId] });
    const { server, baseUrl } = await startServer(h.db);
    process.env.DJIMITFLO_CONTROL_URL = `${baseUrl}/api/swarms/spawns`;
    try {
      // The capability was registered before createRoot (in setupHarness), so it
      // is live at prepare time and at executeMaker time.
      expect(h.intelligence.getCapability(capId).live_route_allowed).toBe(true);

      const rootExec = await h.loops.executeMaker(h.loopRunId, { lease_id: h.root.root_lease_id });
      const stdout = fs.readFileSync(rootExec.stdout_path, 'utf8');
      expect(stdout).toContain('[mock-worker] starting');
      expect(stdout).toContain('[mock-worker] capabilities=1');

      // The assignment packet (writeAssignmentPacket) also carries the manifest.
      const rootLease = h.loops.getWorkerLeasePublic(h.root.root_lease_id);
      const packetPath = rootLease.metadata?.assignment_packet_file as string;
      expect(packetPath).toBeTruthy();
      const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      expect(Array.isArray(packet.capabilities)).toBe(true);
      expect(packet.capabilities).toHaveLength(1);
      expect(packet.capabilities[0]).toMatchObject({ id: capId, kind: 'skill', risk_ceiling: 'medium' });
    } finally {
      cleanup(h, server);
    }
  }, 30_000);

  it('C2: a fake claude runtime self-spawns a child over real HTTP (non-mock runtime follows the control loop)', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-fake-claude-'));
    process.env.CLAUDE_BIN_PATH = writeFakeClaudeBin(binDir);
    try {
      const h = setupHarness({ depthBudget: 1, tokenBudget: 1_000_000, runtime: 'claude' });
      const { server, baseUrl } = await startServer(h.db);
      process.env.DJIMITFLO_CONTROL_URL = `${baseUrl}/api/swarms/spawns`;
      try {
        // The root maker runs the fake claude bin (real spawn, real cwd boundary,
        // real nested-spawn env). It emits a verdict + usage JSON and self-spawns
        // a depth-1 child over HTTP with runtime 'claude'.
        const rootExec = await h.loops.executeMaker(h.loopRunId, { lease_id: h.root.root_lease_id });
        expect(rootExec.gates).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'pass' }),
        ]));
        const stdout = fs.readFileSync(rootExec.stdout_path, 'utf8');
        expect(stdout).toContain('"verdict":"accepted"');
        expect(stdout).toContain('[fake-claude] spawn POST status=201');

        // A depth-1 child was spawned over HTTP with runtime claude — the spawn
        // route accepts the new runtime and the parentage/lineage is real.
        const child = h.spawns.listSpawnTree(h.root.spawn_tree_id).spawns.find(
          (s) => s.depth === 1 && s.child_lease_id,
        );
        expect(child).toBeTruthy();
        const childLease = h.loops.getWorkerLeasePublic(child!.child_lease_id);
        expect(childLease.runtime).toBe('claude');
        expect(childLease.parent_lease_id).toBe(h.root.root_lease_id);
        expect(childLease.spawn_tree_id).toBe(h.root.spawn_tree_id);
      } finally {
        cleanup(h, server);
      }
    } finally {
      delete process.env.CLAUDE_BIN_PATH;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});
