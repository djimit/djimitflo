/**
 * NestedSpawnService — the gated entrypoint for nested multi-agent spawning (P1).
 *
 * A spawned runtime child has no built-in way to create children of its own. This
 * service is that path: an operator-armed swarm root is created via `createRoot`,
 * and the root (and any depth-permitted descendant) can spawn sub-agents by calling
 * `requestSpawn` — directly (orchestrator/demo/tests) or over the HTTP control
 * endpoint (a real codex/claude child shells out to `curl` with its scoped token).
 *
 * Every spawn is gated, audited, and budget-accounted — no theater:
 *   - depth budget (operator env `SPAWN_DEPTH_BUDGET`, default 0 = OFF, default-deny,
 *     mirroring RUNTIME_ALLOW_SKIP_PERMISSIONS);
 *   - cycle guard (same prompt_digest + role on the ancestry chain is rejected);
 *   - cumulative per-tree token + wall budget (deeper = tighter grant);
 *   - capability routing (bound capabilities must be `live_route_allowed` and not
 *     forbid the `${role}:${runtime}` action, with the tree risk within the cap);
 *   - per-tree concurrency cap (in-flight children bounded, P2 limiter).
 *
 * The actual worktree + lease materialization is delegated to LoopService's
 * `prepareNestedLease` (reuses createWorktree / writeWorkAssignment /
 * writeAssignmentPacket / insertWorkerLease unchanged), so a nested child is a real
 * `worker_leases` row with real `parent_lease_id / spawn_tree_id / depth` lineage.
 *
 * No-theater caveat: this service makes the *spawning + audit* real. Whether a child
 * *process* actually runs and self-spawns depends on the runtime — mock echoes
 * (no self-spawn); codex/claude shell out to the control endpoint. The gates are
 * exercised the same way regardless of runtime, which is what the tests cover.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { WebSocketEventType, type WebSocketMessage, type SwarmSpawnEventPayload } from '@djimitflo/shared';
import { LoopService, type WorkerLeaseRecord, type WorkerRole } from './loop-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import type { WebSocketService } from './websocket-service';
import {
  mintSpawnToken as mintScopedSpawnToken,
  validateSpawnToken as validateScopedSpawnToken,
  resolveSpawnTokenSecret,
} from './spawn-token';

type RuntimeKind = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'mock';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';

const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const VALID_RUNTIMES: RuntimeKind[] = ['codex', 'opencode', 'claude', 'gemini', 'editor', 'manual', 'mock'];
const VALID_ROLES: WorkerRole[] = ['planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard'];

export interface SpawnTreeRecord {
  id: string;
  depth_budget: number;
  total_token_budget: number;
  consumed_tokens: number;
  total_wall_budget_ms: number;
  consumed_wall_ms: number;
  reserved_tokens: number;
  reserved_wall_ms: number;
  measured_tokens: number;
  measured_wall_ms: number;
  max_concurrent_children: number;
  risk_class: RiskClass;
  context_budget: number;
  context_consumed: number;
  status: string;
  started_at: string;
  updated_at: string;
}

export interface SubAgentSpawnRecord {
  id: string;
  spawn_tree_id: string;
  parent_lease_id: string | null;
  child_lease_id: string | null;
  requested_by_lease_id: string;
  depth: number;
  runtime: string;
  requested_role: string;
  prompt_digest: string;
  planned_lease_id?: string | null;
  idempotency_key?: string | null;
  request_fingerprint?: string | null;
  status: 'requested' | 'gated_out' | 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled';
  reject_reason: string | null;
  token_budget_grant: number | null;
  wall_budget_ms: number | null;
  created_at: string;
}

export interface CreateRootInput {
  loop_run_id: string;
  runtime: RuntimeKind;
  role: WorkerRole;
  prompt: string;
  capability_ids?: string[];
  depth_budget?: number;
  total_token_budget?: number;
  total_wall_budget_ms?: number;
  max_concurrent_children?: number;
  risk_class?: RiskClass;
  context_budget?: number; // Per-sub-agent context token budget (0 = no isolation)
}

export interface CreateRootResult {
  root_lease_id: string;
  spawn_tree_id: string;
  depth_budget: number;
  control_url: string;
  control_token: string;
  assignment_path: string;
}

export interface RequestSpawnInput {
  spawn_tree_id: string;
  parent_lease_id: string;
  requested_by_lease_id: string;
  role: WorkerRole;
  runtime: RuntimeKind;
  prompt: string;
  capability_ids?: string[];
  idempotency_key?: string;
  token?: string; // required when invoked over HTTP (external); omitted for internal calls
}

export interface RequestSpawnResult {
  spawn_id: string;
  spawn_tree_id: string;
  parent_lease_id: string;
  child_lease_id: string | null;
  depth: number;
  status: 'requested' | 'prepared' | 'gated_out' | 'running' | 'completed' | 'failed' | 'cancelled';
  reject_reason?: string;
  token_budget_grant?: number;
  wall_budget_ms?: number;
  control_url?: string;
  control_token?: string;
}

export interface NestedSpawnServiceOptions {
  wsService?: WebSocketService;
  intelligence?: SwarmIntelligenceService;
  secret?: string;
  controlUrl?: string;
}

const DEFAULT_DEPTH_BUDGET = 0; // OFF by default (default-deny).
const DEFAULT_TOKEN_BUDGET = 200_000;
const DEFAULT_WALL_BUDGET_MS = 600_000;
const DEFAULT_MAX_CONCURRENT_CHILDREN = 4;

export class NestedSpawnService {
  private readonly db: Database;
  private readonly loops: LoopService;
  private readonly intelligence: SwarmIntelligenceService;
  private readonly wsService?: WebSocketService;
  private readonly secret: string;
  private readonly controlUrl: string;

  constructor(db: Database, loops: LoopService, options: NestedSpawnServiceOptions = {}) {
    this.db = db;
    this.loops = loops;
    this.intelligence = options.intelligence ?? new SwarmIntelligenceService(db);
    this.wsService = options.wsService;
    this.secret = options.secret || resolveSpawnTokenSecret();
    this.controlUrl = options.controlUrl
      || process.env.DJIMITFLO_CONTROL_URL
      || '';
  }

  // --- public API ---

  createRoot(input: CreateRootInput): CreateRootResult {
    this.assertRuntime(input.runtime);
    this.assertRole(input.role);
    if (!input.prompt?.trim()) throw new Error('SPAWN_PROMPT_REQUIRED');
    // Confirm the loop run exists (prepareNestedLease will read it again).
    this.loops.assertOperatorNotPaused(this.loops.getLoopRun(input.loop_run_id));

    const depthBudget = input.depth_budget ?? this.envInt('SPAWN_DEPTH_BUDGET', DEFAULT_DEPTH_BUDGET);
    const totalTokenBudget = input.total_token_budget ?? this.envInt('SPAWN_TREE_TOKEN_BUDGET', DEFAULT_TOKEN_BUDGET);
    const totalWallBudgetMs = input.total_wall_budget_ms ?? this.envInt('SPAWN_TREE_WALL_BUDGET_MS', DEFAULT_WALL_BUDGET_MS);
    const maxConcurrent = input.max_concurrent_children ?? this.envInt('SPAWN_TREE_MAX_CONCURRENT_CHILDREN', DEFAULT_MAX_CONCURRENT_CHILDREN);
    const riskClass = input.risk_class ?? 'medium';
    const contextBudget = input.context_budget ?? this.envInt('SPAWN_CONTEXT_BUDGET', 0); // 0 = no isolation (backward-compatible)
    if (depthBudget > 0 && (totalTokenBudget < 2 || totalWallBudgetMs < 2_000)) {
      throw new Error('SPAWN_TREE_BUDGET_TOO_SMALL_FOR_NESTED_WORK');
    }
    const rootTokenCeiling = Math.max(1, this.envInt('SPAWN_PER_DEPTH_TOKEN_CAP', 50_000));
    const rootWallCeiling = Math.max(1_000, this.envInt('SPAWN_PER_DEPTH_WALL_CAP_MS', 120_000));
    const rootTokenGrant = Math.min(totalTokenBudget, depthBudget > 0 ? Math.max(1, Math.floor(totalTokenBudget / 2)) : totalTokenBudget, rootTokenCeiling);
    const rootWallGrant = Math.min(totalWallBudgetMs, depthBudget > 0 ? Math.max(1_000, Math.floor(totalWallBudgetMs / 2)) : totalWallBudgetMs, rootWallCeiling);

    // The spawn tree id IS the root lease id (plan invariant), so the root's own
    // spawn token — scoped to (rootLeaseId, treeId) — validates when the root
    // later calls requestSpawn with requested_by_lease_id = rootLeaseId.
    const treeId = randomUUID();
    const controlToken = this.mintSpawnToken(treeId, treeId);
    const allowNestedSpawn = depthBudget > 0;

    const prepared = this.loops.prepareNestedLease({
      loopRunId: input.loop_run_id,
      role: input.role,
      runtime: input.runtime,
      prompt: input.prompt,
      capabilityIds: input.capability_ids,
      parentLeaseId: null,
      spawnTreeId: treeId,
      depth: 0,
      allowNestedSpawn,
      controlUrl: this.controlUrl,
      spawnToken: allowNestedSpawn ? controlToken : undefined,
      depthBudget,
      tokenBudgetGrant: rootTokenGrant,
      wallBudgetGrantMs: rootWallGrant,
      leaseId: treeId,
    });

    const now = new Date().toISOString();
    // Backward-compatible INSERT: include context columns only if they exist (additive migration).
    const cols = this.db.prepare("PRAGMA table_info(spawn_trees)").all() as Array<{ name: string }>;
    const hasContextBudget = cols.some((c) => c.name === 'context_budget');

    this.db.transaction(() => {
      if (hasContextBudget) {
        this.db.prepare(`
          INSERT INTO spawn_trees (
            id, depth_budget, total_token_budget, consumed_tokens, total_wall_budget_ms,
            consumed_wall_ms, max_concurrent_children, risk_class, context_budget, context_consumed, status, started_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?, 0, 'open', ?, ?)
        `).run(treeId, depthBudget, totalTokenBudget, totalWallBudgetMs, maxConcurrent, riskClass, contextBudget, now, now);
      } else {
        this.db.prepare(`
          INSERT INTO spawn_trees (
            id, depth_budget, total_token_budget, consumed_tokens, total_wall_budget_ms,
            consumed_wall_ms, max_concurrent_children, risk_class, status, started_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, 0, ?, ?, 'open', ?, ?)
        `).run(treeId, depthBudget, totalTokenBudget, totalWallBudgetMs, maxConcurrent, riskClass, now, now);
      }
      this.db.prepare('UPDATE spawn_trees SET reserved_tokens = ?, reserved_wall_ms = ? WHERE id = ?').run(rootTokenGrant, rootWallGrant, treeId);
      // Record the root as an edge so ancestry and settlement use one lifecycle.
      this.insertSpawnRow({
        id: randomUUID(), spawn_tree_id: treeId, parent_lease_id: null, child_lease_id: prepared.leaseId,
        requested_by_lease_id: prepared.leaseId, depth: 0, runtime: input.runtime, requested_role: input.role,
        prompt_digest: this.promptDigest(input.role, input.prompt, input.capability_ids), status: 'prepared', reject_reason: null,
        token_budget_grant: rootTokenGrant, wall_budget_ms: rootWallGrant, now,
      });
    })();

    this.emit(WebSocketEventType.SWARM_SPAWN_PREPARED, {
      spawn_id: treeId,
      spawn_tree_id: treeId,
      parent_lease_id: null,
      child_lease_id: prepared.leaseId,
      depth: 0,
      runtime: input.runtime,
      role: input.role,
      status: 'prepared',
    });

    return {
      root_lease_id: prepared.leaseId,
      spawn_tree_id: treeId,
      depth_budget: depthBudget,
      control_url: this.controlUrl,
      control_token: controlToken,
      assignment_path: prepared.assignmentPath,
    };
  }

  requestSpawn(input: RequestSpawnInput, opts: { internal?: boolean } = {}): RequestSpawnResult {
    this.assertRuntime(input.runtime);
    this.assertRole(input.role);
    if (!input.prompt?.trim()) throw new Error('SPAWN_PROMPT_REQUIRED');

    const spawnId = randomUUID();
    const now = new Date().toISOString();
    const promptDigest = this.promptDigest(input.role, input.prompt, input.capability_ids);
    if (input.idempotency_key !== undefined && typeof input.idempotency_key !== 'string') {
      throw new Error('SPAWN_IDEMPOTENCY_KEY_INVALID');
    }
    const idempotencyKey = input.idempotency_key?.trim() || null;
    if (idempotencyKey && (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))) {
      throw new Error('SPAWN_IDEMPOTENCY_KEY_INVALID');
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      spawn_tree_id: input.spawn_tree_id,
      parent_lease_id: input.parent_lease_id,
      requested_by_lease_id: input.requested_by_lease_id,
      role: input.role,
      runtime: input.runtime,
      prompt_digest: promptDigest,
      capability_ids: [...(input.capability_ids ?? [])].sort(),
    })).digest('hex');

    // 1. Token gate. External (HTTP) callers must present a valid, unexpired token
    //    scoped to (requested_by_lease_id, spawn_tree_id). Internal calls (orchestrator,
    //    demo, tests) are same-process and bypass the token — the operator already
    //    authorized the tree at createRoot time.
    if (!opts.internal) {
      if (!input.token || !this.validateSpawnToken(input.token, input.requested_by_lease_id, input.spawn_tree_id)) {
        throw new Error('SPAWN_TOKEN_INVALID');
      }
    }

    // The spawning principal must be the parent (a child spawns its own children).
    if (input.requested_by_lease_id !== input.parent_lease_id) {
      throw new Error('SPAWN_TOKEN_INVALID');
    }

    if (idempotencyKey) {
      const existing = this.db.prepare(`SELECT * FROM sub_agent_spawns
        WHERE spawn_tree_id = ? AND parent_lease_id = ? AND idempotency_key = ?`).get(
        input.spawn_tree_id, input.parent_lease_id, idempotencyKey
      ) as any;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new Error('SPAWN_IDEMPOTENCY_CONFLICT');
        if (existing.status === 'requested') this.getSpawnStatus(existing.id, { internal: true });
        const current = this.db.prepare('SELECT * FROM sub_agent_spawns WHERE id = ?').get(existing.id) as any;
        return this.spawnReceipt(current);
      }
    }

    const tree = this.getSpawnTree(input.spawn_tree_id);
    if (!tree) throw new Error('SPAWN_TREE_NOT_FOUND');
    if (tree.status !== 'open') throw new Error('SPAWN_TREE_CLOSED');

    const parent = this.getWorkerLeaseRow(input.parent_lease_id);
    if (!parent) throw new Error('PARENT_LEASE_NOT_FOUND');
    if (parent.spawn_tree_id !== input.spawn_tree_id) throw new Error('SPAWN_TREE_MISMATCH');

    const depth = (parent.depth ?? 0) + 1;
    try {
      this.loops.assertOperatorNotPaused(this.loops.getLoopRun(parent.loop_run_id));
    } catch (error) {
      if ((error as { code?: string }).code !== 'LOOP_OPERATOR_PAUSED') throw error;
      return this.gateOut(spawnId, input, depth, promptDigest, 'operator_paused', now, idempotencyKey, requestFingerprint);
    }

    // 2. Depth budget gate.
    if (depth > tree.depth_budget) {
      return this.gateOut(spawnId, input, depth, promptDigest, 'depth_budget_exceeded', now, idempotencyKey, requestFingerprint);
    }

    // 3. Cycle guard: the same (prompt_digest, role) must not already appear on the
    //    ancestry chain from the parent up to the root.
    if (this.detectCycle(input.spawn_tree_id, input.parent_lease_id, promptDigest, input.role)) {
      return this.gateOut(spawnId, input, depth, promptDigest, 'cycle_detected', now, idempotencyKey, requestFingerprint);
    }

    // 4. Cumulative budget gate (deeper = tighter grant).
    const remainingTokens = tree.total_token_budget - tree.consumed_tokens - tree.reserved_tokens - tree.measured_tokens;
    if (remainingTokens <= 0) {
      return this.gateOut(spawnId, input, depth, promptDigest, 'token_budget_exceeded', now, idempotencyKey, requestFingerprint);
    }
    const remainingWall = tree.total_wall_budget_ms - tree.consumed_wall_ms - tree.reserved_wall_ms - tree.measured_wall_ms;
    if (remainingWall <= 0) {
      return this.gateOut(spawnId, input, depth, promptDigest, 'wall_budget_exceeded', now, idempotencyKey, requestFingerprint);
    }
    // Per-depth grant is a configurable admission ceiling (NOT total/(depth_budget+1), which
    // exhausted both budgets at exactly depth_budget+1 children). The cumulative
    // totals constrain reservations and admission, not provider-side token use;
    // wall time is also bounded by the existing executor timeout.
    const perDepthTokenCeiling = this.envInt('SPAWN_PER_DEPTH_TOKEN_CAP', 50_000);
    const perDepthWallCeiling = this.envInt('SPAWN_PER_DEPTH_WALL_CAP_MS', 120_000);
    const tokenGrant = Math.min(remainingTokens, Math.max(1, perDepthTokenCeiling));
    const wallGrant = Math.min(remainingWall, Math.max(1_000, perDepthWallCeiling));

    // 5. Capability routing: each bound capability must be live and must not forbid
    //    this action, and the tree risk must be within the capability's risk ceiling.
    const capabilityBlock = this.routeCapabilities(input.capability_ids, input.role, input.runtime, tree.risk_class as RiskClass);
    if (capabilityBlock) {
      return this.gateOut(spawnId, input, depth, promptDigest, capabilityBlock, now, idempotencyKey, requestFingerprint);
    }

    // 6. Per-tree concurrency cap (P2 limiter).
    const inFlight = this.countInFlight(input.spawn_tree_id);
    if (inFlight >= tree.max_concurrent_children) {
      return this.gateOut(spawnId, input, depth, promptDigest, 'concurrency_exceeded', now, idempotencyKey, requestFingerprint);
    }

    // 7. All gates passed — materialize the child lease + audit row.
    // A child may spawn its own children only while it is still above the depth
    // floor (depth < depth_budget). The control block is written by
    // prepareNestedLease and renders the token as `<redacted>` — the real token is
    // never written to the assignment file; it is returned here for the caller
    // (orchestrator/HTTP client) and, in real runtimes, injected via the
    // DJIMITFLO_SPAWN_TOKEN env var at spawn time (P4 follow-up).
    const allowNestedSpawn = depth < tree.depth_budget;

    // Reserve atomically before worktree preparation. Historical consumed_* values
    // remain a conservative legacy allocation ceiling; they are never presented as measured usage.
    const plannedLeaseId = randomUUID();
    let reservation: 'reserved' | 'budget' | 'concurrency';
    try {
      reservation = this.db.transaction(() => {
        const active = this.db.prepare(`SELECT COUNT(*) AS n FROM sub_agent_spawns
          WHERE spawn_tree_id = ? AND depth > 0 AND status IN ('requested', 'prepared', 'running')`)
          .get(input.spawn_tree_id) as { n: number };
        if (active.n >= tree.max_concurrent_children) return 'concurrency';
        const result = this.db.prepare(`
          UPDATE spawn_trees
          SET reserved_tokens = reserved_tokens + ?, reserved_wall_ms = reserved_wall_ms + ?, updated_at = ?
          WHERE id = ? AND status = 'open'
            AND total_token_budget - consumed_tokens - measured_tokens - reserved_tokens >= ?
            AND total_wall_budget_ms - consumed_wall_ms - measured_wall_ms - reserved_wall_ms >= ?
        `).run(tokenGrant, wallGrant, now, input.spawn_tree_id, tokenGrant, wallGrant);
        if (result.changes !== 1) return 'budget';
        this.insertSpawnRow({
          id: spawnId,
          spawn_tree_id: input.spawn_tree_id,
          parent_lease_id: input.parent_lease_id,
          child_lease_id: null,
          planned_lease_id: plannedLeaseId,
          idempotency_key: idempotencyKey,
          request_fingerprint: requestFingerprint,
          requested_by_lease_id: input.requested_by_lease_id,
          depth,
          runtime: input.runtime,
          requested_role: input.role,
          prompt_digest: promptDigest,
          status: 'requested',
          reject_reason: null,
          token_budget_grant: tokenGrant,
          wall_budget_ms: wallGrant,
          now,
        });
        return 'reserved';
      }).immediate();
    } catch (error) {
      if (idempotencyKey && (error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        const existing = this.db.prepare(`SELECT * FROM sub_agent_spawns
          WHERE spawn_tree_id = ? AND parent_lease_id = ? AND idempotency_key = ?`).get(
          input.spawn_tree_id, input.parent_lease_id, idempotencyKey
        ) as any;
        if (existing?.request_fingerprint === requestFingerprint) return this.spawnReceipt(existing);
        if (existing) throw new Error('SPAWN_IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
    if (reservation !== 'reserved') {
      return this.gateOut(spawnId, input, depth, promptDigest,
        reservation === 'concurrency' ? 'concurrency_exceeded' : 'budget_reservation_conflict', now,
        idempotencyKey, requestFingerprint);
    }

    let prepared: ReturnType<LoopService['prepareNestedLease']>;
    try {
      prepared = this.loops.prepareNestedLease({
        loopRunId: parent.loop_run_id,
        role: input.role,
        runtime: input.runtime,
        prompt: input.prompt,
        capabilityIds: input.capability_ids,
        parentLeaseId: input.parent_lease_id,
        spawnTreeId: input.spawn_tree_id,
        depth,
        spawnedByAgentId: input.requested_by_lease_id,
        allowNestedSpawn,
        controlUrl: this.controlUrl,
        // Any truthy value enables the control block; the block shows <redacted>.
        spawnToken: allowNestedSpawn ? 'scoped' : undefined,
        depthBudget: tree.depth_budget,
        tokenBudgetGrant: tokenGrant,
        wallBudgetGrantMs: wallGrant,
        leaseId: plannedLeaseId,
      });
    } catch (error) {
      // Worktree and lease creation are external side effects; retain the durable intent and
      // reservation until reconciliation can establish whether preparation partially succeeded.
      const reason = error instanceof Error && error.message === 'NESTED_SPAWN_NO_REPOSITORY'
        ? 'preparation_rejected'
        : (error as { code?: string }).code === 'LOOP_OPERATOR_PAUSED'
          ? 'preparation_rejected'
          : 'preparation_outcome_unknown';
      if (reason === 'preparation_rejected') {
        this.db.transaction(() => {
          this.db.prepare(`UPDATE spawn_trees SET reserved_tokens = MAX(0, reserved_tokens - ?),
            reserved_wall_ms = MAX(0, reserved_wall_ms - ?), updated_at = ? WHERE id = ?`)
            .run(tokenGrant, wallGrant, new Date().toISOString(), input.spawn_tree_id);
          this.db.prepare(`UPDATE sub_agent_spawns SET status = 'gated_out', reject_reason = ? WHERE id = ? AND status = 'requested'`)
            .run(reason, spawnId);
        })();
        return {
          spawn_id: spawnId, spawn_tree_id: input.spawn_tree_id, parent_lease_id: input.parent_lease_id,
          child_lease_id: null, depth, status: 'gated_out', reject_reason: reason,
        };
      }
      this.db.prepare('UPDATE sub_agent_spawns SET reject_reason = ? WHERE id = ? AND status = \'requested\'')
        .run(reason, spawnId);
      return {
        spawn_id: spawnId, spawn_tree_id: input.spawn_tree_id, parent_lease_id: input.parent_lease_id,
        child_lease_id: null, depth, status: 'requested', reject_reason: reason,
        token_budget_grant: tokenGrant, wall_budget_ms: wallGrant,
      };
    }

    // The child's spawn token is scoped to its own lease id (known only now).
    const realChildToken = allowNestedSpawn
      ? this.mintSpawnToken(prepared.leaseId, input.spawn_tree_id)
      : undefined;

    this.db.prepare(`UPDATE sub_agent_spawns SET child_lease_id = ?, status = 'prepared', reject_reason = NULL
      WHERE id = ? AND planned_lease_id = ? AND status = 'requested'`)
      .run(prepared.leaseId, spawnId, plannedLeaseId);

    this.emit(WebSocketEventType.SWARM_SPAWN_PREPARED, {
      spawn_id: spawnId,
      spawn_tree_id: input.spawn_tree_id,
      parent_lease_id: input.parent_lease_id,
      child_lease_id: prepared.leaseId,
      depth,
      runtime: input.runtime,
      role: input.role,
      status: 'prepared',
    });

    return {
      spawn_id: spawnId,
      spawn_tree_id: input.spawn_tree_id,
      parent_lease_id: input.parent_lease_id,
      child_lease_id: prepared.leaseId,
      depth,
      status: 'prepared',
      token_budget_grant: tokenGrant,
      wall_budget_ms: wallGrant,
      control_url: this.controlUrl,
      control_token: realChildToken,
    };
  }

  getSpawnStatus(
    childLeaseId: string,
    opts: { token?: string; internal?: boolean } = { internal: true }
  ): { spawn_id: string; child_lease_id: string | null; status: string; reject_reason: string | null; depth: number; runtime: string; role: string } {
    const row = this.db.prepare(`
      SELECT status, reject_reason, depth, runtime, requested_role, child_lease_id, spawn_tree_id,
        parent_lease_id, id, planned_lease_id
      FROM sub_agent_spawns WHERE child_lease_id = ? OR planned_lease_id = ? OR id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(childLeaseId, childLeaseId, childLeaseId) as any;
    if (!row) throw new Error('SPAWN_NOT_FOUND');
    const tokenMatchesChild = opts.token && this.validateSpawnToken(
      opts.token, row.child_lease_id ?? row.planned_lease_id ?? row.id, row.spawn_tree_id
    );
    const tokenMatchesPendingParent = row.status === 'requested' && opts.token
      && this.validateSpawnToken(opts.token, row.parent_lease_id, row.spawn_tree_id);
    if (!opts.internal && !tokenMatchesChild && !tokenMatchesPendingParent) {
      throw new Error('SPAWN_TOKEN_INVALID');
    }
    if (row.status === 'requested' && row.planned_lease_id) {
      const lease = this.db.prepare('SELECT id FROM worker_leases WHERE id = ?').get(row.planned_lease_id) as { id: string } | undefined;
      if (lease) {
        this.db.prepare(`UPDATE sub_agent_spawns SET child_lease_id = ?, status = 'prepared', reject_reason = NULL
          WHERE id = ? AND status = 'requested' AND planned_lease_id = ?`).run(lease.id, row.id, lease.id);
        this.loops.reconcileNestedSpawnStatus(lease.id);
        const current = this.db.prepare(`SELECT status, reject_reason, child_lease_id FROM sub_agent_spawns WHERE id = ?`)
          .get(row.id) as { status: string; reject_reason: string | null; child_lease_id: string | null };
        return {
          spawn_id: row.id,
          child_lease_id: current.child_lease_id,
          status: current.status,
          reject_reason: current.reject_reason,
          depth: row.depth,
          runtime: row.runtime,
          role: row.requested_role,
        };
      }
    }
    return {
      child_lease_id: row.child_lease_id ?? null,
      spawn_id: row.id,
      status: row.status,
      reject_reason: row.reject_reason ?? null,
      depth: row.depth,
      runtime: row.runtime,
      role: row.requested_role,
    };
  }

  getSpawnTree(spawnTreeId: string): SpawnTreeRecord | null {
    const row = this.db.prepare('SELECT * FROM spawn_trees WHERE id = ?').get(spawnTreeId) as any;
    if (!row) return null;
    return {
      id: row.id,
      depth_budget: row.depth_budget,
      total_token_budget: row.total_token_budget,
      consumed_tokens: row.consumed_tokens,
      total_wall_budget_ms: row.total_wall_budget_ms,
      consumed_wall_ms: row.consumed_wall_ms,
      reserved_tokens: Number(row.reserved_tokens ?? 0),
      reserved_wall_ms: Number(row.reserved_wall_ms ?? 0),
      measured_tokens: Number(row.measured_tokens ?? 0),
      measured_wall_ms: Number(row.measured_wall_ms ?? 0),
      max_concurrent_children: row.max_concurrent_children,
      context_budget: row.context_budget ?? 0,
      context_consumed: row.context_consumed ?? 0,
      risk_class: row.risk_class,
      status: row.status,
      started_at: row.started_at,
      updated_at: row.updated_at,
    };
  }

  listSpawnTree(spawnTreeId: string): { tree: SpawnTreeRecord | null; spawns: SubAgentSpawnRecord[] } {
    const tree = this.getSpawnTree(spawnTreeId);
    const rows = this.db.prepare('SELECT * FROM sub_agent_spawns WHERE spawn_tree_id = ? ORDER BY depth, created_at').all(spawnTreeId) as any[];
    return { tree, spawns: rows.map((row) => this.parseSpawnRow(row)) };
  }

  /** Mint a scoped, expiring spawn token (HMAC). Never printed except by the caller. */
  mintSpawnToken(leaseId: string, spawnTreeId: string): string {
    return mintScopedSpawnToken(this.secret, leaseId, spawnTreeId);
  }

  validateSpawnToken(token: string, expectedLeaseId: string, expectedTreeId: string): boolean {
    return validateScopedSpawnToken(this.secret, token, expectedLeaseId, expectedTreeId);
  }

  // --- internal helpers ---

  private gateOut(
    spawnId: string,
    input: RequestSpawnInput,
    depth: number,
    promptDigest: string,
    rejectReason: string,
    now: string,
    idempotencyKey?: string | null,
    requestFingerprint?: string
  ): RequestSpawnResult {
    const existing = this.db.transaction(() => {
      if (idempotencyKey) {
        const prior = this.db.prepare(`SELECT * FROM sub_agent_spawns
          WHERE spawn_tree_id = ? AND parent_lease_id = ? AND idempotency_key = ?`)
          .get(input.spawn_tree_id, input.parent_lease_id, idempotencyKey) as any;
        if (prior) return prior;
      }
      this.insertSpawnRow({
        id: spawnId,
        spawn_tree_id: input.spawn_tree_id,
        parent_lease_id: input.parent_lease_id,
        child_lease_id: null,
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        requested_by_lease_id: input.requested_by_lease_id,
        depth,
        runtime: input.runtime,
        requested_role: input.role,
        prompt_digest: promptDigest,
        status: 'gated_out',
        reject_reason: rejectReason,
        token_budget_grant: null,
        wall_budget_ms: null,
        now,
      });
      return null;
    }).immediate();
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) throw new Error('SPAWN_IDEMPOTENCY_CONFLICT');
      if (existing.status === 'requested') this.getSpawnStatus(existing.id, { internal: true });
      return this.spawnReceipt(this.db.prepare('SELECT * FROM sub_agent_spawns WHERE id = ?').get(existing.id));
    }
    this.emit(WebSocketEventType.SWARM_SPAWN_GATED_OUT, {
      spawn_id: spawnId,
      spawn_tree_id: input.spawn_tree_id,
      parent_lease_id: input.parent_lease_id,
      child_lease_id: null,
      depth,
      runtime: input.runtime,
      role: input.role,
      status: 'gated_out',
      reject_reason: rejectReason,
    });
    return {
      spawn_id: spawnId,
      spawn_tree_id: input.spawn_tree_id,
      parent_lease_id: input.parent_lease_id,
      child_lease_id: null,
      depth,
      status: 'gated_out',
      reject_reason: rejectReason,
    };
  }

  private detectCycle(spawnTreeId: string, parentLeaseId: string, promptDigest: string, role: string): boolean {
    const marker = `${promptDigest}|${role}`;
    let cursor: string | null = parentLeaseId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const row = this.db.prepare(`
        SELECT prompt_digest, requested_role, parent_lease_id, child_lease_id
        FROM sub_agent_spawns WHERE spawn_tree_id = ? AND child_lease_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(spawnTreeId, cursor) as { prompt_digest: string; requested_role: string; parent_lease_id: string | null; child_lease_id: string } | undefined;
      if (!row) break;
      if (`${row.prompt_digest}|${row.requested_role}` === marker) return true;
      cursor = row.parent_lease_id;
    }
    return false;
  }

  private routeCapabilities(
    capabilityIds: string[] | undefined,
    role: WorkerRole,
    runtime: RuntimeKind,
    treeRisk: RiskClass
  ): string | null {
    if (!capabilityIds || capabilityIds.length === 0) return null;
    const action = `${role}:${runtime}`;
    for (const id of capabilityIds) {
      let capability;
      try {
        capability = this.intelligence.getCapability(id);
      } catch {
        return 'capability_not_found';
      }
      if (capability.status === 'disabled' || capability.status === 'deprecated') return 'capability_not_live';
      if (!capability.live_route_allowed) return 'capability_not_live';
      if (capability.forbidden_actions.includes(action)) return 'capability_action_forbidden';
      if (RISK_RANK[treeRisk] > RISK_RANK[capability.risk_ceiling]) return 'capability_risk_exceeds_ceiling';
    }
    return null;
  }

  private countInFlight(spawnTreeId: string): number {
    // Requested intents reserve concurrency until preparation is reconciled; the root (depth 0)
    // is the operator-armed principal, not an in-flight child, so exclude it —
    // otherwise max_concurrent_children=1 would block the very first child.
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM sub_agent_spawns
      WHERE spawn_tree_id = ? AND depth > 0 AND status IN ('requested', 'prepared', 'running')
    `).get(spawnTreeId) as { n: number };
    return row.n;
  }

  private insertSpawnRow(input: {
    id: string; spawn_tree_id: string; parent_lease_id: string | null; child_lease_id: string | null;
    planned_lease_id?: string | null; idempotency_key?: string | null; request_fingerprint?: string | null;
    requested_by_lease_id: string; depth: number; runtime: string; requested_role: string;
    prompt_digest: string; status: SubAgentSpawnRecord['status']; reject_reason: string | null;
    token_budget_grant: number | null; wall_budget_ms: number | null; now: string;
  }): void {
    this.db.prepare(`
      INSERT INTO sub_agent_spawns (
        id, spawn_tree_id, parent_lease_id, child_lease_id, requested_by_lease_id,
        planned_lease_id, idempotency_key, request_fingerprint,
        depth, runtime, requested_role, prompt_digest, status, reject_reason,
        token_budget_grant, wall_budget_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.spawn_tree_id, input.parent_lease_id, input.child_lease_id,
      input.requested_by_lease_id, input.planned_lease_id ?? null, input.idempotency_key ?? null,
      input.request_fingerprint ?? null, input.depth, input.runtime, input.requested_role,
      input.prompt_digest, input.status, input.reject_reason, input.token_budget_grant,
      input.wall_budget_ms, input.now
    );
  }

  private spawnReceipt(row: any): RequestSpawnResult {
    const status = row.status as RequestSpawnResult['status'];
    const allowNestedSpawn = row.depth < (this.getSpawnTree(row.spawn_tree_id)?.depth_budget ?? 0);
    return {
      spawn_id: row.id,
      spawn_tree_id: row.spawn_tree_id,
      parent_lease_id: row.parent_lease_id,
      child_lease_id: row.child_lease_id ?? null,
      depth: row.depth,
      status,
      ...(row.reject_reason ? { reject_reason: row.reject_reason } : {}),
      ...(row.token_budget_grant != null ? { token_budget_grant: row.token_budget_grant } : {}),
      ...(row.wall_budget_ms != null ? { wall_budget_ms: row.wall_budget_ms } : {}),
      ...(row.child_lease_id && allowNestedSpawn ? { control_url: this.controlUrl, control_token: this.mintSpawnToken(row.child_lease_id, row.spawn_tree_id) } : {}),
    };
  }

  private parseSpawnRow(row: any): SubAgentSpawnRecord {
    return {
      id: row.id,
      spawn_tree_id: row.spawn_tree_id,
      parent_lease_id: row.parent_lease_id ?? null,
      child_lease_id: row.child_lease_id,
      requested_by_lease_id: row.requested_by_lease_id,
      depth: row.depth,
      runtime: row.runtime,
      requested_role: row.requested_role,
      prompt_digest: row.prompt_digest,
      planned_lease_id: row.planned_lease_id ?? null,
      idempotency_key: row.idempotency_key ?? null,
      request_fingerprint: row.request_fingerprint ?? null,
      status: row.status,
      reject_reason: row.reject_reason ?? null,
      token_budget_grant: row.token_budget_grant ?? null,
      wall_budget_ms: row.wall_budget_ms ?? null,
      created_at: row.created_at,
    };
  }

  private getWorkerLeaseRow(id: string): WorkerLeaseRecord | null {
    const row = this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.loops.getWorkerLeasePublic(id);
  }

  private promptDigest(role: string, prompt: string, capabilityIds?: string[]): string {
    return createHash('sha256').update(`${role}|${prompt}|${(capabilityIds ?? []).join(',')}`).digest('hex');
  }

  private emit(type: WebSocketEventType, payload: SwarmSpawnEventPayload): void {
    if (!this.wsService) return;
    this.wsService.broadcastToAuthenticated({ type, payload, timestamp: new Date().toISOString() } as WebSocketMessage);
  }

  private envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  private assertRuntime(runtime: string): asserts runtime is RuntimeKind {
    if (!VALID_RUNTIMES.includes(runtime as RuntimeKind)) throw new Error('SPAWN_RUNTIME_INVALID');
  }

  private assertRole(role: string): asserts role is WorkerRole {
    if (!VALID_ROLES.includes(role as WorkerRole)) throw new Error('SPAWN_ROLE_INVALID');
  }
}
