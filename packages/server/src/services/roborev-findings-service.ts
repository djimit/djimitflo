import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RoborevFinding {
  task_title: string;
  task_type: string;
  severity: string;
  finding_class: string | null;
  affected_files: string[];
  context: string;
}

const DEFAULT_PENDING_PATH = path.join(os.homedir(), '.djimit', 'roborev', 'paperclip-tasks.pending.jsonl');

/**
 * Read-only view onto roborev's commit-level static findings (its own
 * `roborev emit` pending JSONL, shipped separately to Paperclip — see
 * .claude/plans/zany-coalescing-teapot.md Phase 3). Never triggers a
 * loop_run or goes through IntegrationInboxService: this is purely
 * additional, informational content folded into the same PR comment
 * djimitflo's own maker/checker review already produces.
 */
export class RoborevFindingsService {
  private pendingPath: string;

  constructor(pendingPath = process.env.ROBOREV_PENDING_PATH || DEFAULT_PENDING_PATH) {
    this.pendingPath = pendingPath;
  }

  /**
   * A roborev `sha` mismatch (it scanned a different commit than this PR's
   * exact head) is a normal, silent no-op — callers should omit the
   * findings section entirely rather than treat an empty result as an error.
   */
  readPending(repoFullName: string, sha: string): RoborevFinding[] {
    if (!fs.existsSync(this.pendingPath)) return [];
    const lines = fs.readFileSync(this.pendingPath, 'utf8').split('\n').filter((line) => line.trim());
    const findings: RoborevFinding[] = [];
    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.repo !== repoFullName || event.sha !== sha) continue;
      findings.push({
        task_title: String(event.task_title || 'roborev finding'),
        task_type: String(event.task_type || 'review_fix'),
        severity: String(event.severity || 'medium'),
        finding_class: typeof event.finding_class === 'string' ? event.finding_class : null,
        affected_files: Array.isArray(event.affected_files) ? event.affected_files.map(String) : [],
        context: typeof event.context === 'string' ? event.context : '',
      });
    }
    return findings;
  }
}
