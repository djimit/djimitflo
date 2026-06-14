/**
 * Task routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { TaskStatus, TaskPriority, ExecutionMode, RiskLevel, AuthTokenPayload } from '@djimitflo/shared';
import { AuthorizationService } from '../services/authorization-service';
import { ContextInjectionService } from '../services/context-injection-service';
import { randomUUID } from 'crypto';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';
import type { AuthMiddleware } from '../middleware/auth';

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

export function createTaskRoutes(db: Database, executionEngine?: ExecutionEngine, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const contextInjector = new ContextInjectionService();

  function getUser(req: any): AuthTokenPayload {
    return (req as any).user;
  }

  // GET /api/tasks - List all tasks
  router.get('/', (req, res, next) => {
    try {
      const { status, agent_id, limit = 100, offset = 0 } = req.query;
      const user = getUser(req);

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
      params.push(Number(limit), Number(offset));

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

      const id = randomUUID();
      const now = new Date().toISOString();
      const actorId = (req as any).user?.sub;

      // Inject swarm context (Qdrant + OKF) if enabled
      let swarmContext = '';
      try {
        swarmContext = await contextInjector.injectContext(`${title} ${description}`, use_swarm_context);
      } catch (e: any) {
        console.warn('Context injection failed:', e?.message || e);
      }

      const enrichedMetadata = { ...metadata, createdBy: actorId, swarm_context: swarmContext || undefined };

      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, priority, risk_level, execution_mode,
          agent_id, parent_task_id, repository_id, instruction_profile_id,
          tags, metadata, created_at, updated_at, created_by, owner_user_id, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        title,
        description,
        TaskStatus.PENDING,
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

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;

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
      const allowed = ['title', 'description', 'status', 'priority', 'tags', 'metadata'];
      const setClauses: string[] = [];
      const params: any[] = [];

      for (const key of allowed) {
        if (key in updates) {
          setClauses.push(`${key} = ?`);
          params.push(
            key === 'tags' || key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]
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

      const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      if (result.changes === 0) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }

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

      const { executor = 'opencode' } = req.body;

      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }

      if (executionEngine.isTaskRunning(id)) {
        throw createError(409, 'Task is already running', 'TASK_RUNNING');
      }

      const result = await executionEngine.executeTask(id, executor as ExecutorKind);

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