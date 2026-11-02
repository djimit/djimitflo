import { afterEach, describe, expect, it, vi } from 'vitest';
// admission is judged at a fixed instant, not the wall clock (helpers/admission-now.ts; ledger expiries 2026-11-27 / 2026-12-31)
vi.mock('../execution/runtime-admission', () => import('./helpers/admission-now').then((m) => m.admissionAtFixedNow()));
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { AtomicExecutor } from '../execution/executors/atomic-executor';
import type { ExecutionResult } from '../execution/types';
import { LoopService } from '../services/loop-service';
import { QueueHygieneService } from '../services/queue-hygiene-service';
import { WorkerLeaseRepo } from '../services/loop-worker-lease-repo';
import { attributionSummary, attributeOutcome } from '../services/outcome-attribution';
import { buildLeaseFailure, classifyStderr, STDERR_CLASSES, type StderrClass } from '../services/lease-failure';

/**
 * Structured failure capture (L3 report v2 §5 bottleneck 4: runtime_signal null on all 216 failed makers, 50/56 maker cancels
 * without a reason, 24 'unspecified' failures). Each `describe` below is one class of path that recorded nothing on main.
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const tmp = (prefix: string) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(r); return r; };
const memDb = () => { const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db); return db; };

function fixture(runtime = 'opencode') {
  const root = tmp('djimitflo-lf-');
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(1)"' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = memDb();
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('lf-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(
    repo, JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fix the readme', evidence: 'x', suggested_fix: 'y' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'lf-run', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  return { root, repo, db, loops };
}

/** The engine as executeViaEngine sees it: a started task whose completion is `completed`. */
const engineReturns = (completed: ExecutionResult | null, extra: Record<string, unknown> = {}) =>
  vi.spyOn(ExecutionEngine.prototype, 'executeTask').mockResolvedValue((completed ? { status: 'started', completion: Promise.resolve(completed) } : extra) as never);

