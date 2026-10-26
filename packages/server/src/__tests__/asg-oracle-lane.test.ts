import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { effectsBounded } from '../services/asg/oracle-lane';

/**
 * ASG-001 in the oracle-lane maker path (LoopWorkerExecutorService.runMaker). The prod shape (MAKER_FAILURES.md §3): a maker
 * whose last test run passed is killed by its wall-clock timeout or token brake. ASG_MODE=off changes nothing; shadow only
 * records; on rescues it only when its effects are bounded, in scope, and the declared test passes when the daemon runs it.
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const TEST = 'packages/server/src/__tests__/widget.test.ts';
const SRC = 'packages/server/src/services/widget.ts';

function fixture(runtime: string, opts: { oracle?: boolean; vitestExit?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-asg-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages/server/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, SRC), 'export function widget(n: number) { return n * 2; }\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture' }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  // the worktree's own vitest (what runDeclaredTest runs); it records its argv
  const bin = path.join(repo, 'packages/server/node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'vitest'), `#!/bin/sh\necho "$*" >> "${path.join(root, 'vitest-calls.log')}"\necho "vitest ran"\nexit ${opts.vitestExit ?? 0}\n`, { mode: 0o755 });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, evidence_refs_json, grounding_json) VALUES ('imp', 'test', 'Add unit tests for services/widget.ts', 'Add ${TEST}', 'r', 'gap_analysis', ?, ?)`)
    .run(JSON.stringify(opts.oracle === false ? ['reflection:x'] : ['test-gap:widget']), JSON.stringify({ target: SRC, artifactPath: TEST, acceptanceTest: 'npx vitest run src/__tests__/widget.test.ts' }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g1', 'Add unit tests for services/widget.ts', 'low', 'running', 'imp')").run();
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata,goal_id) VALUES ('run',?,'closed','running',?,?,?,'g1')`).run(
    'doc-drift-and-small-fix-loop', repo, JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: SRC, message: 'm', evidence: 'x', suggested_fix: 'y' }]), JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'run', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null, now: new Date().toISOString(), metadata: { assignment_file: assignment } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  const vitestCalls = () => { const f = path.join(root, 'vitest-calls.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []; };
  return { root, repo, db, loops, vitestCalls };
}

/** The runtime writes the given files and then stops the way the prod brake/timeout does. */
async function runMaker(loops: LoopService, repo: string, writes: Record<string, string>, engine: { exitCode: number; timedOut?: boolean; tokenBudgetHit?: boolean }) {
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: () => Promise<unknown> }, 'executeViaEngine').mockImplementation(async () => {
    for (const [p, c] of Object.entries(writes)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); }
    return { exitCode: engine.exitCode, signal: null, timedOut: engine.timedOut ?? false, tokenBudgetHit: engine.tokenBudgetHit, stdout: '', stderr: engine.timedOut ? 'timed out' : '' };
  });
  const result = await loops.executeMaker('run', { lease_id: 'maker' });
  return { result, lease: loops.getWorkerLease('maker')!, events: loops.listLoopEvents('run') };
}

const GOOD = { [TEST]: "import { widget } from '../services/widget';\nit('doubles', () => expect(widget(2)).toBe(4));\n" };
const TIMEOUT = { exitCode: 1, timedOut: true };
/** wall-clock values differ run to run; everything else must be identical */
const strip = (m: Record<string, unknown>) => {
  const { started_at, completed_at, failed_at, stdout_path, stderr_path, runtime_pid, token_accounting, ...rest } = m;
  void started_at; void completed_at; void failed_at; void stdout_path; void stderr_path; void runtime_pid;
  return { ...rest, token_accounting: { ...(token_accounting as Record<string, unknown>), duration_ms: '<ms>' } };
};

