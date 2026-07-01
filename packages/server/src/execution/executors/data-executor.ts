import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';

export interface DataTask {
  type: 'sql' | 'python' | 'dbt' | 'csv' | 'json';
  action: string;
  target: string;
  query?: string;
  config?: Record<string, unknown>;
}

export interface DataResult {
  success: boolean;
  output: string;
  rows?: Record<string, unknown>[];
  errors: string[];
  durationMs: number;
}

export class DataExecutor {
  constructor(_db: Database) { void _db; }

  canExecute(runtime: string): boolean {
    return runtime === 'data';
  }

  async execute(task: DataTask): Promise<DataResult> {
    const start = Date.now();
    let command: string;

    switch (task.type) {
      case 'sql':
        command = `sqlite3 ${task.target} "${task.query ?? ''}"`;
        break;
      case 'python':
        command = `python3 ${task.action} ${task.target}`;
        break;
      case 'dbt':
        command = `dbt ${task.action} --target ${task.target}`;
        break;
      case 'csv':
        command = `cat ${task.target} | head -100`;
        break;
      case 'json':
        command = `cat ${task.target} | python3 -m json.tool`;
        break;
      default:
        return { success: false, output: '', errors: [`Unknown type: ${task.type}`], durationMs: 0 };
    }

    return this.runCommand(command, start);
  }

  async runCommand(command: string, start: number): Promise<DataResult> {
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

  async validateDataIntegrity(target: string, expectedSchema: Record<string, string>): Promise<{ valid: boolean; issues: string[] }> {
    const result = await this.runCommand(`sqlite3 ${target} ".schema"`, Date.now());
    const issues: string[] = [];

    for (const [col, type] of Object.entries(expectedSchema)) {
      if (!result.output.includes(col)) {
        issues.push(`Missing column: ${col}`);
      } else if (!result.output.includes(type)) {
        issues.push(`Type mismatch for ${col}: expected ${type}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }
}