describe('classifyStderr: deterministic, one class per cause', () => {
  const cases: Array<[StderrClass, string]> = [
    ['missing_module', "Error: Cannot find module 'vitest/config'\n    at Module._resolveFilename"],
    ['enoent', 'Error: spawn opencode ENOENT'],
    ['eacces', 'Error: EACCES: permission denied, mkdir \'/root/.cache\''],
    ['oom', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['network', 'Error: getaddrinfo EAI_AGAIN registry.npmjs.org'],
    ['rate_limit', 'Error: 429 Too Many Requests: weekly usage limit reached'],
    ['auth', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    ['npm_ci', 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync'],
    ['git', 'fatal: not a git repository (or any of the parent directories): .git'],
    ['tool_loop', 'Agent stopped: doom_loop detected (same tool call repeated 3 times)'],
    ['unknown', 'Tests failed: 3 of 120 assertions'],
  ];
  it.each(cases)('%s', (cls, text) => { expect(classifyStderr(text)).toBe(cls); });

  it('covers every class, empty text is unknown, and a cause wins over the symptom it produces', () => {
    expect(new Set(cases.map(([c]) => c))).toEqual(new Set(STDERR_CLASSES));
    expect(classifyStderr('')).toBe('unknown'); expect(classifyStderr(null)).toBe('unknown');
    expect(classifyStderr('npm error code ECONNRESET\nnpm error network aborted')).toBe('network'); // network before npm_ci
    expect(classifyStderr('npm error enoent Could not read package.json')).toBe('npm_ci'); // npm's enoent is npm's
    expect(classifyStderr('Error: spawnSync npm ETIMEDOUT')).toBe('unknown'); // a timeout, recorded as timed_out, not network
    expect(classifyStderr(`${'x'.repeat(10_000)}\nError: Cannot find module 'a'`)).toBe('missing_module'); // the tail decides
    expect(classifyStderr(`Error: Cannot find module 'a'\n${'x'.repeat(10_000)}`)).toBe('unknown');
  });
});

describe('WorkerLeaseRepo: every failed / cancelled lease carries a structured failure', () => {
  const insert = (db: Database.Database, id: string, role: string, meta: Record<string, unknown> = {}) =>
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, 'r', ?, 'opencode', 'running', ?)").run(id, role, JSON.stringify(meta));
  const meta = (db: Database.Database, id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);

  it('a cancel without a reason gets one and stage cancel; a failure gets its stage from the reason; completion drops it', () => {
    const db = memDb(); const repo = new WorkerLeaseRepo(db);
    insert(db, 'c1', 'maker'); repo.updateStatus('c1', 'cancelled', {});
    expect(meta(db, 'c1')).toMatchObject({ cancellation_reason: 'unspecified: caller supplied no reason',
      failure: { stage: 'cancel', cancellation_reason: 'unspecified: caller supplied no reason', exit_observed: false, exit_code: null, signal: null, stderr_source: 'none' } });
    insert(db, 'c2', 'maker'); repo.updateStatus('c2', 'cancelled', { stopped_by_runner: true });
    expect(meta(db, 'c2').cancellation_reason).toBe('operator_stop');
    insert(db, 'f1', 'checker'); repo.updateStatus('f1', 'failed', { failure_reason: 'checker_runtime_failed:exit=1,timed_out=true: Error: connect ECONNREFUSED 127.0.0.1:11434' });
    expect(meta(db, 'f1').failure).toMatchObject({ stage: 'checker', timed_out: true, stderr_class: 'network', stderr_source: 'reason', cancellation_reason: null });
    insert(db, 'f2', 'maker'); repo.updateStatus('f2', 'failed', { failure_reason: 'deterministic_checks_failed:install(exit=1),test(exit=1)' });
    expect(meta(db, 'f2').failure.stage).toBe('deps');
    insert(db, 'f3', 'maker'); repo.updateStatus('f3', 'failed', { failure_reason: 'maker_gate_failed:maker_runtime_exit_zero,token_budget' });
    expect(meta(db, 'f3').failure).toMatchObject({ stage: 'maker', token_budget_hit: true });
    repo.updateStatus('f3', 'completed', {});
    expect(meta(db, 'f3').failure).toBeUndefined();
  });

  it('a runtime that ends after its lease was cancelled adds its exit; the stage and reason stay the cancel\'s', () => {
    const db = memDb(); const repo = new WorkerLeaseRepo(db);
    insert(db, 'm', 'maker'); repo.updateStatus('m', 'cancelled', { stopped_by_runner: true, cancellation_reason: 'operator_stop' });
    repo.patchMetadata('m', { failure: { stage: 'maker', exit_observed: true, exit_code: null, signal: 'SIGTERM', stderr_class: 'unknown', stderr_source: 'stderr' } });
    expect(meta(db, 'm').failure).toMatchObject({ stage: 'cancel', cancellation_reason: 'operator_stop', signal: 'SIGTERM', exit_observed: true });
  });

  it('never changes the outcome class: attribution reads the same with or without the failure object', () => {
    const maker = { role: 'maker', status: 'failed', metadata: { failure_reason: 'maker_gate_failed:maker_runtime_exit_zero', timed_out: true, exit_status: 1 } };
    const withFailure = { ...maker, metadata: { ...maker.metadata, failure: buildLeaseFailure('maker', 'failed', maker.metadata) } };
    expect(attributeOutcome({ failed_gates: ['maker_runtime_exit_zero'], maker: withFailure, reviewers: [] }))
      .toEqual(attributeOutcome({ failed_gates: ['maker_runtime_exit_zero'], maker, reviewers: [] }));
  });
});

const SIGTERM_WORKER = `#!/usr/bin/env node
if (process.argv.includes('--version') || process.argv.includes('config')) { console.log('fault-injection 1.0'); process.exit(0); }
console.error('fatal: not a git repository');
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
setInterval(() => {}, 1000);
`;
const worker = (body: string) => { const root = tmp('djimitflo-lf-sig-'); const bin = path.join(root, 'worker'); fs.writeFileSync(bin, body); fs.chmodSync(bin, 0o755); return { root, bin }; };

describe('engine path: the child\'s exit code and signal reach the result (runtime_signal was hard-coded null)', () => {
  it.each([['codex', CodexExecutor], ['opencode', OpenCodeExecutor], ['claude', ClaudeExecutor], ['atomic', AtomicExecutor]] as const)(
    '%s records the child\'s exit on its session before `closed` resolves', async (_kind, Executor) => {
      for (const [body, exit] of [[SIGTERM_WORKER, { code: null, signal: 'SIGTERM' }], ["#!/usr/bin/env node\nif (process.argv.includes('config')) process.exit(0);\nprocess.exit(3);\n", { code: 3, signal: null }]] as const) {
        const { root, bin } = worker(body);
        const session = await new Executor(bin).start({ id: 'sig', description: 'fixture', metadata: {} } as never, { workingDirectory: root, timeout: 10_000 });
        for await (const _event of session.events) { /* drain */ }
        await session.closed;
        expect(session.exit).toEqual(exit);
      }
    }, 15_000);

  it('ExecutionEngine: the completion carries exitCode and signal once the child closed', async () => {
    const { root, bin } = worker(SIGTERM_WORKER);
    const db = memDb();
    const engine = new ExecutionEngine(db);
    engine.registerExecutor(new CodexExecutor(bin));
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('sig-task', 'Observe fixture', 'echo hello', 'pending', 'medium', 'low', 'local', ?)")
      .run(JSON.stringify({ workingDirectory: root }));
    const execution = await engine.executeTask('sig-task', 'codex');
    const completed = await execution.completion!;
    expect(completed).toMatchObject({ status: 'failed', exitCode: null, signal: 'SIGTERM' });
  }, 15_000);

  // C-reliability 30-10 §1c: exit_observed was false on 169/169 failures. An approved maker's run is consumed by the approval
  // decision; the daemon then reads the task's stored executionResult (executeViaEngine), which never carried the exit.
  it('ExecutionEngine: the stored executionResult (read back by an approval-resumed maker) carries exitCode and signal', async () => {
    const { root, bin } = worker("#!/usr/bin/env node\nif (process.argv.includes('config')) process.exit(0);\nprocess.exit(3);\n");
    const db = memDb();
    const engine = new ExecutionEngine(db);
    engine.registerExecutor(new CodexExecutor(bin));
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('stored-task', 'Observe fixture', 'echo hello', 'pending', 'medium', 'low', 'local', ?)")
      .run(JSON.stringify({ workingDirectory: root }));
    const execution = await engine.executeTask('stored-task', 'codex');
    await execution.completion!;
    const stored = () => (JSON.parse((db.prepare('SELECT metadata FROM tasks WHERE id = ?').get('stored-task') as { metadata: string }).metadata) as { executionResult?: ExecutionResult }).executionResult;
    await vi.waitFor(() => expect(stored()).toBeDefined(), { timeout: 5_000 });
    expect(stored()).toMatchObject({ status: 'failed', exitCode: 3, signal: null });
  }, 15_000);
});

describe('an approval-resumed maker (stored engine result) records the child\'s exit', () => {
  it('exit_observed and exit_code come from the stored executionResult', async () => {
    const { loops, db } = fixture();
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('done-task', 't', 'd', 'failed', 'medium', 'low', 'local', ?)")
      .run(JSON.stringify({ executionResult: { status: 'failed', message: 'OpenCode execution failed with exit code 3', error: 'Process exited with code 3', exitCode: 3, signal: null } }));
    db.prepare("UPDATE worker_leases SET metadata = json_set(metadata, '$.execution_task_id', 'done-task') WHERE id = 'maker'").run();
    const engine = vi.spyOn(ExecutionEngine.prototype, 'executeTask');
    await loops.executeMaker('lf-run', { lease_id: 'maker' });
    expect(engine).not.toHaveBeenCalled();
    expect(loops.getWorkerLease('maker').metadata.failure).toMatchObject({ stage: 'maker', exit_observed: true, exit_code: 3, signal: null });
  });
});

describe('executeMaker on the engine path records the failure (record-only: gates and exit_status unchanged)', () => {
  it('a timed-out maker killed by SIGTERM: runtime_signal, failure with stage maker, exit_status still the gate\'s 1', async () => {
    const { loops } = fixture();
    engineReturns({ status: 'failed', message: 'OpenCode execution error: OpenCode execution timed out after 600000ms', error: 'Error: OpenCode execution timed out after 600000ms',
      stderr: "Error: Cannot find module 'vitest/config'", exitCode: null, signal: 'SIGTERM' });
    const { gates } = await loops.executeMaker('lf-run', { lease_id: 'maker' });
    const lease = loops.getWorkerLease('maker');
    expect(gates.find((g) => g.name === 'maker_runtime_exit_zero')?.status).toBe('fail');
    expect(lease.status).toBe('failed');
    expect(lease.metadata).toMatchObject({ exit_status: 1, timed_out: true, runtime_signal: 'SIGTERM', failure_reason: expect.stringMatching(/^maker_gate_failed:maker_runtime_exit_zero/) });
    expect(lease.metadata.failure).toEqual({ stage: 'maker', exit_code: null, signal: 'SIGTERM', exit_observed: true, timed_out: true, token_budget_hit: false,
      stderr_class: 'missing_module', stderr_source: 'stderr', cancellation_reason: null });
  });

  it('the opencode token brake sets token_budget_hit and the child\'s exit code', async () => {
    const { loops } = fixture();
    engineReturns({ status: 'failed', message: 'OpenCode execution error: OpenCode token budget exceeded: 900001 > 900000 tokens (OPENCODE_MAX_RUN_TOKENS)', stderr: '', exitCode: 143, signal: null });
    await loops.executeMaker('lf-run', { lease_id: 'maker' });
    expect(loops.getWorkerLease('maker').metadata.failure).toMatchObject({ stage: 'maker', exit_code: 143, signal: null, exit_observed: true, token_budget_hit: true, stderr_source: 'reason' });
  });

  it('a remote maker (no child here): exit_observed false, the cancel text classified', async () => {
    const { loops } = fixture('remote');
    engineReturns({ status: 'failed', message: 'Remote maker failed', stderr: 'remote patch did not apply: error: patch failed: src/a.ts:3' });
    await loops.executeMaker('lf-run', { lease_id: 'maker' });
    expect(loops.getWorkerLease('maker').metadata.failure).toMatchObject({ stage: 'maker', exit_observed: false, exit_code: null, signal: null, stderr_class: 'git' });
  });

  it('a denial without a stated reason names one (it read "unspecified: caller supplied no reason")', async () => {
    const { loops } = fixture();
    engineReturns(null, { status: 'denied' });
    await expect(loops.executeMaker('lf-run', { lease_id: 'maker' })).rejects.toThrow('LOOP_WORKER_EXECUTION_DENIED');
    const lease = loops.getWorkerLease('maker');
    expect(lease.status).toBe('failed');
    expect(lease.metadata.failure_reason).toBe('execution_denied_without_reason');
    expect(lease.metadata.failure).toMatchObject({ stage: 'prepare', exit_observed: false });
  });

  it('a missing worktree fails in stage prepare', async () => {
    const { loops, repo } = fixture();
    fs.rmSync(repo, { recursive: true, force: true });
    await expect(loops.executeMaker('lf-run', { lease_id: 'maker' })).rejects.toThrow('MAKER_WORKTREE_NOT_FOUND');
    expect(loops.getWorkerLease('maker').metadata.failure).toMatchObject({ stage: 'prepare', exit_observed: false });
  });
});

describe('deterministic checks: stage checks / deps with the failed check\'s exit and stderr class', () => {
  it('a test script failing with a missing module', () => {
    const { loops, db, repo } = fixture();
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.error(\'Error: Cannot find module vitest\'); process.exit(4)"' } }));
    db.prepare("UPDATE worker_leases SET status = 'completed', metadata = json_set(metadata, '$.changed_files', json('[\"a.ts\"]')) WHERE id = 'maker'").run();
    loops.runDeterministicChecks('lf-run', { lease_id: 'maker', scripts: ['test'] });
    const lease = loops.getWorkerLease('maker');
    expect(lease.status).toBe('failed');
    expect(lease.metadata.failure).toMatchObject({ stage: 'checks', exit_code: 4, exit_observed: true, timed_out: false, stderr_class: 'missing_module', stderr_source: 'stderr' });
  });
});

