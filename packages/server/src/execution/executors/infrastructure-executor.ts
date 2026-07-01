import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';

export interface InfrastructureTask {
  type: 'docker' | 'kubernetes' | 'ansible' | 'terraform';
  action: string;
  target: string;
  config?: Record<string, unknown>;
}

export interface InfrastructureResult {
  success: boolean;
  output: string;
  errors: string[];
  durationMs: number;
}

export class InfrastructureExecutor {
  constructor(private db: Database) {}

  canExecute(runtime: string): boolean {
    return runtime === 'infrastructure';
  }

  async execute(task: InfrastructureTask): Promise<InfrastructureResult> {
    const start = Date.now();
    let command: string;

    switch (task.type) {
      case 'docker':
        command = `docker ${task.action} ${task.target}`;
        break;
      case 'kubernetes':
        command = `kubectl ${task.action} ${task.target}`;
        break;
      case 'ansible':
        command = `ansible-playbook -i ${task.target} ${task.action}`;
        break;
      case 'terraform':
        command = `terraform ${task.action} ${task.target}`;
        break;
      default:
        return { success: false, output: '', errors: [`Unknown type: ${task.type}`], durationMs: 0 };
    }

    return this.runCommand(command, start);
  }

  async runCommand(command: string, start: number): Promise<InfrastructureResult> {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command], { cwd: process.cwd() });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        const duration = Date.now() - start;
        resolve({
          success: code === 0,
          output: stdout,
          errors: stderr ? stderr.split('\n').filter(Boolean) : [],
          durationMs: duration,
        });
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: stdout,
          errors: [err.message],
          durationMs: Date.now() - start,
        });
      });
    });
  }

  async healthCheck(target: string): Promise<{ healthy: boolean; details: string }> {
    try {
      const result = await this.runCommand(`docker inspect --format='{{.State.Status}}' ${target}`, Date.now());
      return { healthy: result.output.trim() === 'running', details: result.output };
    } catch {
      return { healthy: false, details: 'Health check failed' };
    }
  }
}
