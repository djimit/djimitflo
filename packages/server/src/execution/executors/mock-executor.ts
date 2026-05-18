/**
 * Mock executor for testing - generates fake execution events
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { randomUUID } from 'crypto';

export class MockExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'mock';
  
  canExecute(_task: Task): boolean {
    // Mock executor can handle any task
    return true;
  }
  
  async start(task: Task, _options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();
    let cancelled = false;
    
    // Create event stream generator
    const events = this.createEventStream(task, () => cancelled);
    
    // Create result promise
    const result = this.createResultPromise(task, () => cancelled);
    
    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'running',
      startedAt,
      events,
      result,
      cancel: async () => {
        cancelled = true;
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };
    
    return session;
  }
  
  /**
   * Generate a stream of fake execution events
   */
  private async *createEventStream(
    task: Task,
    isCancelled: () => boolean
  ): AsyncIterable<ExecutionEventCreateInput> {
    // Task started event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'Task execution started with mock executor',
      level: LogLevel.INFO,
      metadata: { executor: 'mock' },
    };
    
    await this.sleep(500);
    if (isCancelled()) return;
    
    // Log event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.LOG,
      message: 'Analyzing task requirements...',
      level: LogLevel.INFO,
    };
    
    await this.sleep(1000);
    if (isCancelled()) return;
    
    // Tool call event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TOOL_CALL,
      message: 'Reading project files',
      level: LogLevel.INFO,
      tool_name: 'read_file',
      tool_input: { path: '/src/index.ts' },
    };
    
    await this.sleep(800);
    if (isCancelled()) return;
    
    // Tool result event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TOOL_RESULT,
      message: 'Successfully read file',
      level: LogLevel.INFO,
      tool_name: 'read_file',
      tool_output: { success: true, lines: 150 },
    };
    
    await this.sleep(1200);
    if (isCancelled()) return;
    
    // Another log event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.LOG,
      message: 'Generating implementation plan...',
      level: LogLevel.INFO,
    };
    
    await this.sleep(1500);
    if (isCancelled()) return;
    
    // Tool call with high risk (would trigger approval in real scenario)
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TOOL_CALL,
      message: 'Writing changes to file',
      level: LogLevel.INFO,
      tool_name: 'write_file',
      tool_input: { path: '/src/index.ts', content: '// Modified code...' },
    };
    
    await this.sleep(1000);
    if (isCancelled()) return;
    
    // Tool result
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TOOL_RESULT,
      message: 'File written successfully',
      level: LogLevel.INFO,
      tool_name: 'write_file',
      tool_output: { success: true, bytesWritten: 2048 },
    };
    
    await this.sleep(500);
    if (isCancelled()) return;
    
    // Final log
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.LOG,
      message: 'Task execution completed successfully',
      level: LogLevel.INFO,
    };
    
    await this.sleep(300);
    if (isCancelled()) return;
    
    // Task completed event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_COMPLETED,
      message: 'Mock task execution completed',
      level: LogLevel.INFO,
      metadata: {
        executor: 'mock',
        duration_ms: 7000,
        tool_calls: 2,
      },
    };
  }
  
  /**
   * Create a promise that resolves when execution completes
   */
  private async createResultPromise(
    _task: Task,
    isCancelled: () => boolean
  ): Promise<ExecutionResult> {
    // Wait for execution to complete (simulate ~7 seconds)
    await this.sleep(7000);
    
    if (isCancelled()) {
      return {
        status: 'cancelled',
        message: 'Task execution was cancelled',
        metrics: {
          executionTimeMs: 3000,
          toolCalls: 1,
        },
      };
    }
    
    return {
      status: 'completed',
      message: 'Mock task completed successfully',
      artifacts: [
        {
          type: 'file',
          path: '/src/index.ts',
          content: '// Modified by mock executor',
          mimeType: 'text/typescript',
          sizeBytes: 2048,
        },
        {
          type: 'log',
          path: '/logs/execution.log',
          content: 'Execution log output...',
          mimeType: 'text/plain',
          sizeBytes: 512,
        },
      ],
      metrics: {
        executionTimeMs: 7000,
        tokenUsage: 1500,
        toolCalls: 2,
        approvalsRequested: 0,
      },
    };
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
