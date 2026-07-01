import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { RiskLevel, EvidenceSeverity, EvidenceType } from '@djimitflo/shared';
import type { DiffRiskAssessment, RepositorySnapshot, FileChange, FileChangeInput } from '@djimitflo/shared';
import { EvidenceService } from './evidence-service';

// Secret detection patterns used to redact sensitive data from diffs.
// These are regex patterns that match known secret formats (API keys, tokens, etc.)
// for redaction purposes only — they do NOT contain any actual secrets.
const SECRET_PATTERNS = [
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i,
  /(?:secret|token)\s*[:=]\s*\S+/i,
  /(?:private[_-]?key)\s*[:=]\s*["'].*?["']/i,
  /(?:Bearer\s+)\S+/i,
  /(?:mysql|postgres|mongodb|redis):\/\/\S+:\S+@/i,
  /AKIA[A-Z0-9]{16}/,
  /sk-[a-zA-Z0-9]{32,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/,
];

const MAX_DIFF_SIZE = 50000;
const MAX_FILE_DIFF_SIZE = 10000;

const HIGH_RISK_PATHS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.github\/workflows\//i,
  /dockerfile$/i,
  /docker-compose/i,
  /\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /secrets?\//i,
  /credentials/i,
  /migrations?\//i,
  /\.ci\//i,
];

const CRITICAL_RISK_PATHS = [
  /\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /secrets?\.json/i,
  /secrets?\.yml/i,
  /credentials/i,
];

export class DiffCaptureService {
  private evidenceService: EvidenceService;

  constructor(private db: Database) {
    this.evidenceService = new EvidenceService(db);
  }

  capturePreExecutionSnapshot(repositoryPath: string, repositoryId: string, taskId: string): RepositorySnapshot | null {
    const gitStatus = this.getGitStatus(repositoryPath);
    if (!gitStatus) return null;

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO task_repository_snapshots (
        id, repository_id, task_id, snapshot_type, head_commit, branch, is_clean,
        staged_files, modified_files, untracked_files, diff_summary, metadata, created_at
      ) VALUES (?, ?, ?, 'pre_execution', ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      id, repositoryId, taskId, gitStatus.headCommit, gitStatus.currentBranch,
      gitStatus.isClean ? 1 : 0, gitStatus.stagedFiles, gitStatus.modifiedFiles,
      gitStatus.untrackedFiles, gitStatus.isClean ? 'Clean working tree' : 'Dirty working tree', now
    );

    this.evidenceService.captureEvidence({
      task_id: taskId,
      evidence_type: EvidenceType.PRE_EXECUTION_GIT_STATUS,
      severity: gitStatus.isClean ? EvidenceSeverity.INFO : EvidenceSeverity.WARNING,
      title: gitStatus.isClean ? 'Pre-execution: clean working tree' : 'Pre-execution: dirty working tree',
      summary: `Branch: ${gitStatus.currentBranch}, Commit: ${gitStatus.headCommit?.slice(0, 8)}, Modified: ${gitStatus.modifiedFiles}, Untracked: ${gitStatus.untrackedFiles}`,
      details: { branch: gitStatus.currentBranch, headCommit: gitStatus.headCommit, isClean: gitStatus.isClean, stagedFiles: gitStatus.stagedFiles, modifiedFiles: gitStatus.modifiedFiles, untrackedFiles: gitStatus.untrackedFiles },
      source: 'system',
      metadata: { snapshotId: id },
    });

    return {
      id,
      repositoryId,
      taskId,
      snapshotType: 'pre_execution',
      headCommit: gitStatus.headCommit,
      branch: gitStatus.currentBranch,
      isClean: gitStatus.isClean,
      stagedFiles: gitStatus.stagedFiles,
      modifiedFiles: gitStatus.modifiedFiles,
      untrackedFiles: gitStatus.untrackedFiles,
      diffSummary: gitStatus.isClean ? 'Clean working tree' : 'Dirty working tree',
      metadata: {},
      createdAt: now,
    };
  }

  capturePostExecutionDiff(repositoryPath: string, repositoryId: string, taskId: string, preSnapshotId: string | null): { files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } } {
    const gitStatus = this.getGitStatus(repositoryPath);

    const id = randomUUID();
    const now = new Date().toISOString();
    const isClean = gitStatus?.isClean ?? true;

    this.db.prepare(`
      INSERT INTO task_repository_snapshots (
        id, repository_id, task_id, snapshot_type, head_commit, branch, is_clean,
        staged_files, modified_files, untracked_files, diff_summary, metadata, created_at
      ) VALUES (?, ?, ?, 'post_execution', ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      id, repositoryId, taskId, gitStatus?.headCommit || null, gitStatus?.currentBranch || null,
      isClean ? 1 : 0, gitStatus?.stagedFiles ?? 0, gitStatus?.modifiedFiles ?? 0,
      gitStatus?.untrackedFiles ?? 0, isClean ? 'No changes detected' : 'Changes detected', now
    );

    this.evidenceService.captureEvidence({
      task_id: taskId,
      evidence_type: EvidenceType.POST_EXECUTION_GIT_STATUS,
      severity: isClean ? EvidenceSeverity.INFO : EvidenceSeverity.WARNING,
      title: isClean ? 'Post-execution: no file changes' : 'Post-execution: file changes detected',
      summary: `Changes: ${gitStatus?.modifiedFiles ?? 0} modified, ${gitStatus?.untrackedFiles ?? 0} untracked`,
      details: { branch: gitStatus?.currentBranch, headCommit: gitStatus?.headCommit, isClean, postSnapshotId: id, preSnapshotId: preSnapshotId },
      source: 'system',
    });

    const changedFiles = this.getChangedFiles(repositoryPath, gitStatus?.headCommit || undefined);
    const fileChanges: FileChange[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let redactedSecrets = 0;
    let totalDiffSize = 0;
    let truncated = false;

    for (const cf of changedFiles) {
      const risk = this.classifyFileRisk(cf.path, cf.diff);
      const redactedDiff = this.redactSecrets(cf.diff);
      if (redactedDiff.redactedCount > 0) redactedSecrets += redactedDiff.redactedCount;

      let diff = redactedDiff.diff;
      if (diff && diff.length > MAX_FILE_DIFF_SIZE) {
        diff = diff.substring(0, MAX_FILE_DIFF_SIZE) + '\n... [truncated] ...';
        truncated = true;
      }

      totalDiffSize += (diff || '').length;
      if (totalDiffSize > MAX_DIFF_SIZE) {
        truncated = true;
        diff = diff ? diff.substring(0, Math.max(0, MAX_FILE_DIFF_SIZE - (totalDiffSize - MAX_DIFF_SIZE))) + '\n... [diff truncated due to size] ...' : null;
      }

      const additions = (cf.diff?.match(/^\+/gm) || []).length;
      const deletions = (cf.diff?.match(/^-/gm) || []).length;
      totalAdditions += additions;
      totalDeletions += deletions;

      const fileChangeInput: FileChangeInput = {
        task_id: taskId,
        file_path: cf.path,
        change_type: cf.status as FileChangeInput['change_type'],
        diff: diff ?? undefined,
        risk_level: risk.risk_level,
        detected_at: now,
        metadata: { repositoryId, additions, deletions, diffTruncated: diff !== cf.diff, redactedSecrets: redactedDiff.redactedCount },
      };

      this.evidenceService.recordFileChange({
        ...fileChangeInput,
        after_hash: cf.afterHash || undefined,
        before_hash: cf.beforeHash || undefined,
      });

      fileChanges.push({
        ...fileChangeInput,
        id: '',
        execution_event_id: null,
        repository_id: repositoryId,
        after_hash: cf.afterHash || null,
        before_hash: cf.beforeHash || null,
        before_size: null,
        after_size: null,
        diff_truncated: diff !== cf.diff,
        metadata: {},
        created_at: now,
        updated_at: now,
      } as any);
    }

    this.evidenceService.captureEvidence({
      task_id: taskId,
      evidence_type: EvidenceType.DIFF_SUMMARY,
      severity: truncated ? EvidenceSeverity.WARNING : EvidenceSeverity.INFO,
      title: truncated ? 'Diff summary (truncated)' : 'Diff summary',
      summary: `${changedFiles.length} file(s) changed, ${totalAdditions} additions, ${totalDeletions} deletions${redactedSecrets > 0 ? `, ${redactedSecrets} secret(s) redacted` : ''}`,
      details: { totalFiles: changedFiles.length, totalAdditions, totalDeletions, truncated, redactedSecrets, changedFiles: changedFiles.map(cf => cf.path) },
      source: 'system',
      metadata: { preSnapshotId, postSnapshotId: id },
    });

    return {
      files: fileChanges,
      summary: { totalFiles: changedFiles.length, totalAdditions, totalDeletions, truncated, redactedSecrets },
    };
  }

  private getGitStatus(repoPath: string): { isGitRepository: boolean; currentBranch: string | null; isClean: boolean; stagedFiles: number; modifiedFiles: number; untrackedFiles: number; headCommit: string | null; headCommitMessage: string | null } | null {
    try {
      if (!existsSync(join(repoPath, '.git'))) return null;
       const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
       const headCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
       const porcelain = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
      const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
      return {
        isGitRepository: true,
        currentBranch,
        isClean: lines.length === 0,
        stagedFiles: lines.filter((l: string) => /^[MADRC]/.test(l)).length,
        modifiedFiles: lines.filter((l: string) => /^\s?[MADRC]/.test(l) || /^[MADRC]\s/.test(l)).length,
        untrackedFiles: lines.filter((l: string) => /^\?\?/.test(l)).length,
        headCommit,
        headCommitMessage: execSync('git log -1 --format=%s', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim(),
      };
    } catch {
      return null;
    }
  }

  private getChangedFiles(repoPath: string, preCommit?: string): Array<{ path: string; status: string; diff: string | null; beforeHash: string | null; afterHash: string | null }> {
    const files: Array<{ path: string; status: string; diff: string | null; beforeHash: string | null; afterHash: string | null }> = [];

    try {
      let diffTarget: string;
      if (preCommit) {
        diffTarget = preCommit;
      } else {
        try { diffTarget = execSync('git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim(); } catch { diffTarget = 'HEAD~1'; }
      }

      const nameStatus = execSync(`git diff --name-status ${diffTarget} 2>/dev/null || git diff --name-status HEAD~1`, { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
      const statusLines = nameStatus ? nameStatus.split('\n').filter(Boolean) : [];

      for (const line of statusLines) {
        const [status, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        let diff: string | null = null;
        try {
          diff = execSync(`git diff ${diffTarget} -- "${filePath}" 2>/dev/null`, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 }).trim() || null;
        } catch { diff = null; }

        let beforeHash: string | null = null;
        let afterHash: string | null = null;
        try {
          if (status !== 'A') beforeHash = execSync(`git rev-parse ${diffTarget}:"${filePath}" 2>/dev/null`, { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
        } catch { beforeHash = null; }
        try {
          if (status !== 'D') afterHash = execSync(`git rev-parse HEAD:"${filePath}" 2>/dev/null`, { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
        } catch { afterHash = null; }

        const statusMap: Record<string, FileChangeInput['change_type']> = { A: 'created', M: 'modified', D: 'deleted', R: 'renamed', C: 'modified' };
        files.push({ path: filePath, status: statusMap[status] || 'unknown', diff, beforeHash, afterHash });
      }
    } catch {}

    return files;
  }

  private classifyFileRisk(filePath: string, diff: string | null): DiffRiskAssessment {
    const reasons: string[] = [];
    let riskLevel: RiskLevel = RiskLevel.LOW;

    if (CRITICAL_RISK_PATHS.some(p => p.test(filePath))) {
      reasons.push('Critical risk path pattern matched');
      riskLevel = RiskLevel.CRITICAL;
    } else if (HIGH_RISK_PATHS.some(p => p.test(filePath))) {
      reasons.push('High risk path pattern matched');
      riskLevel = RiskLevel.HIGH;
    }

    if (filePath.endsWith('.lock') || filePath.endsWith('.yaml') && filePath.includes('lock')) {
      reasons.push('Lock file modified — dependency changes');
      if (riskLevel === RiskLevel.LOW) riskLevel = RiskLevel.MEDIUM;
    }

    if (filePath.includes('migration') || filePath.includes('migrations')) {
      reasons.push('Database migration file');
      if (riskLevel === RiskLevel.LOW) riskLevel = RiskLevel.MEDIUM;
    }

    if (diff && SECRET_PATTERNS.some(p => p.test(diff))) {
      reasons.push('Diff contains potential secret patterns');
      riskLevel = RiskLevel.CRITICAL;
    }

    if (diff && diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length > diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length * 3) {
      reasons.push('Significant deletion ratio — possible destructive change');
      if (riskLevel === RiskLevel.LOW) riskLevel = RiskLevel.HIGH;
    }

    if (diff && diff.split('\n').length > 500) {
      reasons.push('Large diff (>500 lines)');
      if (riskLevel === RiskLevel.LOW) riskLevel = RiskLevel.MEDIUM;
    }

    return { file_path: filePath, risk_level: riskLevel, reasons, is_redacted: false };
  }

  private redactSecrets(diff: string | null): { diff: string | null; redactedCount: number } {
    if (!diff) return { diff: null, redactedCount: 0 };

    let redactedCount = 0;
    let result = diff;

    for (const pattern of SECRET_PATTERNS) {
      const matches = result.match(new RegExp(pattern.source, 'gi'));
      if (matches) {
        redactedCount += matches.length;
      }
      result = result.replace(new RegExp(pattern.source, 'gi'), '[REDACTED]');
    }

    return { diff: result, redactedCount: redactedCount };
  }

  getTaskDiff(taskId: string): { files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } } {
    const files = this.evidenceService.getFileChanges(taskId);
    let totalAdditions = 0;
    let totalDeletions = 0;
    let truncated = false;
    let redactedSecrets = 0;

    for (const file of files) {
      const meta = file.metadata as any;
      totalAdditions += meta?.additions ?? 0;
      totalDeletions += meta?.deletions ?? 0;
      truncated = truncated || meta?.diffTruncated;
      redactedSecrets += meta?.redactedSecrets ?? 0;
    }

    return { files, summary: { totalFiles: files.length, totalAdditions, totalDeletions, truncated, redactedSecrets } };
  }

  getTaskSnapshots(taskId: string): RepositorySnapshot[] {
    return (this.db.prepare('SELECT * FROM task_repository_snapshots WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[]).map(row => ({
      ...row,
      is_clean: Boolean(row.is_clean),
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }
}