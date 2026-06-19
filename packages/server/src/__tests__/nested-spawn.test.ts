import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

interface Harness {
  db: Database.Database;
  loops: LoopService;
  spawns: NestedSpawnService;
  intelligence: SwarmIntelligenceService;
  tempDir: string;
  worktreeRoot: string;
  loopRunId: string;
}

function setupHarness(overrides: { depthBudget?: number; tokenBudget?: number; wallBudgetMs?: number; maxConcurrent?: number; riskClass?: 'low' | 'medium' | 'high' | 'critical' } = {}): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-nested-'));
  const worktreeRoot = path.join(os.tmpdir(), `.djimitflo-nested-worktrees-${path.basename(tempDir)}`);
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;

  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document the spawn bridge\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'nested-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Nested Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

  const loops = new LoopService(db);
  const run = loops.startLoop({ repository_path: tempDir });
  const intelligence = new SwarmIntelligenceService(db);
  const spawns = new NestedSpawnService(db, loops, { intelligence, controlUrl: 'http://control.test.local/api/swarms/spawns' });

  const root = spawns.createRoot({
    loop_run_id: run.id,
    runtime: 'mock',
    role: 'maker',
    prompt: 'root: scan the repo for small fixes',
    depth_budget: overrides.depthBudget,
    total_token_budget: overrides.tokenBudget,
    total_wall_budget_ms: overrides.wallBudgetMs ?? 10_000_000,
    max_concurrent_children: overrides.maxConcurrent ?? 20,
    risk_class: overrides.riskClass ?? 'medium',
  });

  return { db, loops, spawns, intelligence, tempDir, worktreeRoot, loopRunId: run.id, ...({ root } as any) } as any;
}

function spawnChild(h: Harness, parentId: string, opts: { role?: any; prompt?: string; capabilityIds?: string[]; internal?: boolean; token?: string } = {}) {
  return h.spawns.requestSpawn({
    spawn_tree_id: (h as any).root.spawn_tree_id,
    parent_lease_id: parentId,
    requested_by_lease_id: parentId,
    role: opts.role ?? 'checker',
    runtime: 'mock',
    prompt: opts.prompt ?? `child task ${Math.random().toString(36).slice(2)}`,
    capability_ids: opts.capabilityIds,
    token: opts.token,
  }, { internal: opts.internal ?? true });
}

