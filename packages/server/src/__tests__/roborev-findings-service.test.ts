import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoborevFindingsService, type RoborevFinding } from '../services/roborev-findings-service';

describe('RoborevFindingsService', () => {
  let dir: string | undefined;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ROBOREV_PENDING_PATH;
  });

  afterEach(() => {
    process.env.ROBOREV_PENDING_PATH = prevEnv.ROBOREV_PENDING_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns an empty array when the pending file does not exist', () => {
    const service = new RoborevFindingsService('/nonexistent/path/paperclip-tasks.pending.jsonl');
    expect(service.readPending('owner/repo', 'a'.repeat(40))).toEqual([]);
  });

  it('honours the ROBOREV_PENDING_PATH env var when no path is passed to the constructor', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = 'f'.repeat(40);
    writeFileSync(pendingPath, JSON.stringify({ repo: 'owner/repo', sha, task_title: 'env', task_type: 'review_fix', severity: 'low' }) + '\n', 'utf8');
    process.env.ROBOREV_PENDING_PATH = pendingPath;
    const service = new RoborevFindingsService();
    expect(service.readPending('owner/repo', sha)).toMatchObject([{ task_title: 'env' }]);
  });

  it('falls back to the default pending path when neither env nor constructor arg are set', () => {
    const service = new RoborevFindingsService();
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

  it('splits pending content on newlines and ignores blank lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = '1'.repeat(40);
    const content =
      JSON.stringify({ repo: 'owner/repo', sha, task_title: 'first', task_type: 'review_fix', severity: 'low' }) +
      '\n\n' +
      JSON.stringify({ repo: 'owner/repo', sha, task_title: 'second', task_type: 'review_fix', severity: 'low' }) +
      '\n';
    writeFileSync(pendingPath, content, 'utf8');
    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings.map((f) => f.task_title)).toEqual(['first', 'second']);
  });

  it('applies defaults for missing task_type, finding_class, affected_files and context', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = '2'.repeat(40);
    writeFileSync(
      pendingPath,
      JSON.stringify({ repo: 'owner/repo', sha, task_title: 'sparse', task_type: null, severity: null }) + '\n',
      'utf8',
    );
    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings).toHaveLength(1);
    const expected: RoborevFinding = {
      task_title: 'sparse',
      task_type: 'review_fix',
      severity: 'medium',
      finding_class: null,
      affected_files: [],
      context: '',
    };
    expect(findings[0]).toEqual(expected);
  });

  it('preserves explicit finding_class, affected_files (coerced to strings) and context strings', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = '3'.repeat(40);
    writeFileSync(
      pendingPath,
      JSON.stringify({
        repo: 'owner/repo',
        sha,
        task_title: 'rich',
        task_type: 'triage',
        severity: 'high',
        finding_class: 'complexity',
        affected_files: ['a.ts', 42],
        context: 'details here',
      }) + '\n',
      'utf8',
    );
    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings).toEqual([
      {
        task_title: 'rich',
        task_type: 'triage',
        severity: 'high',
        finding_class: 'complexity',
        affected_files: ['a.ts', '42'],
        context: 'details here',
      },
    ]);
  });

  it('coerces non-string finding_class and context to null and empty string respectively', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = '4'.repeat(40);
    writeFileSync(
      pendingPath,
      JSON.stringify({
        repo: 'owner/repo',
        sha,
        task_title: 'typed',
        task_type: 'review_fix',
        severity: 'low',
        finding_class: 123,
        affected_files: 'not-an-array',
        context: { nested: true },
      }) + '\n',
      'utf8',
    );
    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings).toEqual([
      {
        task_title: 'typed',
        task_type: 'review_fix',
        severity: 'low',
        finding_class: null,
        affected_files: [],
        context: '',
      },
    ]);
  });

  it('defaults task_title to roborev finding when absent', () => {
    dir = mkdtempSync(join(tmpdir(), 'roborev-findings-'));
    const pendingPath = join(dir, 'pending.jsonl');
    const sha = '5'.repeat(40);
    writeFileSync(pendingPath, JSON.stringify({ repo: 'owner/repo', sha, task_type: 'review_fix', severity: 'low' }) + '\n', 'utf8');
    const service = new RoborevFindingsService(pendingPath);
    const findings = service.readPending('owner/repo', sha);
    expect(findings).toHaveLength(1);
    expect(findings[0].task_title).toBe('roborev finding');
  });
});