describe('ASG-001 oracle-lane maker hook', () => {
  it('ASG_MODE unset and off are byte-identical: same lease status, gates and metadata, no asg record or event', async () => {
    const outcomes = [];
    for (const mode of [undefined, 'off']) {
      if (mode) vi.stubEnv('ASG_MODE', mode);
      const f = fixture('codex');
      const { lease, result, events } = await runMaker(f.loops, f.repo, GOOD, TIMEOUT);
      expect(lease.metadata.asg).toBeUndefined();
      expect(events.some((e) => e.event_type.startsWith('asg'))).toBe(false);
      expect(f.vitestCalls()).toEqual([]);
      outcomes.push({ status: lease.status, gates: result.gates, meta: JSON.stringify(strip(lease.metadata)).replaceAll(f.root, '<root>') });
      vi.unstubAllEnvs();
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0].status).toBe('failed');
  });

  it('shadow records the decision-time route and the observed effects, runs no command and changes no outcome', async () => {
    vi.stubEnv('ASG_MODE', 'shadow');
    const f = fixture('codex');
    const { lease, result, events } = await runMaker(f.loops, f.repo, GOOD, TIMEOUT);
    expect(lease.status).toBe('failed');
    expect(result.gates.map((g) => g.name)).not.toContain('asg_end_state_verified');
    expect(f.vitestCalls()).toEqual([]);
    const asg = lease.metadata.asg as Record<string, any>;
    expect(asg).toMatchObject({ mode: 'shadow', lane: 'test-gap', route_executed: 'MICRO', spec: { declared_writes: [TEST], capability: { write: [TEST] } } });
    expect(asg.decision).toMatchObject({ route: 'MICRO', reason_codes: ['RUNTIME_NO_MACRO_ADAPTER'], policy: { id: 'asg-policy', version: 1 } });
    expect(asg.decision.features).toMatchObject({ lane: 'test-gap', source_exists: true, test_exists: false, runtime: 'codex', runtime_has_macro_adapter: false });
    expect(asg.base.head).toMatch(/^[0-9a-f]{40}$/);
    expect(asg.base.targets).toEqual({ [SRC]: expect.stringMatching(/^[0-9a-f]{64}$/), [TEST]: null });
    expect(asg.outcome).toMatchObject({ mode: 'shadow', execution_status: 'failed', verification_status: 'not_run', rescued: false, would_verify: true,
      effects: { expected: [TEST], observed: [TEST], out_of_scope: [], bounded: true } });
    expect(events.filter((e) => e.event_type === 'asg_route')).toHaveLength(1);
  });

  it('on: a bounded runtime stopped by its timeout, with its only effect the declared test and that test passing, is succeeded_with_incident', async () => {
    vi.stubEnv('ASG_MODE', 'on');
    const f = fixture('codex');
    const { lease, result } = await runMaker(f.loops, f.repo, GOOD, TIMEOUT);
    expect(lease.status).toBe('completed');
    expect(result.gates.find((g) => g.name === 'maker_runtime_exit_zero')!.status).toBe('fail'); // kept as evidence
    expect(result.gates.find((g) => g.name === 'asg_end_state_verified')!.status).toBe('pass');
    expect(f.vitestCalls()).toEqual(['run src/__tests__/widget.test.ts']);
    const out = (lease.metadata.asg as Record<string, any>).outcome;
    expect(out).toMatchObject({ execution_status: 'failed', verification_status: 'passed', result: 'succeeded_with_incident', rescued: true,
      incident: { class: 'timeout_uncertain', timed_out: true } });
    expect((lease.metadata.asg as Record<string, any>).incident_failure).toMatchObject({ timed_out: true });
    expect(lease.metadata.failure_reason).toBeUndefined();
  });

  it('on: never rescues an unbounded runtime, an out-of-scope effect, a failing test, a non-brake failure or a non-oracle goal', async () => {
    vi.stubEnv('ASG_MODE', 'on');
    const cases: Array<[string, () => ReturnType<typeof fixture>, Record<string, string>, { exitCode: number; timedOut?: boolean }, string]> = [
      ['opencode (no sandbox)', () => fixture('opencode'), GOOD, TIMEOUT, 'unknown_external_effect'],
      ['package.json edited too', () => fixture('codex'), { ...GOOD, 'package.json': '{"name":"fixture","allowScripts":{}}' }, TIMEOUT, 'permission_invalid'],
      ['declared test fails', () => fixture('codex', { vitestExit: 1 }), GOOD, TIMEOUT, 'validation_failure'],
      ['exit 1 without a brake', () => fixture('codex'), GOOD, { exitCode: 1 }, 'executor_exception'],
      ['no change at all', () => fixture('codex'), {}, TIMEOUT, 'validation_failure'],
    ];
    for (const [name, mk, writes, engine, cls] of cases) {
      const f = mk();
      const { lease } = await runMaker(f.loops, f.repo, writes, engine);
      expect(lease.status, name).toBe('failed');
      expect((lease.metadata.asg as Record<string, any>).outcome, name).toMatchObject({ rescued: false, failure: { class: cls, recoverable: false } });
      vi.restoreAllMocks();
    }
    const f = fixture('codex', { oracle: false });
    const { lease } = await runMaker(f.loops, f.repo, GOOD, TIMEOUT);
    expect(lease.metadata.asg).toBeUndefined();
    expect(lease.status).toBe('failed');
  });

  it('on refuses to act while an oracle-population experiment is on: it records as shadow and names the experiment', async () => {
    vi.stubEnv('ASG_MODE', 'on'); vi.stubEnv('STE_001_MODE', 'on');
    const f = fixture('codex');
    const { lease } = await runMaker(f.loops, f.repo, GOOD, TIMEOUT);
    expect(lease.status).toBe('failed');
    expect(lease.metadata.asg).toMatchObject({ mode: 'shadow', requested: 'on', blocked_by: ['STE_001_MODE'] });
    expect(f.vitestCalls()).toEqual([]);
  });

  it('effects are bounded only for mock and for codex inside its workspace-write sandbox', () => {
    expect(effectsBounded('codex', false)).toBe(true);
    expect(effectsBounded('codex', true)).toBe(false);
    for (const r of ['opencode', 'claude', 'hermes', 'atomic', 'remote']) expect(effectsBounded(r, false), r).toBe(false);
  });
});
