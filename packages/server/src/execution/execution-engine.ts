/**
 * Execution engine - orchestrates task execution, event persistence, and WebSocket broadcasting
 */

import type { Database } from 'better-sqlite3';
import { Task, TaskStatus, ExecutionEventCreateInput, WebSocketEventType } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutorKind } from './types';
import { MockExecutor } from './executors/mock-executor';
import { OpenCodeExecutor } from './executors/opencode-executor';
import { WebSocketService } from '../services/websocket-service';
import { randomUUID } from 'crypto';

export class ExecutionEngine {
  private db: Database;
  private wsService: WebSocketService;
  private executors: Map<ExecutorKind, TaskExecutor>;
  private activeSessions: Map<string, ExecutionSession>; // taskId -> session
  
  constructor(db: Database, wsService: WebSocketService) {
    this.db = db;
    this.wsService = wsService;
    this.executors = new Map();
    this.activeSessions = new Map();
    
    // Register default executors
    this.registerExecutor(new MockExecutor());
    this.registerExecutor(new OpenCodeExecutor());
  }
  
  /**
   * Register an executor implementation
   */
  registerExecutor(executor: TaskExecutor): void {
    this.executors.set(executor.kind, executor);
    console.log(`📦 Registered executor: ${executor.kind}`);
  }
  
  /**
   * Get executor by kind
   */
  getExecutor(kind: ExecutorKind): TaskExecutor | undefined {
    return this.executors.get(kind);
  }
  
  /**
   * Execute a task
   */
  async executeTask(taskId: string, executorKind: ExecutorKind = 'opencode'): Promise<void> {
    // Check if task is already running
    if (this.activeSessions.has(taskId)) {
      throw new Error('Task is already running');
    }
    
    // Load task from database
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) {
      throw new Error('Task not found');
    }
    
    // Parse JSON fields
    const parsedTask: Task = {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };
    
    // Get executor
    const executor = this.executors.get(executorKind);
    if (!executor) {
      throw new Error(`Executor not found: ${executorKind}`);
    }
    
    if (!executor.canExecute(parsedTask)) {
      throw new Error(`Executor ${executorKind} cannot execute this task`);
    }
    
    // Update task status to queued
    this.updateTaskStatus(taskId, TaskStatus.QUEUED);
    
    try {
      // Start execution
      const session = await executor.start(parsedTask);
      this.activeSessions.set(taskId, session);
      
      // Update task status to running
      this.updateTaskStatus(taskId, TaskStatus.RUNNING, {
        started_at: session.startedAt.toISOString(),
      });
      
      // Process event stream in background
      this.processEventStream(session).catch((error) => {
        console.error(`Error processing event stream for task ${taskId}:`, error);
        this.handleExecutionError(taskId, error);
      });
      
      // Wait for result and update task
      session.result.then((result) => {
        this.handleExecutionComplete(taskId, session, result);
      }).catch((error) => {
        this.handleExecutionError(taskId, error);
      });
      
    } catch (error) {
      this.updateTaskStatus(taskId, TaskStatus.FAILED, {
        failed_at: new Date().toISOString(),
      });
      throw error;
    }
  }
  
  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      throw new Error('Task is not running');
    }
    
    await session.cancel();
    this.activeSessions.delete(taskId);
    
    // Update task status
    this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
    
    // Broadcast cancellation event
    this.wsService.broadcast({
      type: WebSocketEventType.TASK_CANCELLED,
      payload: { task: this.getTask(taskId) },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Get active session for a task
   */
  getSession(taskId: string): ExecutionSession | undefined {
    return this.activeSessions.get(taskId);
  }
  
  /**
   * Check if task is running
   */
  isTaskRunning(taskId: string): boolean {
    return this.activeSessions.has(taskId);
  }
  
  /**
   * Process event stream from execution session
   */
  private async processEventStream(session: ExecutionSession): Promise<void> {
    try {
      for await (const event of session.events) {
        // Persist event to database
        const eventId = this.persistEvent(event);
        
        // Broadcast via WebSocket
        this.broadcastExecutionEvent(session.taskId, eventId, event);
      }
    } catch (error) {
      console.error(`Error in event stream for task ${session.taskId}:`, error);
      throw error;
    }
  }
  
  /**
   * Persist execution event to database
   */
  private persistEvent(event: ExecutionEventCreateInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO execution_events (
        id, task_id, event_type, timestamp, message, level,
        tool_name, tool_input, tool_output, tool_error,
        approval_id, artifact_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.task_id,
      event.event_type,
      now, // Use current timestamp
      event.message,
      event.level || 'info',
      event.tool_name || null,
      event.tool_input ? JSON.stringify(event.tool_input) : null,
      event.tool_output ? JSON.stringify(event.tool_output) : null,
      event.tool_error || null,
      event.approval_id || null,
      event.artifact_id || null,
      JSON.stringify(event.metadata || {}),
      now,
      now
    );
    
    return id;
  }
  
  /**
   * Broadcast execution event via WebSocket
   */
  private broadcastExecutionEvent(
    _taskId: string,
    eventId: string,
    event: ExecutionEventCreateInput
  ): void {
    this.wsService.broadcast({
      type: WebSocketEventType.EXECUTION_EVENT,
      payload: {
        event: {
          id: eventId,
          ...event,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Handle execution completion
   */
  private handleExecutionComplete(
    taskId: string,
    session: ExecutionSession,
    result: any
  ): void {
    this.activeSessions.delete(taskId);
    
    const completedAt = new Date().toISOString();
    const executionTimeMs = Date.now() - session.startedAt.getTime();
    
    if (result.status === 'completed') {
      this.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        completed_at: completedAt,
        execution_time_ms: executionTimeMs,
        token_usage: result.metrics?.tokenUsage || null,
      });
      
      // Broadcast completion
      this.wsService.broadcast({
        type: WebSocketEventType.TASK_COMPLETED,
        payload: { task: this.getTask(taskId) },
        timestamp: new Date().toISOString(),
      });
    } else if (result.status === 'failed') {
      this.updateTaskStatus(taskId, TaskStatus.FAILED, {
        failed_at: completedAt,
        execution_time_ms: executionTimeMs,
      });
      
      // Broadcast failure
      this.wsService.broadcast({
        type: WebSocketEventType.TASK_FAILED,
        payload: { task: this.getTask(taskId) },
        timestamp: new Date().toISOString(),
      });
    }
  }
  
  /**
   * Handle execution error
   */
  private handleExecutionError(taskId: string, error: Error): void {
    this.activeSessions.delete(taskId);
    
    this.updateTaskStatus(taskId, TaskStatus.FAILED, {
      failed_at: new Date().toISOString(),
    });
    
    // Persist error event
    this.persistEvent({
      task_id: taskId,
      event_type: 'error' as any,
      message: `Execution error: ${error.message}`,
      level: 'error' as any,
      metadata: { error: error.stack },
    });
    
    // Broadcast failure
    this.wsService.broadcast({
      type: WebSocketEventType.TASK_FAILED,
      payload: { task: this.getTask(taskId) },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Update task status in database
   */
  private updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    additionalFields?: Record<string, any>
  ): void {
    const updates: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
      ...additionalFields,
    };
    
    const setClauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    
    this.db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values, taskId);
    
    // Broadcast status change
    this.wsService.broadcast({
      type: WebSocketEventType.TASK_UPDATED,
      payload: { task: this.getTask(taskId) },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Get task from database
   */
  private getTask(taskId: string): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    return {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };
  }
}
