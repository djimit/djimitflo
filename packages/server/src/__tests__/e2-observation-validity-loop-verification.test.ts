/**
 * E2 — observation validity at the loop-verification boundary.
 * durable failure → fail, durable pass → pass, missing/unavailable historical evidence → unknown (blocks, but is reported
 * as insufficient evidence), genuinely inapplicable change-loop gates (gym runs, PR reviews) → skipped.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { ExperienceRetrievalService } from '../services/experience-retrieval-service';

let db: Database.Database;
let loops: LoopService;
let root: string;
let worktree: string;

const FINDINGS = JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fixture', evidence: 'Synthetic', suggested_fix: 'None' }]);
const gate = (gates: Array<{ name: string; status: string }>, name: string) => gates.find((g) => g.name === name)?.status;

function insertRun(id: string, loopName: string, metadata: Record<string, unknown>) {
  db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
    .run(id, loopName, 'closed', 'running', root, FINDINGS, JSON.stringify(metadata));
}

/** A governed change-loop run: one completed maker with a worktree + assignment, one accepted manual checker. */
function governedRun(id = 'run') {
  insertRun(id, 'doc-drift-and-small-fix-loop', { risk_class: 'low' });
  const assignment = path.join(worktree, 'LOOP_WORK.md'); fs.writeFileSync(assignment, 'Synthetic assignment');
  loops.insertWorkerLease({ id: `${id}-maker`, loopRunId: id, role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: worktree, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment, diff_lines: 1, diff_max_lines: 20, deterministic_checks: [{ name: 'fixture', status: 'pass' }] } });
  loops.updateWorkerLeaseStatus(`${id}-maker`, 'completed', {});
  loops.insertWorkerLease({ id: `${id}-checker`, loopRunId: id, role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    now: new Date().toISOString(), metadata: { maker_lease_id: `${id}-maker` } });
  loops.updateWorkerLeaseStatus(`${id}-checker`, 'completed', { verdict: 'accepted', manual_review_attestation: { reviewer: 'op', reason: 'fixture' } });
}