describe('nested-spawn-service (P1 gates)', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SPAWN_DEPTH_BUDGET;
    delete process.env.SPAWN_TREE_TOKEN_BUDGET;
    delete process.env.SPAWN_TREE_WALL_BUDGET_MS;
    delete process.env.SPAWN_TREE_MAX_CONCURRENT_CHILDREN;
  });

  afterEach(() => {
    // restore env without mutating the captured reference
    for (const k of Object.keys(process.env)) {
      if (!(k in previousEnv)) delete (process.env as any)[k];
    }
    Object.assign(process.env, previousEnv);
  });

  function cleanup(h: Harness) {
    h.db.close();
    fs.rmSync(h.tempDir, { recursive: true, force: true });
    fs.rmSync(h.worktreeRoot, { recursive: true, force: true });
    delete process.env.LOOP_WORKTREE_ROOT;
  }

  it('default-deny: depth_budget 0 rejects the first child (depth_budget_exceeded)', () => {
    const h = setupHarness(); // no depthBudget → defaults to 0 (env unset)
    try {
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { prompt: 'first child' });
      expect(child.status).toBe('gated_out');
      expect(child.reject_reason).toBe('depth_budget_exceeded');
      expect(child.child_lease_id).toBeNull();
    } finally {
      cleanup(h);
    }
  });

  it('depth 2: child + grandchild prepared, great-grandchild gated by depth', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { role: 'maker', prompt: 'child A task' });
      expect(child.status).toBe('prepared');
      expect(child.depth).toBe(1);

      const grandchild = spawnChild(h, child.child_lease_id!, { role: 'checker', prompt: 'grandchild task' });
      expect(grandchild.status).toBe('prepared');
      expect(grandchild.depth).toBe(2);

      // Grandchild is at the depth floor (2); its own child would be depth 3 > 2.
      const great = spawnChild(h, grandchild.child_lease_id!, { role: 'maker', prompt: 'great-grandchild task' });
      expect(great.status).toBe('gated_out');
      expect(great.reject_reason).toBe('depth_budget_exceeded');
    } finally {
      cleanup(h);
    }
  });

  it('cycle guard: same prompt + role as an ancestor is rejected', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root; // role maker, prompt "root: scan the repo for small fixes"
      const child = spawnChild(h, root.root_lease_id, { role: 'maker', prompt: 'root: scan the repo for small fixes' });
      expect(child.status).toBe('gated_out');
      expect(child.reject_reason).toBe('cycle_detected');
    } finally {
      cleanup(h);
    }
  });

  it('token budget: deeper spawns are gated once the tree budget is exhausted', () => {
    // depth_budget=5 makes the wall per-depth cap loose enough that the token
    // cap (tokenBudget=2, perDepthTokenCap=max(1,floor(2/6))=1) is the binding
    // constraint: 2 children consume 2 tokens, the 3rd is gated.
    const h = setupHarness({ depthBudget: 5, tokenBudget: 2, maxConcurrent: 20 });
    try {
      const root = (h as any).root;
      const c1 = spawnChild(h, root.root_lease_id, { prompt: 't1' });
      const c2 = spawnChild(h, root.root_lease_id, { prompt: 't2' });
      expect([c1, c2].every((c) => c.status === 'prepared')).toBe(true);
      const c3 = spawnChild(h, root.root_lease_id, { prompt: 't3' });
      expect(c3.status).toBe('gated_out');
      expect(c3.reject_reason).toBe('token_budget_exceeded');
    } finally {
      cleanup(h);
    }
  });

  it('capability routing: a non-live (draft) capability is gated out', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      h.intelligence.registerCapability({
        id: 'cap-draft', kind: 'skill', owner: 'test', version: '0.1.0', status: 'draft',
        risk_ceiling: 'medium', input_schema_ref: 'in', output_schema_ref: 'out',
        allowed_actions: ['maker:mock'], forbidden_actions: ['checker:codex'], required_evidence: ['proof'],
        removal_strategy: 'archive',
      });
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { capabilityIds: ['cap-draft'], prompt: 'use draft cap' });
      expect(child.status).toBe('gated_out');
      expect(child.reject_reason).toBe('capability_not_live');
    } finally {
      cleanup(h);
    }
  });

  it('capability routing: a live capability that forbids the action is gated out', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      h.intelligence.registerCapability({
        id: 'cap-live', kind: 'skill', owner: 'test', version: '1.0.0', status: 'validated',
        risk_ceiling: 'high', input_schema_ref: 'in', output_schema_ref: 'out',
        allowed_actions: ['planner:mock'], forbidden_actions: ['maker:mock'], required_evidence: ['proof'],
        removal_strategy: 'archive', eval_score: 0.9, eval_threshold: 0.75,
      });
      const root = (h as any).root;
      // root role is maker; spawn a maker child → action maker:mock is forbidden.
      const child = spawnChild(h, root.root_lease_id, { role: 'maker', capabilityIds: ['cap-live'], prompt: 'use live cap' });
      expect(child.status).toBe('gated_out');
      expect(child.reject_reason).toBe('capability_action_forbidden');
    } finally {
      cleanup(h);
    }
  });

  it('per-tree concurrency cap: a second in-flight child is gated when max_concurrent_children=1', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000, maxConcurrent: 1 });
    try {
      const root = (h as any).root;
      const c1 = spawnChild(h, root.root_lease_id, { prompt: 'concurrent-1' });
      expect(c1.status).toBe('prepared');
      const c2 = spawnChild(h, root.root_lease_id, { prompt: 'concurrent-2' });
      expect(c2.status).toBe('gated_out');
      expect(c2.reject_reason).toBe('concurrency_exceeded');
    } finally {
      cleanup(h);
    }
  });

  it('isolation: a prepared child gets its own worktree, separate from the main repo', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { prompt: 'isolated child' });
      expect(child.status).toBe('prepared');
      const lease = h.loops.getWorkerLeasePublic(child.child_lease_id!);
      expect(lease.worktree_path).toBeTruthy();
      expect(path.resolve(lease.worktree_path!)).not.toBe(path.resolve(h.tempDir));
      expect(fs.existsSync(lease.worktree_path!)).toBe(true);
      expect(lease.spawn_tree_id).toBe(root.spawn_tree_id);
      expect(lease.parent_lease_id).toBe(root.root_lease_id);
      expect(lease.depth).toBe(1);
    } finally {
      cleanup(h);
    }
  });

  it('spawn token: a valid scoped token permits an external (non-internal) spawn', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      const token = h.spawns.mintSpawnToken(root.root_lease_id, root.spawn_tree_id);
      const child = spawnChild(h, root.root_lease_id, { prompt: 'external child', internal: false, token });
      expect(child.status).toBe('prepared');
    } finally {
      cleanup(h);
    }
  });

  it('spawn token: an invalid / wrong-scoped token is rejected (SPAWN_TOKEN_INVALID)', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      expect(() => spawnChild(h, root.root_lease_id, { prompt: 'bad token', internal: false, token: 'garbage.token' })).toThrow(/SPAWN_TOKEN_INVALID/);
      // A token scoped to a different lease is also rejected.
      const otherToken = h.spawns.mintSpawnToken('some-other-lease', root.spawn_tree_id);
      expect(() => spawnChild(h, root.root_lease_id, { prompt: 'wrong scope', internal: false, token: otherToken })).toThrow(/SPAWN_TOKEN_INVALID/);
    } finally {
      cleanup(h);
    }
  });

  it('getSpawnStatus returns the prepared row for a child lease', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { prompt: 'status child' });
      const status = h.spawns.getSpawnStatus(child.child_lease_id!);
      expect(status.status).toBe('prepared');
      expect(status.depth).toBe(1);
      expect(status.runtime).toBe('mock');
    } finally {
      cleanup(h);
    }
  });

  it('listSpawnTree returns the full ancestry ledger', () => {
    const h = setupHarness({ depthBudget: 2, tokenBudget: 1_000_000 });
    try {
      const root = (h as any).root;
      const child = spawnChild(h, root.root_lease_id, { role: 'maker', prompt: 'ledger child' });
      const grandchild = spawnChild(h, child.child_lease_id!, { role: 'checker', prompt: 'ledger grandchild' });
      const { tree, spawns } = h.spawns.listSpawnTree(root.spawn_tree_id);
      expect(tree).not.toBeNull();
      expect(tree!.depth_budget).toBe(2);
      // root (depth 0) + child (1) + grandchild (2).
      expect(spawns.filter((s) => s.status === 'prepared').length).toBeGreaterThanOrEqual(3);
      expect(spawns.find((s) => s.child_lease_id === grandchild.child_lease_id)?.depth).toBe(2);
    } finally {
      cleanup(h);
    }
  });
});