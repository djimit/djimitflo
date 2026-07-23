/**
 * LoopPersistenceService — handles loop state persistence and git operations.
 *
 * Extracted from LoopService to isolate filesystem and git operations
 * into a single testable service.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LoopFinding, LoopGate, LoopName } from './loop-types';
import type { GoalRecord } from './goal-service';

export interface LoopStateInput {
  loopName: LoopName;
  runId: string;
  goal: GoalRecord | null;
  repositoryPath: string;
  findings: LoopFinding[];
  plan: Record<string, unknown>;
  gates: LoopGate[];
  nextActions: string[];
  createdAt: string;
}

export class LoopPersistenceService {
  constructor(
    private evidenceRoot: string,
  ) {}

  /**
   * Execute a git command in a repository.
   */
  git(repositoryPath: string, args: string[]): string {
    try {
      return execFileSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() || '';
      throw new Error(stderr.trim() || `git ${args.join(' ')} failed`);
    }
  }

  /**
   * Write loop state to a markdown file.
   */
  writeLoopState(runId: string, input: LoopStateInput): string {
    const runDir = path.join(this.evidenceRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'LOOP_STATE.md');
    const lines = [
      `# ${input.loopName}`,
      '',
      `Run ID: ${input.runId}`,
      `Created: ${input.createdAt}`,
      `Repository: ${input.repositoryPath}`,
      `Goal: ${input.goal?.objective || `ad-hoc ${input.loopName} scan`}`,
      '',
      '## Gates',
      '',
      ...input.gates.map((gate) => `- ${gate.name}: ${gate.status} - ${gate.evidence}`),
      '',
      '## Findings',
      '',
      ...(input.findings.length
        ? input.findings.map((finding) => `- ${finding.type} ${finding.file}${finding.line ? `:${finding.line}` : ''} - ${finding.message}`)
        : ['- None']),
      '',
      '## Next Actions',
      '',
      ...input.nextActions.map((action) => `- ${action}`),
      '',
      '## Plan',
      '',
      '```json',
      JSON.stringify(input.plan, null, 2),
      '```',
      '',
    ];
    fs.writeFileSync(statePath, lines.join('\n'), 'utf8');
    return statePath;
  }

  /**
   * Generate a human-readable title for a finding.
   */
  titleForFinding(finding: LoopFinding): string {
    if (finding.type === 'missing_script_reference') return `Fix stale npm script reference in ${finding.file}`;
    if (finding.type === 'broken_relative_link') return `Fix broken Markdown link in ${finding.file}`;
    if (finding.type === 'draft_loop_skill') return `Validate loop skill ${path.basename(finding.file, '.md')}`;
    if (finding.type.includes('security')) return `Review security finding in ${finding.file}`;
    if (finding.type.includes('mcp')) return `Validate MCP connector finding in ${finding.file}`;
    if (finding.type.includes('okf')) return `Synchronize OKF finding in ${finding.file}`;
    if (finding.type.includes('policy')) return `Review policy drift in ${finding.file}`;
    if (finding.type.includes('skill')) return `Validate skill finding in ${finding.file}`;
    return `Resolve loop finding in ${finding.file}`;
  }

  /**
   * Get the evidence directory for a run.
   */
  getEvidenceDir(runId: string): string {
    return path.join(this.evidenceRoot, runId);
  }

  /**
   * Check if a run's state file exists.
   */
  stateFileExists(runId: string): boolean {
    return fs.existsSync(path.join(this.evidenceRoot, runId, 'LOOP_STATE.md'));
  }

  /**
   * Read a run's state file.
   */
  readStateFile(runId: string): string | null {
    const statePath = path.join(this.evidenceRoot, runId, 'LOOP_STATE.md');
    if (!fs.existsSync(statePath)) return null;
    return fs.readFileSync(statePath, 'utf8');
  }

  /**
   * Delete a run's evidence directory.
   */
  deleteEvidence(runId: string): void {
    const runDir = path.join(this.evidenceRoot, runId);
    if (fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }
}
