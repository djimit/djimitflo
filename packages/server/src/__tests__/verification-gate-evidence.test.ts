/**
 * U4a / U4b (re-20261029 E-assumptions A3, C6): a verification gate reports what it observed.
 * - no_automatic_merge was a hard-coded pass; while LOOP_AUTO_MERGE_TEST_ONLY=act the loop may merge, so the gate is
 *   'skipped' (not applicable, "auto-merge may act") — certification and completion treat it as before (it is not a failure).
 * - diff_threshold_all_makers passed a completed maker without diff_lines (`diff_lines ?? 0`): missing evidence is 'unknown'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { ExperienceRetrievalService } from '../services/experience-retrieval-service';
import { allGatesPassed, gatePasses, gatePassesStrict, runCertified } from '../services/loop-types';

let db: Database.Database;
let loops: LoopService;
let root: string;
let worktree: string;

const FINDINGS = JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fixture', evidence: 'Synthetic', suggested_fix: 'None' }]);
const gateOf = (gates: Array<{ name: string; status: string; evidence: string }>, name: string) => gates.find((g) => g.name === name);

/** A governed change-loop run: one completed maker with a worktree + assignment, one accepted manual checker. */
function governedRun(makerMeta: Record<string, unknown> = { diff_lines: 1, diff_max_lines: 20 }) {
  db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
    .run('run', 'doc-drift-and-small-fix-loop', 'closed', 'running', root, FINDINGS, JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(worktree, 'LOOP_WORK.md'); fs.writeFileSync(assignment, 'Synthetic assignment');
  loops.insertWorkerLease({ id: 'run-maker', loopRunId: 'run', role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: worktree, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment, ...makerMeta, deterministic_checks: [{ name: 'fixture', status: 'pass' }] } });
  loops.updateWorkerLeaseStatus('run-maker', 'completed', {});
  loops.insertWorkerLease({ id: 'run-checker', loopRunId: 'run', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    now: new Date().toISOString(), metadata: { maker_lease_id: 'run-maker' } });
  loops.updateWorkerLeaseStatus('run-checker', 'completed', { verdict: 'accepted', manual_review_attestation: { reviewer: 'op', reviewer_type: 'human', reviewer_user_id: 'user-op', reason: 'fixture' } });
}

beforeEach(() => {
  vi.spyOn(ExperienceRetrievalService.prototype, 'indexRun').mockResolvedValue();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-gate-evidence-'));
  worktree = path.join(root, 'maker'); fs.mkdirSync(worktree);
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('U4a no_automatic_merge reports whether auto-merge may act', () => {
  it('off / shadow: the loop cannot merge → pass (unchanged)', () => {
    governedRun();
    for (const mode of ['', 'off', 'shadow']) {
      vi.stubEnv('LOOP_AUTO_MERGE_TEST_ONLY', mode);
      expect(gateOf(loops.verifyLoopRun('run').gates, 'no_automatic_merge')?.status).toBe('pass');
    }
  });

  it('act: not applicable (skipped, "auto-merge may act"), never a hard-coded pass', () => {
    governedRun();
    vi.stubEnv('LOOP_AUTO_MERGE_TEST_ONLY', 'act');
    const g = gateOf(loops.verifyLoopRun('run').gates, 'no_automatic_merge');
    expect(g?.status).toBe('skipped');
    expect(g?.evidence).toContain('auto-merge may act');
  });

  it('act: certification and completion semantics unchanged (skipped is not a failure)', () => {
    governedRun();
    vi.stubEnv('LOOP_AUTO_MERGE_TEST_ONLY', 'off');
    const before = loops.certifyLoopRun('run');
    vi.stubEnv('LOOP_AUTO_MERGE_TEST_ONLY', 'act');
    const after = loops.certifyLoopRun('run');
    expect(before.run.status).toBe('ready_for_human_merge');
    expect(after.run.status).toBe(before.run.status);
    expect(after.certified).toBe(before.certified);
    expect(after.certified).toBe(true);
    expect(after.run.metadata.block_reason).toBeUndefined();
    const notice = { name: 'no_automatic_merge', status: 'skipped' as const };
    expect(gatePasses(notice)).toBe(true);
    expect(allGatesPassed([{ name: 'checker_verdict', status: 'pass' }, notice])).toBe(true);
    expect(runCertified({ status: 'ready_for_human_merge', gates: [{ name: 'checker_verdict', status: 'pass' }, notice] })).toBe(true);
    // the daemon's strict completion rule (every gate 'pass') counts the act-mode notice as it counted the old pass
    expect([{ name: 'checker_verdict', status: 'pass' as const }, notice].every(gatePassesStrict)).toBe(true);
    // and nothing else changes: another skipped gate is still not a strict pass, a failed merge gate still fails
    expect(gatePassesStrict({ name: 'tests_lint_typecheck', status: 'skipped' })).toBe(false);
    expect(gatePassesStrict({ name: 'no_automatic_merge', status: 'fail' })).toBe(false);
    expect(gatePasses({ name: 'no_automatic_merge', status: 'unknown' })).toBe(false);
  });
});

describe('U4b diff_threshold_all_makers: absent diff_lines is insufficient evidence', () => {
  it('a completed maker within its threshold passes (unchanged)', () => {
    governedRun({ diff_lines: 5, diff_max_lines: 20 });
    expect(gateOf(loops.verifyLoopRun('run').gates, 'diff_threshold_all_makers')?.status).toBe('pass');
  });

  it('a completed maker over its threshold fails (unchanged)', () => {
    governedRun({ diff_lines: 50, diff_max_lines: 20 });
    const { gates, run } = loops.verifyLoopRun('run');
    expect(gateOf(gates, 'diff_threshold_all_makers')?.status).toBe('fail');
    expect(run.metadata.block_reason).toBe('gate_failed');
  });

  it('a lease without diff_lines → gate unknown, run blocked insufficient_evidence (was: pass)', () => {
    governedRun({ diff_max_lines: 20 });
    const { gates, run } = loops.verifyLoopRun('run');
    expect(gateOf(gates, 'diff_threshold_all_makers')?.status).toBe('unknown');
    expect(gates.some((g) => g.status === 'fail')).toBe(false);
    expect(run.status).toBe('blocked');
    expect(run.metadata.block_reason).toBe('insufficient_evidence');
    expect(run.metadata.unknown_gates).toEqual(expect.arrayContaining([expect.stringMatching(/^diff_threshold_all_makers/)]));
    expect(loops.certifyLoopRun('run').certified).toBe(false);
  });

  it('a lease without a configured threshold still fails (never weakened to unknown)', () => {
    governedRun({ diff_lines: 5 });
    expect(gateOf(loops.verifyLoopRun('run').gates, 'diff_threshold_all_makers')?.status).toBe('fail');
  });
});
