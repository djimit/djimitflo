import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { ExecutionEngine } from '../execution/execution-engine';
import { CodexExecutor } from '../execution/executors/codex-executor';

let root: string;
let db: Database.Database;
let loops: LoopService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-security-review-'));
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Small documentation fixture\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata)
    VALUES ('review-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Improve wording', evidence: 'Small text', suggested_fix: 'Clarify wording' }]),
    JSON.stringify({ risk_class: 'high', provenance: { fixture: 'retained' } }));
  const assignment = path.join(root, 'assignment.md');
  fs.writeFileSync(assignment, 'Fixture assignment');
  for (const role of ['maker', 'checker', 'security_checker'] as const) {
    loops.insertWorkerLease({ id: role, loopRunId: 'review-run', role, runtime: 'manual', findingId: 'finding',
      worktreePath: role === 'maker' ? repo : null, branchName: null, now: new Date().toISOString(),
      metadata: role === 'maker' ? { assignment_file: assignment, diff_lines: 0, diff_max_lines: 20,
        deterministic_checks: [{ name: 'fixture', status: 'pass' }] } : { maker_lease_id: 'maker' } });
  }
  loops.updateWorkerLeaseStatus('maker', 'completed', {});
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

const gate = (name: string) => loops.verifyLoopRun('review-run').gates.find(candidate => candidate.name === name);

it.each(['high', 'critical'])('keeps explicit %s run risk without findings in both classification and verification', (risk) => {
  db.prepare("UPDATE loop_runs SET findings_json='[]',metadata=? WHERE id='review-run'").run(JSON.stringify({ risk_class: risk }));
  const run = loops.getLoopRun('review-run');
  expect(loops.isHighRiskRun(run)).toBe(true);
  loops.submitCheckerVerdict('review-run', { lease_id: 'checker', verdict: 'accepted' });
  expect(gate('security_checker_verdict')?.status).toBe('fail');
  loops.submitSecurityVerdict('review-run', { lease_id: 'security_checker', verdict: 'accepted' });
  expect(gate('security_checker_verdict')?.status).toBe('pass');
});

it('preserves low-risk empty runs, finding-derived risk and linked goal classification', () => {
  db.prepare("UPDATE loop_runs SET findings_json='[]',metadata='{\"risk_class\":\"low\"}' WHERE id='review-run'").run();
  const run = loops.getLoopRun('review-run');
  expect(loops.isHighRiskRun(run)).toBe(false);
  expect(loops.isHighRiskRun(run, { id: 'auth-finding', type: 'todo_marker', severity: 'low', file: 'auth.ts', message: 'Update authentication', evidence: 'Fixture', suggested_fix: 'Review' })).toBe(true);
  db.prepare("INSERT INTO goals(id,objective,status,risk_class) VALUES ('risk-goal','Fixture','running','critical')").run();
  db.prepare("UPDATE loop_runs SET goal_id='risk-goal' WHERE id='review-run'").run();
  expect(loops.isHighRiskRun(loops.getLoopRun('review-run'))).toBe(true);
});

it('dispatches an explicitly selected security reviewer in its own worktree without granting human merge authority', async () => {
  const ordinary = await loops.executeChecker('review-run', { lease_id: 'checker', runtime: 'mock' });
  expect(gate('security_checker_verdict')?.status).toBe('fail');
  const security = await loops.executeChecker('review-run', { lease_id: 'security_checker', runtime: 'mock' });
  expect(security.lease.role).toBe('security_checker');
  expect(security.lease.worktree_path).not.toBe(ordinary.lease.worktree_path);
  expect(security.lease.worktree_path).not.toBe(loops.getWorkerLease('maker').worktree_path);
  expect(security.gates.map(candidate => candidate.name)).toEqual([
    'security_checker_runtime_exit_zero', 'security_checker_verdict', 'security_checker_read_only_contract',
  ]);
  expect(security.lease.metadata.read_only_contract_passed).toBe(true);
  expect(gate('security_checker_verdict')?.status).toBe('pass');
  expect(() => loops.completeLoopRun('review-run')).toThrow('LOOP_HUMAN_APPROVAL_REQUIRED');
  const prompt = loops.buildCheckerPrompt(loops.getLoopRun('review-run'), loops.getWorkerLease('maker'), security.lease);
  expect(prompt).toContain('Security Checker Assignment');
  expect(prompt).toContain('not human approval');
});

