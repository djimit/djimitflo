/**
 * OpenCode CLI executor - spawns OpenCode process and streams events
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * OpenCode output line pattern matching
 */
interface ParsedOutput {
  type: 'log' | 'tool_call' | 'tool_result' | 'error' | 'approval_request' | 'thinking' | 'unknown';
  message: string;
  level: LogLevel;
  metadata?: Record<string, unknown>;
}

export class OpenCodeExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'opencode';
  private readonly opencodePath: string;
  
  constructor(opencodePath: string = '/Users/dlandman/.opencode/bin/opencode') {
    this.opencodePath = opencodePath;
  }
  
  canExecute(_task: Task): boolean {
    // OpenCode executor can handle any task
    return true;
  }
  
  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();
    
    // Build OpenCode CLI arguments
    const args = this.buildOpenCodeArgs(task, options);
    
    // Create event emitter for process lifecycle
    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;
    
    // Spawn OpenCode process
    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = { ...process.env, ...options?.environment };
      
      const child = spawn(this.opencodePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, capture stdout/stderr
      });
      
      childProcess = child;
      
      // Handle stdout
      child.stdout?.on('data', (data) => {
        const text = data.toString();
        emitter.emit('output', text, 'stdout');
      });
      
      // Handle stderr
      child.stderr?.on('data', (data) => {
        const text = data.toString();
        emitter.emit('output', text, 'stderr');
      });
      
      // Handle process exit
      child.on('close', (code) => {
        emitter.emit('exit', code);
      });
      
      // Handle process error
      child.on('error', (error) => {
        emitter.emit('error', error);
      });
    };
    
    // Create event stream
    const events = this.createEventStream(task, emitter, spawnProcess);
    
    // Create result promise
    const result = this.createResultPromise(task, emitter);
    
    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'starting',
      startedAt,
      events,
      result,
      cancel: async () => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM');
          // Force kill after 5 seconds
          setTimeout(() => {
            if (childProcess && !childProcess.killed) {
              childProcess.kill('SIGKILL');
            }
          }, 5000);
        }
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };
    
    return session;
  }
  
  /**
   * Build OpenCode CLI arguments from task
   */
  private buildOpenCodeArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = [];
    
    // Use the 'run' command
    args.push('run');
    
    // Add working directory if specified
    if (options?.workingDirectory) {
      args.push('--cwd', options.workingDirectory);
    }
    
    // Add model if specified
    if (options?.model) {
      args.push('--model', options.model);
    }
    
    // Add temperature if specified
    if (options?.temperature !== undefined) {
      args.push('--temperature', options.temperature.toString());
    }
    
    // Add max tokens if specified
    if (options?.maxTokens) {
      args.push('--max-tokens', options.maxTokens.toString());
    }
    
    // Add the task description/prompt as the last argument
    args.push(task.description);
    
    return args;
  }
  
  /**
   * Generate event stream from OpenCode process output
   */
  private async *createEventStream(
    task: Task,
    emitter: EventEmitter,
    spawnProcess: () => void
  ): AsyncIterable<ExecutionEventCreateInput> {
    // Start the process
    spawnProcess();
    
    // Initial event
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'OpenCode execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'opencode' },
    };
    
    // Buffer for incomplete lines
    let buffer = '';
    
    // Listen to output events
    const outputQueue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errorQueue: Error[] = [];
    let exitCode: number | null = null;
    let resolver: ((value: boolean) => void) | null = null;
    
    emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => {
      outputQueue.push({ text, stream });
      if (resolver) {
        resolver(true);
        resolver = null;
      }
    });
    
    emitter.on('error', (error: Error) => {
      errorQueue.push(error);
      if (resolver) {
        resolver(true);
        resolver = null;
      }
    });
    
    emitter.on('exit', (code: number) => {
      exitCode = code;
      if (resolver) {
        resolver(false);
        resolver = null;
      }
    });
    
    // Stream events as they arrive
    while (exitCode === null) {
      // Wait for next output or exit
      if (outputQueue.length === 0 && errorQueue.length === 0) {
        await new Promise<boolean>((resolve) => {
          resolver = resolve;
        });
      }
      
      // Process errors
      while (errorQueue.length > 0) {
        const error = errorQueue.shift()!;
        yield {
          task_id: task.id,
          event_type: ExecutionEventType.ERROR,
          message: `Process error: ${error.message}`,
          level: LogLevel.ERROR,
          metadata: { error: error.stack },
        };
      }
      
      // Process output
      while (outputQueue.length > 0) {
        const { text, stream } = outputQueue.shift()!;
        buffer += text;
        
        // Split by newlines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.trim()) {
            const parsed = this.parseOutputLine(line, stream);
            yield this.convertToExecutionEvent(task.id, parsed, line);
          }
        }
      }
    }
    
    // Process any remaining buffer
    if (buffer.trim()) {
      const parsed = this.parseOutputLine(buffer, 'stdout');
      yield this.convertToExecutionEvent(task.id, parsed, buffer);
    }
    
    // Final event
    if (exitCode === 0) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'OpenCode execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'opencode', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `OpenCode execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'opencode', exit_code: exitCode },
      };
    }
  }
  
  /**
   * Parse OpenCode output line to determine event type
   */
  private parseOutputLine(line: string, stream: 'stdout' | 'stderr'): ParsedOutput {
    // Detect tool calls (OpenCode typically logs tool usage)
    if (line.includes('Using tool:') || line.includes('Tool:') || line.includes('Calling')) {
      return {
        type: 'tool_call',
        message: line,
        level: LogLevel.INFO,
      };
    }
    
    // Detect tool results
    if (line.includes('Tool result:') || line.includes('Result:') || line.includes('Success:')) {
      return {
        type: 'tool_result',
        message: line,
        level: LogLevel.INFO,
      };
    }
    
    // Detect errors
    if (stream === 'stderr' || line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
      return {
        type: 'error',
        message: line,
        level: LogLevel.ERROR,
      };
    }
    
    // Detect thinking/reasoning
    if (line.includes('Thinking') || line.includes('Planning') || line.includes('Analyzing')) {
      return {
        type: 'thinking',
        message: line,
        level: LogLevel.DEBUG,
      };
    }
    
    // Default to log
    return {
      type: 'log',
      message: line,
      level: LogLevel.INFO,
    };
  }
  
  /**
   * Convert parsed output to execution event
   */
  private convertToExecutionEvent(
    taskId: string,
    parsed: ParsedOutput,
    rawLine: string
  ): ExecutionEventCreateInput {
    const baseEvent = {
      task_id: taskId,
      message: parsed.message,
      level: parsed.level,
      metadata: { ...parsed.metadata, raw_output: rawLine },
    };
    
    switch (parsed.type) {
      case 'tool_call':
        return {
          ...baseEvent,
          event_type: ExecutionEventType.TOOL_CALL,
          tool_name: this.extractToolName(rawLine),
        };
      
      case 'tool_result':
        return {
          ...baseEvent,
          event_type: ExecutionEventType.TOOL_RESULT,
          tool_name: this.extractToolName(rawLine),
        };
      
      case 'error':
        return {
          ...baseEvent,
          event_type: ExecutionEventType.ERROR,
        };
      
      case 'thinking':
      case 'log':
      default:
        return {
          ...baseEvent,
          event_type: ExecutionEventType.LOG,
        };
    }
  }
  
  /**
   * Extract tool name from output line (basic heuristic)
   */
  private extractToolName(line: string): string | undefined {
    const match = line.match(/(?:Using tool|Tool|Calling):\s*([a-zA-Z_]+)/i);
    return match?.[1];
  }
  
  /**
   * Create result promise
   */
  private async createResultPromise(
    _task: Task,
    emitter: EventEmitter
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      emitter.on('exit', (code: number) => {
        if (code === 0) {
          resolve({
            status: 'completed',
            message: 'OpenCode execution completed successfully',
            metrics: {
              executionTimeMs: 0, // Will be calculated by ExecutionEngine
            },
          });
        } else {
          resolve({
            status: 'failed',
            message: `OpenCode execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: {
              executionTimeMs: 0,
            },
          });
        }
      });
      
      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `OpenCode execution error: ${error.message}`,
          error: error.stack,
          metrics: {
            executionTimeMs: 0,
          },
        });
      });
    });
  }
}
