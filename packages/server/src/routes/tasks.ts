/**
 * Task routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { TaskStatus, TaskPriority, ExecutionMode, RiskLevel, AuthTokenPayload, AuditEventType, WebSocketEventType } from '@djimitflo/shared';
import { AuthorizationService } from '../services/authorization-service';
import { ContextInjectionService } from '../services/context-injection-service';
import { randomUUID } from 'crypto';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';
import type { AuthMiddleware } from '../middleware/auth';
import type { WebSocketService } from '../services/websocket-service';
import { AuditService } from '../services/audit-service';

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw createError(400, `${name} must be an integer between ${minimum} and ${maximum}`, 'VALIDATION_ERROR');
  }
  return parsed;
}

function loadTaskOr404(db: any, id: string, res: any): any | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) {
    res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
    return null;
  }
  return task;
}

function parseTask(task: any): any {
  return {
    ...task,
    tags: JSON.parse(task.tags || '[]'),
    metadata: JSON.parse(task.metadata || '{}'),
    created_by: task.created_by || null,
    owner_user_id: task.owner_user_id || null,
    updated_by: task.updated_by || null,
  };
}

export function createTaskRoutes(db: Database, executionEngine?: ExecutionEngine, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const contextInjector = new ContextInjectionService(db);
  const audit = new AuditService(db);

  function getUser(req: any): AuthTokenPayload {
    return (req as any).user;
  }

  // GET /api/tasks - List all tasks
  router.get('/', (req, res, next) => {
    try {
      const { status, agent_id } = req.query;
      const user = getUser(req);
      const limit = boundedInteger(req.query.limit, 100, 1, 500, 'limit');
      const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000, 'offset');

      let query = 'SELECT * FROM tasks';
      const params: any[] = [];
      const where: string[] = [];

      const visibility = AuthorizationService.getTaskVisibilityWhere(user);
      if (visibility) {
        where.push(visibility.clause);
        params.push(...visibility.params);
      }

      if (status) {
        where.push('status = ?');
        params.push(status);
      }

      if (agent_id) {
        where.push('agent_id = ?');
        params.push(agent_id);
      }

      if (where.length > 0) {
        query += ' WHERE ' + where.join(' AND ');
      }

      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const tasks = db.prepare(query).all(...params);

      const parsed = tasks.map((task: any) => parseTask(task));

      res.json({ tasks: parsed, total: tasks.length });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/tasks/:id - Get task by ID
  router.get('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canReadTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      res.json(parseTask(task));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tasks - Create new task
  router.post('/', requirePermission('create:task'), async (req, res, next) => {
    try {
      const {
        title,
        description,
        status,
        priority = TaskPriority.MEDIUM,
        risk_level,
        execution_mode = ExecutionMode.REVIEW_ONLY,
        agent_id = null,
        parent_task_id = null,
        repository_id = null,
        instruction_profile_id = null,
        tags = [],
        metadata = {},
        use_swarm_context = true,
      } = req.body;

      if (!title || !description) {
        throw createError(400, 'Title and description are required', 'INVALID_INPUT');
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw createError(400, 'metadata must be an object', 'INVALID_INPUT');
      }
      if ('environment' in metadata) {
        throw createError(400, 'Executor environment is server-owned, not task input', 'EXECUTOR_ENVIRONMENT_RESERVED');
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const actorId = (req as any).user?.sub;

      // Inject swarm context (Qdrant + OKF) if enabled
      let contextSnapshot;
      try {
        contextSnapshot = await contextInjector.injectContextSnapshot(`${title} ${description}`, use_swarm_context);
      } catch (error) {
        // Context is advisory; an unavailable retrieval backend must not make
        // the task intake unavailable. The empty hash is still persisted so
        // the executor input has explicit, auditable provenance.
        console.warn('Task context retrieval unavailable:', error instanceof Error ? error.message : String(error));
        contextSnapshot = await contextInjector.injectContextSnapshot('', false);
      }
      // Context retrieval is advisory. A failed source must not prevent task
      // creation, but successful context must be part of the immutable input
      // before approvals and execution fingerprints are created.
      if (!contextSnapshot.text) contextSnapshot = { ...contextSnapshot, text: '' };

      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw createError(400, 'metadata must be an object', 'INVALID_INPUT');
      }
      const enrichedMetadata = {
        ...metadata,
        createdBy: actorId,
        swarm_context: contextSnapshot.text || undefined,
        context_snapshot: {
          sha256: contextSnapshot.sha256,
          sources: contextSnapshot.sources,
          advisory: true,
          independently_reviewed: false,
          server_generated_at: new Date().toISOString(),
        },
      };
      const taskDescription = contextSnapshot.text ? `${description}\n\n${contextSnapshot.text}` : description;
      for (const name of Object.keys(enrichedMetadata).filter(name => name.startsWith('execution_recovery_'))) delete enrichedMetadata[name];

      db.transaction(() => {
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, priority, risk_level, execution_mode,
          agent_id, parent_task_id, repository_id, instruction_profile_id,
          tags, metadata, created_at, updated_at, created_by, owner_user_id, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        title,
        taskDescription,
        (status || TaskStatus.PENDING),
        priority,
        risk_level || RiskLevel.LOW,
        execution_mode,
        agent_id,
        parent_task_id,
        repository_id,
        instruction_profile_id,
        JSON.stringify(tags),
        JSON.stringify(enrichedMetadata),
        now,
        now,
        actorId,
        actorId,
        actorId
      );
      audit.record({ event_type: AuditEventType.TASK_CREATED, action: 'task_created',
        resource_type: 'task', resource_id: id, task_id: id, user_id: actorId,
        risk_level: risk_level || RiskLevel.LOW });
      })();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      wsService?.broadcastTaskEvent(task, { type: WebSocketEventType.TASK_CREATED,
        payload: { task: parseTask(task) }, timestamp: now });
      res.status(201).json(parseTask(task));
    } catch (error) {
      next(error);
    }
  });

  // PATCH /api/tasks/:id - Update task
  router.patch('/:id', requirePermission('create:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canModifyTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      const updates = req.body;
      const allowed = ['title', 'description', 'status', 'priority', 'tags', 'metadata', 'token_usage', 'execution_time_ms', 'started_at', 'completed_at', 'failed_at'];
      const setClauses: string[] = [];
      const params: any[] = [];
      const existingMetadata = JSON.parse(task.metadata || '{}') as Record<string, unknown>;
      const executionStateFields = ['status', 'token_usage', 'execution_time_ms', 'started_at', 'completed_at', 'failed_at'];
      if ((task.status === TaskStatus.RUNNING || executionEngine?.isTaskRunning(id)) && executionStateFields.some((field) => field in updates)) {
        throw createError(409, 'Running task state is owned by the execution engine', 'TASK_RUNNING');
      }
      if (existingMetadata.deep_agent_assurance_hold === true && executionStateFields.some((field) => field in updates)) {
        throw createError(409, 'Task is held for independent EVE-V assurance', 'DEEP_AGENT_ASSURANCE_HOLD');
      }
      if (existingMetadata.execution_recovery_hold === true && executionStateFields.some((field) => field in updates)) {
        throw createError(409, 'Task execution outcome requires operator reconciliation', 'EXECUTION_RECOVERY_REQUIRED');
      }

      for (const key of allowed) {
        if (key in updates) {
          setClauses.push(`${key} = ?`);
          if (key === 'metadata') {
            if (!updates.metadata || typeof updates.metadata !== 'object' || Array.isArray(updates.metadata)) {
              throw createError(400, 'metadata must be an object', 'INVALID_INPUT');
            }
            const metadata = { ...(updates.metadata || {}) } as Record<string, unknown>;
            const reserved = (name: string) => name === 'environment' || name.startsWith('deep_agent_assurance_') || name.startsWith('execution_recovery_');
            for (const name of Object.keys(metadata).filter(reserved)) delete metadata[name];
            for (const [name, value] of Object.entries(existingMetadata).filter(([name]) => reserved(name))) metadata[name] = value;
            // A loop worker's execution-task pointer is server-owned. Preserve
            // its canonical binding even when replacing all editable metadata.
            const worker = db.prepare(`SELECT id, loop_run_id FROM worker_leases
              WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.execution_task_id') = ?
              LIMIT 1`).get(id) as { id: string; loop_run_id: string } | undefined;
            if (worker) {
              metadata.loop_run_id = worker.loop_run_id;
              metadata.lease_id = worker.id;
            }
            params.push(JSON.stringify(metadata));
            continue;
          }
          params.push(
            key === 'tags' ? JSON.stringify(updates[key]) : updates[key]
          );
        }
      }

      if (setClauses.length === 0) {
        throw createError(400, 'No valid fields to update', 'INVALID_INPUT');
      }

      setClauses.push('updated_at = ?');
      params.push(new Date().toISOString());
      setClauses.push('updated_by = ?');
      params.push(user?.sub);
      params.push(id);

      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      wsService?.broadcastTaskEvent(updated, { type: WebSocketEventType.TASK_UPDATED,
        payload: { task: parseTask(updated) }, timestamp: updated.updated_at });
      res.json(parseTask(updated));
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/tasks/:id - Delete task
  router.delete('/:id', requirePermission('delete:task'), (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canDeleteTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      if (executionEngine?.isTaskRunning(id) || task.status === TaskStatus.RUNNING) {
        throw createError(409, 'Cancel the running task before deleting it', 'TASK_RUNNING');
      }
      if (JSON.parse(task.metadata || '{}').execution_recovery_hold === true) {
        throw createError(409, 'Task execution outcome requires operator reconciliation', 'EXECUTION_RECOVERY_REQUIRED');
      }
      if (db.prepare('SELECT 1 FROM audit_events WHERE task_id = ? LIMIT 1').get(id)) {
        throw createError(409, 'Task is retained by the immutable audit trail', 'TASK_HAS_AUDIT_TRAIL');
      }

      const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      if (result.changes === 0) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }

      wsService?.broadcastTaskEvent(task, { type: WebSocketEventType.TASK_DELETED,
        payload: { task: parseTask(task) }, timestamp: new Date().toISOString() });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  // GET /api/tasks/:id/events - Get execution events for a task
  router.get('/:id/events', (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canReadTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      const events = db.prepare(`
        SELECT * FROM execution_events
        WHERE task_id = ?
        ORDER BY timestamp DESC
      `).all(id);

      const parsed = events.map((event: any) => ({
        ...event,
        tool_input: event.tool_input ? JSON.parse(event.tool_input) : null,
        tool_output: event.tool_output ? JSON.parse(event.tool_output) : null,
        metadata: JSON.parse(event.metadata || '{}'),
      }));

      res.json({ events: parsed });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/tasks/:id/approvals - Get approvals for a task
  router.get('/:id/approvals', (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canReadTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      const approvals = db.prepare(`
        SELECT * FROM approvals
        WHERE task_id = ?
        ORDER BY created_at DESC
      `).all(id);

      const parsed = approvals.map((approval: any) => ({
        ...approval,
        request_data: JSON.parse(approval.request_data || '{}'),
        metadata: JSON.parse(approval.metadata || '{}'),
      }));

      res.json({ approvals: parsed });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tasks/:id/execute - Execute a task
  router.post('/:id/execute', requirePermission('execute:task'), async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canExecuteTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      // Persisted task metadata is the canonical runtime choice when the
      // execute request does not override it. Without this, a task created
      // with Codex/Astra silently fell back to OpenCode for API callers.
      let persistedExecutor: string | undefined;
      try {
        const metadata = JSON.parse(task.metadata || '{}');
        if (typeof metadata.executor === 'string' && metadata.executor.trim()) persistedExecutor = metadata.executor.trim();
      } catch {
        // ExecutionEngine owns malformed metadata validation; retain the safe default.
      }
      const requestedExecutor = typeof req.body?.executor === 'string' && req.body.executor.trim()
        ? req.body.executor.trim()
        : undefined;
      const executor = requestedExecutor || persistedExecutor || 'opencode';

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      if (executionEngine.isTaskRunning(id)) {
        throw createError(409, 'Task is already running', 'TASK_RUNNING');
      }

      const result = await executionEngine.executeTask(id, executor as ExecutorKind, user.sub);

      res.json({
        message: result.status === 'awaiting_approval'
          ? 'Task is awaiting approval before execution'
          : result.status === 'denied'
          ? 'Task execution denied by policy'
          : 'Task execution started',
        task_id: id,
        executor,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tasks/:id/cancel - Cancel a running task
  router.post('/:id/cancel', requirePermission('execute:task'), async (req, res, next) => {
    try {
      const { id } = req.params;
      const user = getUser(req);
      const task = loadTaskOr404(db, id, res);
      if (!task) return;

      if (!AuthorizationService.canExecuteTask(user, task)) {
        res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
        return;
      }

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      if (!executionEngine.isTaskRunning(id)) {
        throw createError(409, 'Task is not running', 'TASK_NOT_RUNNING');
      }

      await executionEngine.cancelTask(id);

      res.json({
        message: 'Task cancelled',
        task_id: id,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
