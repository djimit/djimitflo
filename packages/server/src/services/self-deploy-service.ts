import { execSync } from 'child_process';
import type { Database } from 'better-sqlite3';

export interface DeployResult {
  success: boolean;
  commitSha: string;
  message: string;
  timestamp: string;
  rolledBack: boolean;
}

interface DeployRow {
  id: string;
  commit_sha: string;
  message: string;
  success: number;
  rolled_back: number;
  created_at: string;
}

export class SelfDeployService {
  private rootPath: string;

  constructor(private db: Database) {
    this.rootPath = process.cwd();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_deploys (
        id TEXT PRIMARY KEY,
        commit_sha TEXT NOT NULL,
        message TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        rolled_back INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  commitChanges(message: string): { success: boolean; sha: string } {
    try {
      execSync('git add -A', { cwd: this.rootPath, stdio: 'pipe', timeout: 10_000 });
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: this.rootPath, stdio: 'pipe', timeout: 10_000 });
      const sha = execSync('git rev-parse HEAD', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      return { success: true, sha };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, sha: e.message ?? 'unknown error' };
    }
  }

  pushToRemote(): { success: boolean; output: string } {
    try {
      const output = execSync('git push origin HEAD', { cwd: this.rootPath, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
      return { success: true, output };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      return { success: false, output: (e.stdout ?? '') + (e.stderr ?? '') };
    }
  }

  rollback(commitSha: string): { success: boolean } {
    try {
      execSync(`git revert --no-edit ${commitSha}`, { cwd: this.rootPath, stdio: 'pipe', timeout: 10_000 });
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  deploy(message: string): DeployResult {
    const commit = this.commitChanges(message);
    if (!commit.success) {
      return { success: false, commitSha: '', message: `Commit failed: ${commit.sha}`, timestamp: new Date().toISOString(), rolledBack: false };
    }

    const push = this.pushToRemote();
    const result: DeployResult = {
      success: push.success,
      commitSha: commit.sha,
      message,
      timestamp: new Date().toISOString(),
      rolledBack: false,
    };

    this.db.prepare(`
      INSERT INTO self_deploys (id, commit_sha, message, success, rolled_back)
      VALUES (?, ?, ?, ?, 0)
    `).run(`deploy-${Date.now()}`, commit.sha, message, push.success ? 1 : 0);

    if (!push.success) {
      this.rollback(commit.sha);
      result.rolledBack = true;
      this.db.prepare("UPDATE self_deploys SET rolled_back = 1 WHERE commit_sha = ?").run(commit.sha);
    }

    return result;
  }

  getDeployHistory(limit: number = 20): DeployResult[] {
    const rows = this.db.prepare('SELECT * FROM self_deploys ORDER BY created_at DESC LIMIT ?').all(limit) as DeployRow[];
    return rows.map(r => ({
      success: r.success === 1,
      commitSha: r.commit_sha,
      message: r.message,
      timestamp: r.created_at,
      rolledBack: r.rolled_back === 1,
    }));
  }

  getCurrentCommit(): string {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
    } catch {
      return 'unknown';
    }
  }

  hasUncommittedChanges(): boolean {
    try {
      const output = execSync('git status --porcelain', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      return output.length > 0;
    } catch {
      return false;
    }
  }
}
