/**
 * Task routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import { TaskStatus, TaskPriority, ExecutionMode, RiskLevel } from '@djimitflo/shared';
import { randomUUID } from 'crypto';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';

export function createTaskRoutes(db: Database, executionEngine?: ExecutionEngine): Router {
  const router = Router();
  
  // GET /api/tasks - List all tasks
  router.get('/', (req, res, next) => {
    try {
      const { status, agent_id, limit = 100, offset = 0 } = req.query;
      
      let query = 'SELECT * FROM tasks';
      const params: any[] = [];
      const where: string[] = [];
      
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
      
      // Parse JSON fields
      const parsed = tasks.map((task: any) => ({
        ...task,
        tags: JSON.parse(task.tags || '[]'),
        metadata: JSON.parse(task.metadata || '{}'),
      }));
      
      res.json({ tasks: parsed, total: tasks.length });
    } catch (error) {
      next(error);
    }
  });
  
  // GET /api/tasks/:id - Get task by ID
  router.get('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      
      if (!task) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }
      
      res.json({
        ...task,
        tags: JSON.parse(task.tags || '[]'),
        metadata: JSON.parse(task.metadata || '{}'),
      });
    } catch (error) {
      next(error);
    }
  });
  
  // POST /api/tasks - Create new task
  router.post('/', (req, res, next) => {
    try {
      const {
        title,
        description,
        priority = TaskPriority.MEDIUM,
        execution_mode = ExecutionMode.REVIEW_ONLY,
        agent_id = null,
        parent_task_id = null,
        repository_id = null,
        instruction_profile_id = null,
        tags = [],
        metadata = {},
      } = req.body;
      
      if (!title || !description) {
        throw createError(400, 'Title and description are required', 'INVALID_INPUT');
      }
      
      const id = randomUUID();
      const now = new Date().toISOString();
      
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, priority, risk_level, execution_mode,
          agent_id, parent_task_id, repository_id, instruction_profile_id,
          tags, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        title,
        description,
        TaskStatus.PENDING,
        priority,
        RiskLevel.LOW, // Default, will be calculated
        execution_mode,
        agent_id,
        parent_task_id,
        repository_id,
        instruction_profile_id,
        JSON.stringify(tags),
        JSON.stringify(metadata),
        now,
        now
      );
      
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      
      res.status(201).json({
        ...task,
        tags: JSON.parse(task.tags),
        metadata: JSON.parse(task.metadata),
      });
    } catch (error) {
      next(error);
    }
  });
  
  // PATCH /api/tasks/:id - Update task
  router.patch('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }
      
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
      params.push(id);
      
      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
      
      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      
      res.json({
        ...updated,
        tags: JSON.parse(updated.tags),
        metadata: JSON.parse(updated.metadata),
      });
    } catch (error) {
      next(error);
    }
  });
  
  // DELETE /api/tasks/:id - Delete task
  router.delete('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      
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
  router.post('/:id/execute', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { executor = 'opencode' } = req.body; // Default to opencode executor
      
      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }
      
      // Check if task exists
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) {
        throw createError(404, 'Task not found', 'TASK_NOT_FOUND');
      }
      
      // Check if task is already running
      if (executionEngine.isTaskRunning(id)) {
        throw createError(409, 'Task is already running', 'TASK_RUNNING');
      }
      
      // Start execution (non-blocking)
      executionEngine.executeTask(id, executor as ExecutorKind).catch((error) => {
        console.error(`Task execution failed for ${id}:`, error);
      });
      
      // Return immediately with queued status
      res.json({
        message: 'Task execution started',
        task_id: id,
        executor,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/tasks/:id/cancel - Cancel a running task
  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const { id } = req.params;
      
      if (!executionEngine) {
        throw createError(503, 'Execution engine not available', 'ENGINE_UNAVAILABLE');
      }
      
      // Check if task is running
      if (!executionEngine.isTaskRunning(id)) {
        throw createError(409, 'Task is not running', 'TASK_NOT_RUNNING');
      }
      
      // Cancel execution
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
