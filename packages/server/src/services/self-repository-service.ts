import { execSync } from 'child_process';
import type { Database } from 'better-sqlite3';

export interface SelfRepositoryInfo {
  isSelfHosted: boolean;
  remoteUrl: string;
  branch: string;
  commitSha: string;
  lastCommitDate: string;
  hasUncommittedChanges: boolean;
  rootPath: string;
}

interface RepoRow {
  id: string;
  name: string;
  url: string;
  metadata: string;
}

export class SelfRepositoryService {
  private rootPath: string;

  constructor(private db: Database) {
    this.rootPath = process.cwd();
  }

  detectSelfRepository(): SelfRepositoryInfo {
    try {
      const remoteUrl = execSync('git remote get-url origin', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      const branch = execSync('git branch --show-current', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      const commitSha = execSync('git rev-parse HEAD', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      const lastCommitDate = execSync('git log -1 --format=%ci', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      const statusOutput = execSync('git status --porcelain', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      const hasUncommittedChanges = statusOutput.length > 0;

      return {
        isSelfHosted: true,
        remoteUrl,
        branch,
        commitSha,
        lastCommitDate,
        hasUncommittedChanges,
        rootPath: this.rootPath,
      };
    } catch {
      return {
        isSelfHosted: false,
        remoteUrl: '',
        branch: '',
        commitSha: '',
        lastCommitDate: '',
        hasUncommittedChanges: false,
        rootPath: this.rootPath,
      };
    }
  }

  registerSelfRepository(): { registered: boolean; id: string } {
    const info = this.detectSelfRepository();
    if (!info.isSelfHosted) return { registered: false, id: '' };

    const existing = this.db.prepare("SELECT id FROM repositories WHERE metadata->>'$.type' = 'self'").get() as { id: string } | undefined;
    if (existing) {
      this.db.prepare("UPDATE repositories SET name = ?, git_remote = ?, git_branch = ?, git_commit = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?")
        .run('djimitflo-self', info.remoteUrl, info.branch, info.commitSha, JSON.stringify({ type: 'self', branch: info.branch, commit: info.commitSha }), existing.id);
      return { registered: true, id: existing.id };
    }

    const id = `repo-self-${Date.now()}`;
    this.db.prepare(`
      INSERT INTO repositories (id, name, description, path, git_remote, git_branch, git_commit, metadata, created_at, updated_at)
      VALUES (?, 'djimitflo-self', 'Djimitflo self-repository', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, info.rootPath, info.remoteUrl, info.branch, info.commitSha, JSON.stringify({ type: 'self', branch: info.branch, commit: info.commitSha }));

    return { registered: true, id };
  }

  getSelfRepository(): RepoRow | null {
    const row = this.db.prepare("SELECT id, name, git_remote as url, metadata FROM repositories WHERE metadata->>'$.type' = 'self'").get() as RepoRow | undefined;
    return row ?? null;
  }

  updateCommitTracking(): void {
    const info = this.detectSelfRepository();
    if (!info.isSelfHosted) return;

    const existing = this.db.prepare("SELECT id, metadata FROM repositories WHERE metadata->>'$.type' = 'self'").get() as { id: string; metadata: string } | undefined;
    if (!existing) return;

    const metadata = JSON.parse(existing.metadata) as Record<string, unknown>;
    metadata.commit = info.commitSha;
    metadata.branch = info.branch;
    metadata.lastCommitDate = info.lastCommitDate;
    metadata.hasUncommittedChanges = info.hasUncommittedChanges;
    metadata.lastSyncedAt = new Date().toISOString();

    this.db.prepare("UPDATE repositories SET git_commit = ?, git_branch = ?, metadata = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(info.commitSha, info.branch, JSON.stringify(metadata), existing.id);
  }

  getDiff(): string {
    try {
      return execSync('git diff', { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
    } catch {
      return '';
    }
  }

  getRecentCommits(limit: number = 10): Array<{ sha: string; message: string; date: string; author: string }> {
    try {
      const output = execSync(`git log --pretty=format:'%H|%s|%ci|%an' -n ${limit}`, { cwd: this.rootPath, encoding: 'utf8', timeout: 10_000 }).trim();
      if (!output) return [];
      return output.split('\n').map(line => {
        const [sha, message, date, author] = line.split('|');
        return { sha: sha ?? '', message: message ?? '', date: date ?? '', author: author ?? '' };
      });
    } catch {
      return [];
    }
  }
}
