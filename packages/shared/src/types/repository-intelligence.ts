/**
 * Repository intelligence, AGENTS.md governance, and diff awareness types
 */

import { ID, Timestamps, RiskLevel } from './common';
import type { Repository } from './repository';

export type RepositoryProvider = 'local' | 'github' | 'gitlab' | 'unknown';
export type RepositoryStatus = 'active' | 'missing' | 'inaccessible' | 'dirty' | 'clean' | 'unknown';

export interface RepositoryScanResult {
  scanId: ID;
  repository: Repository;
  gitStatus: GitStatusResult | null;
  stack: StackDetection;
  health: RepositoryHealth;
  agentsMdFiles: AgentsMdFile[];
  healthFindings: RepositoryHealthFinding[];
  scanSummary: ScanSummary;
}

export interface ScanSummary {
  secretScan: SecretScanSummary;
  dependencyManifest: DependencyManifest;
  license: LicenseInfo | null;
  contributors: ContributorInfo[];
  tags: TagInfo[];
}

export interface SecretScanSummary {
  clean: boolean;
  findings: SecretScanFinding[];
}

export interface SecretScanFinding {
  file: string;
  pattern: string;
  severity: 'warning' | 'critical';
}

export interface DependencyManifest {
  packageManager: string;
  manifestFiles: string[];
  packages: DependencyPackage[];
  auditFindings: DependencyAuditFinding[];
}

export interface DependencyPackage {
  name: string;
  version: string | null;
  type: 'runtime' | 'dev' | 'peer' | 'unknown';
}

export interface DependencyAuditFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  packageName: string;
  message: string;
}

export interface LicenseInfo {
  license: string;
  source: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ContributorInfo {
  name: string;
  email: string | null;
  commitCount: number;
}

export interface TagInfo {
  name: string;
  commit: string | null;
}

export interface GitStatusResult {
  isGitRepository: boolean;
  currentBranch: string | null;
  defaultBranch: string | null;
  isClean: boolean;
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
  aheadBehind: { ahead: number; behind: number } | null;
  headCommit: string | null;
  headCommitMessage: string | null;
}

export interface StackDetection {
  detectedStacks: string[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  devCommands: string[];
  hasTypeScript: boolean;
  hasTests: boolean;
  hasLint: boolean;
  hasCI: boolean;
  hasDocker: boolean;
}

export interface RepositoryHealth {
  score: number;
  drivers: HealthScoreDriver[];
}

export interface HealthScoreDriver {
  factor: string;
  impact: number;
  description: string;
}

export interface RepositoryHealthFinding {
  id: string;
  repositoryId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: string;
  title: string;
  description: string;
  recommendation: string | null;
  discoveredAt: string;
}

export interface AgentsMdFile extends Timestamps {
  id: ID;
  repositoryId: string;
  path: string;
  relativePath: string;
  appliesToPath: string;
  contentHash: string;
  sizeBytes: number;
  content: string | null;
  discoveredAt: string;
}

export type AgentsMdIssueSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AgentsMdIssue {
  id: ID;
  fileId: ID;
  severity: AgentsMdIssueSeverity;
  ruleId: string;
  title: string;
  description: string;
  recommendation: string | null;
}

export interface EffectiveInstructionStack {
  repositoryId: string;
  targetPath: string;
  files: AgentsMdFile[];
  issues: AgentsMdIssue[];
  summary: string;
}

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

export interface DiffSummary {
  taskId: string;
  repositoryId: string | null;
  preSnapshotId: string | null;
  postSnapshotId: string | null;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
  redactedSecrets: number;
  capturedAt: string;
}

export interface RepositorySnapshot {
  id: ID;
  repositoryId: ID;
  taskId: ID | null;
  snapshotType: 'pre_execution' | 'post_execution' | 'manual';
  headCommit: string | null;
  branch: string | null;
  isClean: boolean;
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
  diffSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DiffRiskAssessment {
  file_path: string;
  risk_level: RiskLevel;
  reasons: string[];
  is_redacted: boolean;
}