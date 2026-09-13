import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoborevFindingsService } from '../services/roborev-findings-service';

describe('RoborevFindingsService', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the pending file does not exist', () => {
    const service = new RoborevFindingsService('/nonexistent/path/paperclip-tasks.pending.jsonl');
    expect(service.readPending('owner/repo', 'a'.repeat(40))).toEqual([]);
  });

  it('filters findings by exact repo and sha match, tolerating malformed lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = 'b'.repeat(40);
    const lines = [
      JSON.stringify({ repo: 'owner/repo', sha, task_title: 'Fix flaky auth test', task_type: 'review_fix', severity: 'high', affected_files: ['src/auth.ts'], context: 'flaky' }),
      JSON.stringify({ repo: 'owner/other-repo', sha, task_title: 'Unrelated repo', task_type: 'review_fix', severity: 'low' }),
      JSON.stringify({ repo: 'owner/repo', sha: 'c'.repeat(40), task_title: 'Different commit', task_type: 'review_fix', severity: 'low' }),
      'not valid json',
      JSON.stringify({ repo: 'owner/repo', sha, task_title: 'Second finding same commit', task_type: 'triage', severity: 'medium' }),
    ];
    writeFileSync(pendingPath, lines.join('\n') + '\n', 'utf8');

    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ task_title: 'Fix flaky auth test', severity: 'high', affected_files: ['src/auth.ts'] });
    expect(findings[1]).toMatchObject({ task_title: 'Second finding same commit', severity: 'medium' });
  });

  it('returns an empty array on a sha mismatch (roborev scanned a different commit) rather than erroring', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    writeFileSync(pendingPath, JSON.stringify({ repo: 'owner/repo', sha: 'd'.repeat(40), task_title: 'x', task_type: 'review_fix', severity: 'low' }) + '\n', 'utf8');
    const service = new RoborevFindingsService(pendingPath);
    expect(service.readPending('owner/repo', 'e'.repeat(40))).toEqual([]);
  });
});
