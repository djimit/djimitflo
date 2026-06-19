/**
 * Nested spawn control routes (P1).
 *
 * These are the HTTP control endpoint a spawned runtime child shells out to
 * (`curl`) when it wants to spawn its own sub-agent. Three endpoints:
 *   - POST /api/swarms/spawns/root  — operator-armed: creates the swarm root
 *     lease + spawn_trees row (requires write:swarm_action).
 *   - POST /api/swarms/spawns       — child spawn: gated by a scoped spawn
 *     token (X-Spawn-Token header). Internal/orchestrator callers omit the token
 *     and pass `internal: true` in the body.
 *   - GET  /api/swarms/spawns/:id/status — a child polls its own spawn status.
 *
 * The token gate lives in NestedSpawnService.requestSpawn; these routes only
 * forward inputs and map service errors to HTTP status codes.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { LoopService } from '../services/loop-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import type { WebSocketService } from '../services/websocket-service';

function mapSpawnError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  switch (message) {
    case 'SPAWN_PROMPT_REQUIRED': throw createError(400, 'prompt is required', 'SPAWN_PROMPT_REQUIRED');
    case 'SPAWN_RUNTIME_INVALID': throw createError(400, 'runtime is invalid (codex|opencode|manual|mock)', 'SPAWN_RUNTIME_INVALID');
    case 'SPAWN_ROLE_INVALID': throw createError(400, 'role is invalid', 'SPAWN_ROLE_INVALID');
    case 'SPAWN_TREE_NOT_FOUND': throw createError(404, 'spawn tree not found', 'SPAWN_TREE_NOT_FOUND');
    case 'SPAWN_TREE_CLOSED': throw createError(409, 'spawn tree is closed', 'SPAWN_TREE_CLOSED');
    case 'SPAWN_TREE_MISMATCH': throw createError(400, 'parent lease does not belong to this spawn tree', 'SPAWN_TREE_MISMATCH');
    case 'PARENT_LEASE_NOT_FOUND': throw createError(404, 'parent lease not found', 'PARENT_LEASE_NOT_FOUND');
    case 'SPAWN_NOT_FOUND': throw createError(404, 'spawn not found', 'SPAWN_NOT_FOUND');
    case 'SPAWN_TOKEN_INVALID': throw createError(401, 'spawn token is invalid, expired, or not scoped to this lease/tree', 'SPAWN_TOKEN_INVALID');
    case 'NESTED_SPAWN_NO_REPOSITORY': throw createError(409, 'loop run has no repository_path; cannot create worktree', 'NESTED_SPAWN_NO_REPOSITORY');
    default: throw error;
  }
}

export function createSpawnRoutes(db: Database, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const loops = new LoopService(db);
  const spawns = new NestedSpawnService(db, loops, { wsService });

  // POST /api/swarms/spawns/root — operator-armed swarm root creation.
  router.post('/root', requirePermission('write:swarm_action'), (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.loop_run_id) throw createError(400, 'loop_run_id is required', 'SPAWN_LOOP_RUN_REQUIRED');
      const result = spawns.createRoot({
        loop_run_id: body.loop_run_id,
        runtime: body.runtime,
        role: body.role,
        prompt: body.prompt,
        capability_ids: body.capability_ids,
        depth_budget: body.depth_budget,
        total_token_budget: body.total_token_budget,
        total_wall_budget_ms: body.total_wall_budget_ms,
        max_concurrent_children: body.max_concurrent_children,
        risk_class: body.risk_class,
      });
      res.status(201).json(result);
    } catch (error) {
      try {
        mapSpawnError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  // POST /api/swarms/spawns — child spawn (token-gated over HTTP).
  router.post('/', (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.spawn_tree_id) throw createError(400, 'spawn_tree_id is required', 'SPAWN_TREE_REQUIRED');
      if (!body.parent_lease_id) throw createError(400, 'parent_lease_id is required', 'SPAWN_PARENT_REQUIRED');
      if (!body.requested_by_lease_id) throw createError(400, 'requested_by_lease_id is required', 'SPAWN_REQUESTER_REQUIRED');
      // A child spawning its own children presents its token in the X-Spawn-Token
      // header. Internal/orchestrator callers set body.internal=true to bypass
      // (same-process trust — the operator already armed the tree at root time).
      const token = typeof req.get('X-Spawn-Token') === 'string' ? req.get('X-Spawn-Token') as string : undefined;
      const isInternal = body.internal === true;
      if (!isInternal && !token) throw createError(401, 'X-Spawn-Token header is required', 'SPAWN_TOKEN_INVALID');
      const result = spawns.requestSpawn(
        {
          spawn_tree_id: body.spawn_tree_id,
          parent_lease_id: body.parent_lease_id,
          requested_by_lease_id: body.requested_by_lease_id,
          role: body.role,
          runtime: body.runtime,
          prompt: body.prompt,
          capability_ids: body.capability_ids,
          token,
        },
        { internal: isInternal }
      );
      res.status(result.status === 'prepared' ? 201 : 200).json(result);
    } catch (error) {
      try {
        mapSpawnError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  // GET /api/swarms/spawns/:id/status — child polls its own spawn status.
  router.get('/:id/status', (req, res, next) => {
    try {
      res.json(spawns.getSpawnStatus(req.params.id));
    } catch (error) {
      try {
        mapSpawnError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  return router;
}