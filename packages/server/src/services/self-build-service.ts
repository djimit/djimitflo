import { execSync } from 'child_process';
import type { Database } from 'better-sqlite3';

export interface BuildResult {
  success: boolean;
  command: string;
  output: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
  timestamp: string;
}

interface BuildRow {
  id: string;
  command: string;
  success: number;
  output: string;
  errors_json: string;
  warnings_json: string;
  duration_ms: number;
  created_at: string;
}

export class SelfBuildService {
  private rootPath: string;

  constructor(private db: Database) {
    this.rootPath = process.cwd();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_builds (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        output TEXT NOT NULL DEFAULT '',
        errors_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async runBuild(command: string = 'npm run build'): Promise<BuildResult> {
    const start = Date.now();
    let output = '';
    let success = false;

    try {
      output = execSync(command, { cwd: this.rootPath, encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
      success = true;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      output = (e.stdout ?? '') + '\n' + (e.stderr ?? '') + '\n' + (e.message ?? '');
      success = false;
    }

    const duration = Date.now() - start;
    const errors = this.parseErrors(output);
    const warnings = this.parseWarnings(output);

    const id = `build-${Date.now()}`;
    this.db.prepare(`
      INSERT INTO self_builds (id, command, success, output, errors_json, warnings_json, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, command, success ? 1 : 0, output, JSON.stringify(errors), JSON.stringify(warnings), duration);

    return { success, command, output, errors, warnings, durationMs: duration, timestamp: new Date().toISOString() };
  }

  async runTests(): Promise<BuildResult> {
    return this.runBuild('npm run test 2>&1 | head -100');
  }

  async runTypeCheck(): Promise<BuildResult> {
    return this.runBuild('npm run type-check');
  }

  async runLint(): Promise<BuildResult> {
    return this.runBuild('npm run lint');
  }

  getBuildHistory(limit: number = 20): BuildResult[] {
    const rows = this.db.prepare('SELECT * FROM self_builds ORDER BY created_at DESC LIMIT ?').all(limit) as BuildRow[];
    return rows.map(r => ({
      success: r.success === 1,
      command: r.command,
      output: r.output,
      errors: JSON.parse(r.errors_json) as string[],
      warnings: JSON.parse(r.warnings_json) as string[],
      durationMs: r.duration_ms,
      timestamp: r.created_at,
    }));
  }

  getLastError(): string[] {
    const row = this.db.prepare('SELECT errors_json FROM self_builds WHERE success = 0 ORDER BY created_at DESC LIMIT 1').get() as { errors_json: string } | undefined;
    return row ? JSON.parse(row.errors_json) as string[] : [];
  }

  private parseErrors(output: string): string[] {
    return output.split('\n').filter(line =>
      line.includes('error') || line.includes('Error') || line.includes('ERROR') || line.includes('FAIL')
    ).slice(0, 20);
  }

  private parseWarnings(output: string): string[] {
    return output.split('\n').filter(line =>
      line.includes('warning') || line.includes('Warning') || line.includes('WARN') || line.includes('deprecated')
    ).slice(0, 20);
  }
}