it('never silently dispatches a manual reviewer as mock', async () => {
  await expect(loops.executeChecker('review-run', { lease_id: 'checker' })).rejects.toThrow('explicit runtime');
  expect(loops.getWorkerLease('checker')).toMatchObject({ status: 'prepared', runtime: 'manual' });
});

it('preserves manual verdict submission and risk provenance across repeated verification', () => {
  loops.submitCheckerVerdict('review-run', { lease_id: 'checker', verdict: 'accepted' });
  expect(gate('security_checker_verdict')?.status).toBe('fail');
  expect(gate('security_checker_verdict')?.status).toBe('fail');
  expect(loops.getLoopRun('review-run').metadata).toMatchObject({ risk_class: 'high', provenance: { fixture: 'retained' } });
  loops.submitSecurityVerdict('review-run', { lease_id: 'security_checker', verdict: 'accepted' });
  expect(gate('security_checker_verdict')?.status).toBe('pass');
  expect(loops.getLoopRun('review-run').metadata).toMatchObject({ risk_class: 'high', provenance: { fixture: 'retained' } });
  expect(loops.getLoopRun('review-run').metadata).not.toHaveProperty('block_reason');
});

it.each(['checker', 'security_checker'] as const)('rejects stale accepted %s metadata unless completed with valid runtime proof', (role) => {
  loops.updateWorkerLeaseRuntime(role, 'mock');
  for (const status of ['failed', 'cancelled', 'prepared', 'running', 'completed'] as const) {
    loops.updateWorkerLeaseStatus(role, status, { verdict: 'accepted' });
    expect(gate(`${role}_verdict`)?.status).toBe('fail');
  }
});

it.each(['checker', 'security_checker'] as const)('does not forget an accepted %s runtime read-only violation on reverify', async (role) => {
  vi.spyOn(loops, 'buildMockCheckerCommand').mockReturnValue({ command: process.execPath, args: ['-e',
    'require("fs").writeFileSync("MUTATION.md","not allowed"); console.log(JSON.stringify({verdict:"accepted"}));'] });
  const result = await loops.executeChecker('review-run', { lease_id: role, runtime: 'mock' });
  expect(result.gates.find(candidate => candidate.name === `${role}_read_only_contract`)?.status).toBe('fail');
  expect(gate(`${role}_verdict`)?.status).toBe('fail');
  expect(gate(`${role}_verdict`)?.status).toBe('fail');
});

it('creates a fresh security review lease linked to a high-risk retry maker', () => {
  loops.updateWorkerLeaseStatus('maker', 'failed', {});
  const retry = loops.retryLoopRun('review-run', { maker_lease_id: 'maker', runtime: 'mock' });
  const security = retry.leases.filter(lease => lease.role === 'security_checker' && lease.metadata.maker_lease_id === retry.retry_maker.id);
  expect(security).toHaveLength(1);
  expect(security[0]).toMatchObject({ runtime: 'manual', status: 'prepared', metadata: { requires_security_review: true, retry_attempt: 1 } });
  expect(security[0].id).not.toBe('security_checker');
});

it.each(['checker', 'security_checker'] as const)('fails closed when a previously valid %s proof becomes invalid', async (role) => {
  const result = await loops.executeChecker('review-run', { lease_id: role, runtime: 'mock' });
  const valid = result.lease.metadata;
  expect(gate(`${role}_verdict`)?.status).toBe('pass');
  for (const status of ['failed', 'cancelled', 'prepared', 'running'] as const) {
    loops.updateWorkerLeaseStatus(role, status, valid);
    expect(gate(`${role}_verdict`)?.status).toBe('fail');
  }
  for (const invalid of [
    { exit_status: 1 }, { timed_out: true }, { runtime_timed_out: true }, { runtime_was_cancelled: true },
    { runtime_verdict: 'rejected' }, { verdict: 'rejected' }, { read_only_contract_passed: false },
    { runtime_contract: { available: false, status: 'unavailable' } },
    { runtime_contract: { available: true, status: 'drifted' } }, { runtime_adapter: 'codex' },
    { stdout_path: path.join(root, 'missing-evidence') },
  ]) {
    db.prepare('UPDATE worker_leases SET status = ?, metadata = ? WHERE id = ?')
      .run('completed', JSON.stringify({ ...valid, ...invalid }), role);
    expect(gate(`${role}_verdict`)?.status).toBe('fail');
  }
});