beforeEach(() => {
  vi.spyOn(ExperienceRetrievalService.prototype, 'indexRun').mockResolvedValue();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-e2-verify-'));
  worktree = path.join(root, 'maker'); fs.mkdirSync(worktree);
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('durable pass → pass: a fully evidenced governed run is ready for human merge', () => {
  governedRun();
  const { gates, run } = loops.verifyLoopRun('run');
  for (const name of ['worktree_isolation', 'assignment_file_present', 'checker_verdict', 'tests_lint_typecheck']) expect(gate(gates, name)).toBe('pass');
  expect(run.status).toBe('ready_for_human_merge');
});

it('durable failure → fail: a recorded failing check and a rejected verdict stay failures (governed gates not weakened)', () => {
  governedRun();
  loops.patchWorkerLeaseMetadata('run-maker', { deterministic_checks: [{ name: 'fixture', status: 'fail' }] });
  loops.updateWorkerLeaseStatus('run-checker', 'completed', { verdict: 'rejected' });
  const { gates, run } = loops.verifyLoopRun('run');
  expect(gate(gates, 'tests_lint_typecheck')).toBe('fail');
  expect(gate(gates, 'checker_verdict')).toBe('fail');
  expect(run.status).toBe('blocked');
  expect(run.metadata.block_reason).toBe('gate_failed');
});

it('durable failure → fail: a maker lease that never recorded a worktree fails isolation', () => {
  governedRun();
  db.prepare('UPDATE worker_leases SET worktree_path = NULL WHERE id = ?').run('run-maker');
  expect(gate(loops.verifyLoopRun('run').gates, 'worktree_isolation')).toBe('fail');
});

it('durable failure → fail: a still-running maker whose worktree is absent now fails isolation (current, not historical, fact)', () => {
  governedRun();
  loops.updateWorkerLeaseStatus('run-maker', 'running', {});
  fs.rmSync(worktree, { recursive: true, force: true });
  expect(gate(loops.verifyLoopRun('run').gates, 'worktree_isolation')).toBe('fail');
});

it('missing historical evidence → unknown: a completed maker whose worktree was removed is insufficient evidence, not a failure', () => {
  governedRun();
  fs.rmSync(worktree, { recursive: true, force: true });
  const { gates, run } = loops.verifyLoopRun('run');
  expect(gate(gates, 'worktree_isolation')).toBe('unknown');
  expect(gate(gates, 'assignment_file_present')).toBe('unknown');
  expect(gates.some((g) => g.status === 'fail')).toBe(false);
  // still blocks: not certified, not completable, but reported as insufficient evidence
  expect(run.status).toBe('blocked');
  expect(run.metadata.block_reason).toBe('insufficient_evidence');
  expect(run.metadata.failed_gates).toBeUndefined();
  expect(run.metadata.unknown_gates).toEqual(expect.arrayContaining([expect.stringMatching(/^worktree_isolation/)]));
  expect(loops.certifyLoopRun('run').certified).toBe(false);
  expect(() => loops.completeLoopRun('run', { human_approval_ref: 'fixture' })).toThrow('LOOP_COMPLETION_INSUFFICIENT_EVIDENCE:worktree_isolation');
  expect(() => loops.assertNoFailedGates(loops.getLoopRun('run'))).toThrow('LOOP_INSUFFICIENT_EVIDENCE_BLOCKS_CONTINUE');
});

it('missing historical evidence → unknown: an accepted runtime checker whose stdout file is gone is unknown; a never-recorded stdout fails', () => {
  governedRun();
  const stdout = path.join(root, 'checker.stdout'); fs.writeFileSync(stdout, 'accepted');
  db.prepare("UPDATE worker_leases SET runtime = 'codex' WHERE id = ?").run('run-checker');
  loops.patchWorkerLeaseMetadata('run-checker', { exit_status: 0, timed_out: false, runtime_verdict: 'accepted', read_only_contract_passed: true,
    runtime_adapter: 'codex', runtime_contract: { available: true, status: 'ok' }, stdout_path: stdout });
  expect(gate(loops.verifyLoopRun('run').gates, 'checker_verdict')).toBe('pass');
  fs.rmSync(stdout);
  expect(gate(loops.verifyLoopRun('run').gates, 'checker_verdict')).toBe('unknown');
  loops.patchWorkerLeaseMetadata('run-checker', { stdout_path: null, runtime_verdict: 'rejected' });
  expect(gate(loops.verifyLoopRun('run').gates, 'checker_verdict')).toBe('fail');
});

it('non-applicable → skipped: a settled gym run with its worktree removed and no reviewer fails no change-loop gate', () => {
  insertRun('gym', 'doc-drift-and-small-fix-loop', { gym: { commit: 'abc', species: 'codex' } });
  loops.insertWorkerLease({ id: 'gym-maker', loopRunId: 'gym', role: 'maker', runtime: 'codex', findingId: 'finding', worktreePath: path.join(root, 'gone'), branchName: null,
    now: new Date().toISOString(), metadata: {} });
  loops.updateWorkerLeaseStatus('gym-maker', 'failed', {});
  loops.insertWorkerLease({ id: 'gym-checker', loopRunId: 'gym', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    now: new Date().toISOString(), metadata: { maker_lease_id: 'gym-maker' } });
  loops.updateWorkerLeaseStatus('gym-checker', 'cancelled', {});
  db.prepare("UPDATE loop_runs SET status = 'completed', metadata = json_set(metadata, '$.gym_result', json('{\"status\":\"failure\"}')) WHERE id = 'gym'").run();
  const { gates, run } = loops.verifyLoopRun('gym');
  expect(gates.filter((g) => g.status === 'fail' || g.status === 'unknown')).toEqual([]);
  for (const name of ['maker_completion', 'maker_checker_separation', 'worktree_isolation', 'assignment_file_present', 'checker_verdict', 'diff_threshold_all_makers', 'tests_lint_typecheck']) {
    expect(gate(gates, name)).toBe('skipped');
  }
  expect(gate(gates, 'run_not_cancelled')).toBe('pass');
  expect(run.status).toBe('completed');
  expect(run.metadata.failed_gates).toBeUndefined();
});

it('non-applicable → skipped: a remote evolution-gym run is not judged by change-loop gates either', () => {
  insertRun('rgym', 'evolution-gym', {});
  const { gates } = loops.verifyLoopRun('rgym');
  expect(gate(gates, 'maker_completion')).toBe('skipped');
  expect(gates.some((g) => g.status === 'fail')).toBe(false);
});

it('non-applicable → skipped: a PR review (synthetic maker, no worktree) does not fail on inapplicable artifacts and is left for its owner to settle', () => {
  insertRun('pr', 'repo-maintenance-loop', { risk_class: 'high' });
  loops.insertWorkerLease({ id: 'pr-maker', loopRunId: 'pr', role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: 'feature',
    now: new Date().toISOString(), metadata: { github_pr: { owner: 'o', repo: 'r', number: 1, head_sha: 'abc' }, synthetic: true } });
  loops.updateWorkerLeaseStatus('pr-maker', 'completed', {});
  loops.insertWorkerLease({ id: 'pr-checker', loopRunId: 'pr', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    now: new Date().toISOString(), metadata: { maker_lease_id: 'pr-maker' } });
  loops.updateWorkerLeaseStatus('pr-checker', 'completed', { verdict: 'accepted', manual_review_attestation: { reviewer: 'roborev-webhook', reason: 'fixture' } });
  const { gates, run } = loops.verifyLoopRun('pr');
  for (const name of ['worktree_isolation', 'assignment_file_present', 'diff_threshold_all_makers', 'tests_lint_typecheck', 'security_checker_verdict']) {
    expect(gate(gates, name)).toBe('skipped');
  }
  // the review itself is still observed
  expect(gate(gates, 'checker_verdict')).toBe('pass');
  expect(gates.some((g) => g.status === 'fail')).toBe(false);
  expect(run.status).toBe('running'); // never ready_for_human_merge: the PR review service settles it
  // a rejected review is still a recorded failure of the review
  loops.updateWorkerLeaseStatus('pr-checker', 'completed', { verdict: 'rejected' });
  expect(gate(loops.verifyLoopRun('pr').gates, 'checker_verdict')).toBe('fail');
});

it('daemon outcome: an unknown-only verification is operational (infra_failed), never regressed; a durable failure stays regressed', async () => {
  const { verificationFailureOutcome } = await import('../services/loop-daemon');
  const { attributeOutcome } = await import('../services/outcome-attribution');
  governedRun();
  loops.patchWorkerLeaseMetadata('run-maker', { exit_status: 0, completed_at: new Date().toISOString(), changed_files: ['a.ts'] });
  fs.rmSync(worktree, { recursive: true, force: true });
  const { gates } = loops.verifyLoopRun('run');
  expect(verificationFailureOutcome(db, 'run-maker', gates)).toBe('infra_failed');
  // the daemon hands unknown gates to attribution too: never 'verified', lands on an operational class
  const unknownNames = gates.filter((g) => g.status === 'unknown').map((g) => g.name);
  const maker = { id: 'run-maker', role: 'maker', status: 'completed', metadata: { exit_status: 0, completed_at: 'x', changed_files: ['a.ts'] } };
  expect(attributeOutcome({ failed_gates: unknownNames, maker, reviewers: [] }).outcome).toBe('environment_failure');
  expect(verificationFailureOutcome(db, 'run-maker', [...gates, { name: 'tests_lint_typecheck', status: 'fail', evidence: '' }])).toBe('regressed');
});

it('governed runs are not exempted by a synthetic flag without a PR: existing governed failures stay failures', () => {
  governedRun();
  db.prepare('UPDATE worker_leases SET worktree_path = NULL WHERE id = ?').run('run-maker');
  loops.patchWorkerLeaseMetadata('run-maker', { synthetic: true });
  const { gates, run } = loops.verifyLoopRun('run');
  expect(gate(gates, 'worktree_isolation')).toBe('fail');
  expect(run.status).toBe('blocked');
  expect(run.metadata.block_reason).toBe('gate_failed');
});
