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
import { MAKER_DIFF_MAX_BYTES } from '../services/maker-diff-capture';

const { failRedact } = vi.hoisted(() => ({ failRedact: { on: false } }));
vi.mock('../services/secret-patterns', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/secret-patterns')>();
  return { ...real, redactSecrets: (text: string) => {
    if (failRedact.on) throw new Error('redact boom');
    return real.redactSecrets(text);
  } };
});

/** MAKER_DIFF_CAPTURE: a completed maker lease stores the redacted, capped worktree diff as metadata.diff; never changes the outcome. */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  failRedact.on = false;
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
    failRedact.on = true;
    const broken = await runMaker(smallChange);
    expect(outcome(broken)).toEqual(outcome(ok));
    expect(broken.lease.metadata.diff).toBeUndefined();
    expect(broken.lease.metadata.diff_sha256).toBeUndefined();
    expect(broken.lease.metadata.diff_capture_error).toBe('redact boom');
  });
});