describe('cancel paths name their reason', () => {
  it('operator stop (stopLoopRun) records operator_stop', async () => {
    const { loops } = fixture();
    await loops.stopLoopRun('lf-run');
    const lease = loops.getWorkerLease('maker');
    expect(lease.status).toBe('cancelled');
    expect(lease.metadata).toMatchObject({ cancellation_reason: 'operator_stop', failure: { stage: 'cancel', cancellation_reason: 'operator_stop' } });
  });

  it('queue hygiene: prepared leases of a run whose goal ended record goal_ended', () => {
    const db = memDb();
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status) VALUES ('g', 'x', 'low', 'failed')").run();
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, updated_at) VALUES ('qr', 'l', 'closed', 'running', 'g', ?)").run(old);
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('ql', 'qr', 'maker', 'opencode', 'prepared', '{}')").run();
    new QueueHygieneService(db).sweepZombies();
    const row = db.prepare("SELECT status, metadata FROM worker_leases WHERE id = 'ql'").get() as { status: string; metadata: string };
    expect(row.status).toBe('cancelled');
    expect(JSON.parse(row.metadata)).toMatchObject({ cancellation_reason: 'goal_ended', failure: { stage: 'cancel', cancellation_reason: 'goal_ended', exit_observed: false } });
  });

  it('every raw `SET status = \'cancelled\'` on worker_leases in services/ also writes a cancellation reason', () => {
    const dir = path.join(__dirname, '..', 'services');
    const missing: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const m of src.matchAll(/UPDATE worker_leases\s+SET\s+status\s*=\s*'cancelled'([\s\S]*?)WHERE/g)) {
        if (!/CANCEL_LEASE_METADATA_SQL|\$\.cancellation_reason/.test(m[1])) missing.push(`${file}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('evidence: attributionSummary.failure_capture (stage × stderr class, cancels with a reason)', () => {
  it('counts captured leases per cell and keeps pre-capture leases apart', () => {
    const db = memDb(); const repo = new WorkerLeaseRepo(db);
    const ins = (id: string, role: string, status = 'running', m: Record<string, unknown> = {}) =>
      db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, 'r', ?, 'opencode', ?, ?)").run(id, role, status, JSON.stringify(m));
    ins('a', 'maker'); repo.updateStatus('a', 'failed', { failure_reason: 'maker_execution_error: spawn opencode ENOENT', execution_task_id: 't' });
    ins('b', 'maker'); repo.updateStatus('b', 'failed', { failure_reason: 'maker_execution_error: spawn opencode ENOENT', execution_task_id: 't' });
    ins('c', 'maker'); repo.updateStatus('c', 'cancelled', { cancellation_reason: 'operator_stop' });
    ins('d', 'checker'); repo.updateStatus('d', 'cancelled', {});
    ins('old', 'maker', 'failed', { failure_reason: 'x' }); // ended before the capture existed
    const fc = attributionSummary(db).failure_capture;
    expect(fc.leases).toBe(5);
    expect(fc.without_failure).toBe(1);
    expect(fc.by_stage_stderr).toEqual([{ stage: 'cancel', stderr_class: 'unknown', n: 2 }, { stage: 'maker', stderr_class: 'enoent', n: 2 }]);
    expect(fc.cancels).toEqual({ total: 2, with_reason: 1, maker: 1, maker_with_reason: 1 });
  });
});
