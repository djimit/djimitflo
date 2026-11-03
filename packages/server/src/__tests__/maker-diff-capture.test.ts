import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { GYM_DIFF_MAX_BYTES } from '../services/remote-gym-service';
import { MAKER_DIFF_MAX_BYTES, captureMakerDiff, makerDiffCaptureOn } from '../services/maker-diff-capture';

const { redactCtl } = vi.hoisted(() => ({
  redactCtl: {
    mode: 'real' as 'real' | 'throw' | 'fixed',
    throwValue: undefined as unknown,
    fixedReturn: null as null | { redacted: string; count: number },
  },
}));
vi.mock('../services/secret-patterns', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/secret-patterns')>();
  return { ...real, redactSecrets: (text: string): { redacted: string; count: number } => {
    if (redactCtl.mode === 'throw') throw redactCtl.throwValue;
    if (redactCtl.mode === 'fixed') return redactCtl.fixedReturn!;
    return real.redactSecrets(text);
  } };
});

/** MAKER_DIFF_CAPTURE: a completed maker lease stores the redacted, capped worktree diff as metadata.diff; never changes the outcome. */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  redactCtl.mode = 'real'; redactCtl.throwValue = undefined; redactCtl.fixedReturn = null;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SECRET = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

async function runMaker(change: (repo: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-mdc-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Small documentation fixture\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('mdc-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Improve wording', evidence: 'Small text', suggested_fix: 'Clarify wording' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'mdc-run', role: 'maker', runtime: 'opencode', findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: () => Promise<unknown> }, 'executeViaEngine')
    .mockImplementation(async () => { change(repo); return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' }; });
  const result = await loops.executeMaker('mdc-run', { lease_id: 'maker' });
  return { result, lease: loops.getWorkerLease('maker') };
}

const smallChange = (repo: string) => fs.writeFileSync(path.join(repo, 'README.md'), `Clearer documentation fixture\nconst t = "${SECRET}";\n`);
const outcome = (r: Awaited<ReturnType<typeof runMaker>>) => ({ lease: r.lease.status, run: r.result.run.status, diff_lines: r.lease.metadata.diff_lines,
  gates: r.result.gates.map((g) => [g.name, g.status]), failure_reason: r.lease.metadata.failure_reason ?? null });

describe('MAKER_DIFF_CAPTURE', () => {
  it('uses the same cap as the gym', () => {
    expect(MAKER_DIFF_MAX_BYTES).toBe(GYM_DIFF_MAX_BYTES);
  });

  it('on: stores the redacted diff with its sha256, untruncated', async () => {
    vi.stubEnv('MAKER_DIFF_CAPTURE', 'on');
    const { lease } = await runMaker(smallChange);
    const m = lease.metadata;
    expect(typeof m.diff).toBe('string');
    expect(m.diff).toContain('+Clearer documentation fixture');
    expect(m.diff).not.toContain(SECRET);
    expect(m.diff).toContain('[REDACTED:GitHub PAT]');
    expect(m.diff_redacted).toBeGreaterThanOrEqual(1);
    expect(m.diff_truncated).toBe(false);
    expect(m.diff_sha256).toBe(createHash('sha256').update(String(m.diff)).digest('hex'));
    expect(m.diff_capture_error).toBeUndefined();
  });

  it('on: caps a large diff (new untracked file included) at the gym byte cap', async () => {
    vi.stubEnv('MAKER_DIFF_CAPTURE', 'on');
    const { lease } = await runMaker((repo) => fs.writeFileSync(path.join(repo, 'big.test.ts'), Array.from({ length: 4000 }, (_, i) => `// line ${i} é`).join('\n')));
    const m = lease.metadata;
    expect(m.diff).toContain('big.test.ts');
    expect(Buffer.byteLength(String(m.diff), 'utf8')).toBeLessThanOrEqual(MAKER_DIFF_MAX_BYTES);
    expect(m.diff_truncated).toBe(true);
    expect(String(m.diff)).not.toMatch(/�$/);
  });

  it('off (default): stores no diff fields and the outcome equals the on run', async () => {
    const off = await runMaker(smallChange);
    for (const k of ['diff', 'diff_sha256', 'diff_truncated', 'diff_redacted', 'diff_capture_error']) expect(off.lease.metadata[k]).toBeUndefined();
    vi.stubEnv('MAKER_DIFF_CAPTURE', 'on');
    const on = await runMaker(smallChange);
    expect(outcome(on)).toEqual(outcome(off));
  });

  it('a capture error stores no diff, records the reason and leaves the outcome identical', async () => {
    vi.stubEnv('MAKER_DIFF_CAPTURE', 'on');
    const ok = await runMaker(smallChange);
    redactCtl.mode = 'throw'; redactCtl.throwValue = new Error('redact boom');
    const broken = await runMaker(smallChange);
    expect(outcome(broken)).toEqual(outcome(ok));
    expect(broken.lease.metadata.diff).toBeUndefined();
    expect(broken.lease.metadata.diff_sha256).toBeUndefined();
    expect(broken.lease.metadata.diff_capture_error).toBe('redact boom');
  });
});
describe('captureMakerDiff unit', () => {
  const ON = { MAKER_DIFF_CAPTURE: 'on' } as NodeJS.ProcessEnv;

  it('makerDiffCaptureOn is strictly case-sensitive "on"', () => {
    expect(makerDiffCaptureOn({ MAKER_DIFF_CAPTURE: 'on' })).toBe(true);
    expect(makerDiffCaptureOn({ MAKER_DIFF_CAPTURE: 'off' })).toBe(false);
    expect(makerDiffCaptureOn({})).toBe(false);
    expect(makerDiffCaptureOn({ MAKER_DIFF_CAPTURE: 'ON' })).toBe(false);
    expect(makerDiffCaptureOn({ MAKER_DIFF_CAPTURE: '' })).toBe(false);
    expect(makerDiffCaptureOn({ MAKER_DIFF_CAPTURE: ' on' })).toBe(false);
  });

  it('returns empty object when off, even with non-empty raw', () => {
    expect(captureMakerDiff('diff content here', {})).toEqual({});
    expect(captureMakerDiff('', {})).toEqual({});
  });

  it('returns diff_capture_error=empty_diff for empty raw when on', () => {
    expect(captureMakerDiff('', ON)).toEqual({ diff_capture_error: 'empty_diff' });
  });

  it('does not truncate a diff that is exactly at the byte cap', () => {
    const exact = 'a'.repeat(MAKER_DIFF_MAX_BYTES);
    redactCtl.mode = 'fixed';
    redactCtl.fixedReturn = { redacted: exact, count: 0 };
    const r = captureMakerDiff(exact, ON) as Record<string, unknown>;
    expect(r.diff_truncated).toBe(false);
    expect(Buffer.byteLength(String(r.diff), 'utf8')).toBe(MAKER_DIFF_MAX_BYTES);
    expect(r.diff_redacted).toBe(0);
  });

  it('truncates and strips trailing replacement char one byte over the cap', () => {
    // é (U+00E9) is 2 bytes in UTF-8; place it so its second byte lands at position MAKER_DIFF_MAX_BYTES
    const prefix = 'a'.repeat(MAKER_DIFF_MAX_BYTES - 1);
    const text = prefix + '\u00e9' + 'tail';
    redactCtl.mode = 'fixed';
    redactCtl.fixedReturn = { redacted: text, count: 0 };
    const r = captureMakerDiff(text, ON) as Record<string, unknown>;
    expect(r.diff_truncated).toBe(true);
    const diffStr = String(r.diff);
    expect(diffStr).not.toMatch(/\uFFFD+$/);
    expect(Buffer.byteLength(diffStr, 'utf8')).toBeLessThanOrEqual(MAKER_DIFF_MAX_BYTES);
  });

  it('marks truncated when raw exceeds 4×cap even if redacted output fits in cap', () => {
    redactCtl.mode = 'fixed';
    redactCtl.fixedReturn = { redacted: 'small', count: 3 };
    const bigRaw = 'x'.repeat(4 * MAKER_DIFF_MAX_BYTES + 1);
    const r = captureMakerDiff(bigRaw, ON) as Record<string, unknown>;
    expect(r.diff_truncated).toBe(true);
    expect(r.diff_redacted).toBe(3);
  });

  it('does not mark truncated when raw is exactly 4×cap and redacted fits', () => {
    redactCtl.mode = 'fixed';
    redactCtl.fixedReturn = { redacted: 'ok', count: 0 };
    const exactRaw = 'y'.repeat(4 * MAKER_DIFF_MAX_BYTES);
    const r = captureMakerDiff(exactRaw, ON) as Record<string, unknown>;
    expect(r.diff_truncated).toBe(false);
  });

  it('truncates error message to 200 chars on throw', () => {
    redactCtl.mode = 'throw';
    redactCtl.throwValue = new Error('E'.repeat(500));
    const r = captureMakerDiff('some diff', ON) as Record<string, unknown>;
    expect(r.diff_capture_error).toBe('E'.repeat(200));
    expect(r.diff).toBeUndefined();
  });

  it('stringifies non-Error throws via String(err)', () => {
    redactCtl.mode = 'throw';
    redactCtl.throwValue = 'plain string failure';
    const r = captureMakerDiff('some diff', ON) as Record<string, unknown>;
    expect(r.diff_capture_error).toBe('plain string failure');
  });

  it('computes sha256 over the final (possibly truncated) diff text', () => {
    const text = 'hello world\n+added line\n';
    redactCtl.mode = 'fixed';
    redactCtl.fixedReturn = { redacted: text, count: 1 };
    const r = captureMakerDiff(text, ON) as Record<string, unknown>;
    expect(r.diff_sha256).toBe(createHash('sha256').update(String(r.diff)).digest('hex'));
    expect(r.diff_redacted).toBe(1);
  });
});
