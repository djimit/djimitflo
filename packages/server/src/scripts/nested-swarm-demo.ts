/**
 * `npx tsx src/scripts/nested-swarm-demo.ts` — proves the nested-spawn control
 * loop is REAL, not structural (L1/L2/L3).
 *
 * It boots a REAL Express server on an ephemeral port (createRoutes, the same
 * routes the production server mounts), arms a spawn tree with depth_budget=2,
 * launches a mock root via LoopService.executeMaker, and lets the mock
 * self-spawn over real HTTP: root → child (d1) → grandchild (d2). The grandchild
 * is at the depth floor and is NOT armed, so it runs echo-only and exits 0
 * (legitimate terminal state). It then prints the spawn-tree ledger.
 *
 * Honest caveat: the mock runtime's *work* is `console.log` echo; the
 * *spawning, gates, budget, audit, and the HTTP round-trip* are real. Only the
 * "what the agent actually does" is faked. This is the same honesty L4 (real
 * claude/gemini/editor runtimes + discussion protocol) will replace later.
 *
 * No external CLIs are required — the mock is self-contained Node.
 */
import express from 'express';
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

function makeTempRepo(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-nested-demo-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document the spawn bridge\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'nested-demo@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Nested Demo'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial demo repo'], { cwd: tempDir, stdio: 'ignore' });
  return tempDir;
}

async function main() {
  // Deterministic shared HMAC secret so the in-process LoopService minter and
  // the server's NestedSpawnService validator agree. Value has spaces so it
  // does not trip the repo's secret-scan pre-commit hook if this file is ever
  // committed alongside a real secret value.
  process.env.DJIMITFLO_SPAWN_TOKEN_SECRET = 'spaced demo secret value here';
  delete process.env.SPAWN_DEPTH_BUDGET;
  process.env.SPAWN_DEPTH_BUDGET = '2';

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  const tempDir = makeTempRepo();
  const worktreeRoot = path.join(os.tmpdir(), `.djimitflo-nested-demo-worktrees-${path.basename(tempDir)}`);
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;

  const loops = new LoopService(db);
  const run = loops.startLoop({ repository_path: tempDir });
  const intelligence = new SwarmIntelligenceService(db);
  const spawns = new NestedSpawnService(db, loops, { intelligence, controlUrl: 'http://127.0.0.1:0/api/swarms/spawns' });

  // Boot a REAL Express server with the production routes (auth + spawn token
  // path mounted at /swarms/spawns before /swarms).
  const authService = new AuthService(db);
  const auth = createAuthMiddleware(authService);
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(db, undefined, authService, auth, undefined));
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.DJIMITFLO_CONTROL_URL = `${baseUrl}/api/swarms/spawns`;

  try {
    console.log('\n=== Nested-swarm control loop demo (L1 real / L2 budget / L3 token-or-user auth) ===');
    console.log(`real server: ${baseUrl}/api/swarms/spawns  (depth_budget=2)\n`);

    const root = spawns.createRoot({
      loop_run_id: run.id,
      runtime: 'mock',
      role: 'maker',
      prompt: 'root: scan the repo for small fixes',
      depth_budget: 2,
      total_token_budget: 1_000_000,
      total_wall_budget_ms: 10_000_000,
      max_concurrent_children: 20,
      risk_class: 'medium',
    });
    console.log(`root  d0  lease=${root.root_lease_id}  tree=${root.spawn_tree_id}  (armed: depth<2)`);

    // Launch root → it self-spawns a depth-1 child over real HTTP.
    const rootExec = await loops.executeMaker(run.id, { lease_id: root.root_lease_id });
    const child = spawns.listSpawnTree(root.spawn_tree_id).spawns.find(
      (s) => s.parent_lease_id === root.root_lease_id && s.depth === 1,
    );
    console.log(`child  d1  lease=${child?.child_lease_id ?? '-'}  (spawned over HTTP: ${rootExec.gates.find((g) => g.name === 'maker_runtime_exit_zero')?.status})`);

    // Launch child (d1, armed) → it self-spawns a depth-2 grandchild over HTTP.
    if (child?.child_lease_id) {
      await loops.executeMaker(run.id, { lease_id: child.child_lease_id });
      const grandchild = spawns.listSpawnTree(root.spawn_tree_id).spawns.find(
        (s) => s.parent_lease_id === child.child_lease_id && s.depth === 2,
      );
      console.log(`grandchild  d2  lease=${grandchild?.child_lease_id ?? '-'}  (spawned over HTTP)`);

      // Launch grandchild (d2 == depth_budget): NOT armed → echo-only, exit 0.
      // It must NOT spawn a great-grandchild (the depth gate would reject it,
      // but a cooperative mock never even tries because it is not armed).
      if (grandchild?.child_lease_id) {
        const gcExec = await loops.executeMaker(run.id, { lease_id: grandchild.child_lease_id });
        const great = spawns.listSpawnTree(root.spawn_tree_id).spawns.find((s) => s.depth === 3);
        console.log(`grandchild d2 ran echo-only, exit=${gcExec.gates.find((g) => g.name === 'maker_runtime_exit_zero')?.status}, great-grandchild=${great ? 'SPAWNED' : 'none (depth floor respected)'}`);
      }
    }

    // Print the real spawn-tree ledger.
    const { tree, spawns: rows } = spawns.listSpawnTree(root.spawn_tree_id);
    console.log('\n--- spawn tree ledger (real DB rows) ---');
    console.log(`tree ${tree?.id}: depth_budget=${tree?.depth_budget} status=${tree?.status} consumed_tokens=${tree?.consumed_tokens}/${tree?.total_token_budget}`);
    for (const s of rows.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
      console.log(`  d${s.depth}  ${s.status.padEnd(10)} parent=${s.parent_lease_id?.slice(0, 8)} lease=${s.child_lease_id?.slice(0, 8) ?? '-'}`);
    }

    const httpSpawned = rows.filter((s) => (s.depth ?? 0) > 0 && s.child_lease_id).length;
    console.log(`\nHTTP-spawned children (depth>0): ${httpSpawned}  (expected 2: root->child, child->grandchild)`);
    console.log('\nHonest caveat: the mock runtime\'s *work* is echo (console.log). The *spawning,');
    console.log('gates, budget, audit, and the HTTP round-trip above are real. L4 (real runtimes +');
    console.log('discussion protocol) replaces the echo with real agent work later.\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    delete process.env.LOOP_WORKTREE_ROOT;
    delete process.env.DJIMITFLO_CONTROL_URL;
    delete process.env.DJIMITFLO_SPAWN_TOKEN_SECRET;
  }
}

main().catch((error) => {
  console.error('nested-swarm-demo failed:', error);
  process.exit(1);
});