it('does not relabel a rejected runtime verdict as runtime acceptance through manual submission', async () => {
  vi.spyOn(loops, 'buildMockCheckerCommand').mockReturnValue({ command: process.execPath, args: ['-e',
    'console.log(JSON.stringify({verdict:"rejected"}));'] });
  await loops.executeChecker('review-run', { lease_id: 'security_checker', runtime: 'mock' });
  loops.submitSecurityVerdict('review-run', { lease_id: 'security_checker', verdict: 'accepted' });
  expect(gate('security_checker_verdict')?.status).toBe('fail');
});

it('rejects sharing another reviewer worktree and rejects redispatch of a completed lease', async () => {
  const result = await loops.executeChecker('review-run', { lease_id: 'checker', runtime: 'mock' });
  await expect(loops.executeChecker('review-run', { lease_id: 'checker', runtime: 'mock' })).rejects.toThrow('must be prepared');
  loops.updateWorkerLeaseWorktree('security_checker', result.lease.worktree_path!, result.lease.branch_name!);
  await expect(loops.executeChecker('review-run', { lease_id: 'security_checker', runtime: 'mock' })).rejects.toThrow('must be independent');
});

it('does not create an unnecessary security checker on a low-risk retry', () => {
  db.prepare('UPDATE loop_runs SET metadata = ? WHERE id = ?').run(JSON.stringify({ risk_class: 'low' }), 'review-run');
  loops.updateWorkerLeaseStatus('maker', 'failed', {});
  const retry = loops.retryLoopRun('review-run', { maker_lease_id: 'maker', runtime: 'mock' });
  expect(retry.leases.filter(lease => lease.role === 'security_checker' && lease.metadata.maker_lease_id === retry.retry_maker.id)).toEqual([]);
});

it.each(['checker', 'security_checker'] as const)('resumes %s after actual engine approval without duplicate execution or worktree', async (role) => {
  const binary = path.join(root, 'fixture-codex');
  const executions = path.join(root, 'executions.log');
  fs.writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fixture codex 1.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: codex exec --json --cd <DIR>'); process.exit(0); }
require('fs').appendFileSync(${JSON.stringify(executions)}, 'executed\\n');
setTimeout(() => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'accepted',notes:'Local CLI fixture only'})}})), 200);
`);
  fs.chmodSync(binary, 0o755);
  vi.stubEnv('CODEX_BIN_PATH', binary);
  const engine = new ExecutionEngine(db);
  engine.registerExecutor(new CodexExecutor(binary));
  loops = new LoopService(db, path.join(root, 'evidence'), engine);
  await expect(loops.executeChecker('review-run', { lease_id: role, runtime: 'codex' })).rejects.toThrow('LOOP_WORKER_APPROVAL_REQUIRED');
  const waiting = loops.getWorkerLease(role);
  expect(waiting.status).toBe('prepared');
  expect(fs.existsSync(executions)).toBe(false);
  await expect(loops.executeChecker('review-run', { lease_id: role, runtime: 'mock' })).rejects.toThrow('originally dispatched runtime');
  await expect(loops.executeChecker('review-run', { lease_id: role, runtime: 'codex' })).rejects.toThrow('LOOP_WORKER_APPROVAL_REQUIRED');
  expect(loops.getWorkerLease(role).status).toBe('prepared');
  const resumed = await engine.handleApprovalDecision(String(waiting.metadata.approval_id), true, 'independent-fixture-approver');
  expect(resumed?.status).toBe('started');
  await expect(loops.executeChecker('review-run', { lease_id: role, runtime: 'codex' })).rejects.toThrow('LOOP_WORKER_EXECUTION_IN_PROGRESS');
  expect(loops.getWorkerLease(role).status).toBe('prepared');
  await resumed!.completion;
  const completed = await loops.executeChecker('review-run', { lease_id: role, runtime: 'codex' });
  expect(completed.lease.status).toBe('completed');
  expect(completed.lease.worktree_path).toBe(waiting.worktree_path);
  expect(completed.lease.metadata.execution_task_id).toBe(waiting.metadata.execution_task_id);
  expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  expect(fs.readFileSync(executions, 'utf8')).toBe('executed\n');
  expect(gate(`${role}_verdict`)?.status).toBe('pass');
});
