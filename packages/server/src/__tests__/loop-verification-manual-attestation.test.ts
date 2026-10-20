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

beforeEach(() => {
  // P0-4 decision 1: these leases are created after MANUAL_ATTESTATION_IDENTITY_SINCE, so the full identity rule applies
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T12:00:00Z') });
  vi.spyOn(ExperienceRetrievalService.prototype, 'indexRun').mockResolvedValue();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-manual-attestation-'));
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
    .run('run', 'doc-drift-and-small-fix-loop', 'closed', 'running', root,
      JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fixture', evidence: 'Synthetic', suggested_fix: 'None' }]),
      JSON.stringify({ risk_class: 'low' }));
  for (const role of ['maker', 'checker'] as const) {
    loops.insertWorkerLease({ id: role, loopRunId: 'run', role, runtime: 'manual', findingId: 'finding',
      worktreePath: role === 'maker' ? root : null, branchName: null, now: new Date().toISOString(),
      metadata: role === 'maker'
        ? { assignment_file: path.join(root, 'LOOP_WORK.md'), diff_lines: 0, diff_max_lines: 20, deterministic_checks: [{ name: 'fixture', status: 'pass' }] }
        : { maker_lease_id: 'maker' } });
  }
  fs.writeFileSync(path.join(root, 'LOOP_WORK.md'), 'Synthetic assignment');
  loops.updateWorkerLeaseStatus('maker', 'completed', {});
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const gate = (name: string) => loops.verifyLoopRun('run').gates.find(c => c.name === name);

it('rejects manual verdict submission without attestation', () => {
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted' }))
    .toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED');
});

it('rejects manual verdict submission with empty attestation fields', () => {
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: '', reason: 'x' } }))
    .toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED');
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'op', reason: ' ' } }))
    .not.toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED');
});

it('accepts manual verdict from an authenticated actor and persists the actor as reviewer', () => {
  loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'op', reason: 'documented manual review' } }, { id: 'user-1', email: 'op@example.test' });
  expect(gate('checker_verdict')?.status).toBe('pass');
  const lease = loops.getWorkerLease('checker');
  expect(lease.metadata.manual_review_attestation).toEqual({ reviewer: 'op@example.test', reviewer_user_id: 'user-1', reviewer_type: 'human', reason: 'documented manual review' });
});

it('P0-4: a reviewer string without an authenticated actor (or a legacy attestation) fails the gate', () => {
  loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'op', reason: 'documented manual review', reviewer_type: 'human' } });
  expect(gate('checker_verdict')?.status).toBe('fail');
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted', manual_review_attestation: { reviewer: 'op', reason: 'legacy' } });
  expect(gate('checker_verdict')?.status).toBe('fail');
});

it('P0-4 decision 1: an attestation recorded before the identity cutoff without a user id keeps passing, labelled legacy_unverified_identity', () => {
  db.prepare("UPDATE worker_leases SET created_at = '2026-10-01T09:00:00.000Z' WHERE id = 'checker'").run();
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted', completed_at: '2026-10-01T10:00:00.000Z', manual_review_attestation: { reviewer: 'op', reason: 'legacy' } });
  const g = gate('checker_verdict');
  expect(g?.status).toBe('pass');
  expect(g?.evidence).toContain('legacy_unverified_identity');
  // the label is not given to a lease created before the cutoff whose attestation is recorded after it
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted', completed_at: '2026-10-22T10:00:00.000Z', manual_review_attestation: { reviewer: 'op', reason: 'late' } });
  expect(gate('checker_verdict')?.status).toBe('fail');
});

it('P0-4 decision 1: a new attestation without a user id fails, and a full-identity one carries no legacy label', () => {
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted', completed_at: new Date().toISOString(), manual_review_attestation: { reviewer: 'op', reason: 'new' } });
  expect(gate('checker_verdict')?.status).toBe('fail');
  loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'op', reason: 'reviewed' } }, { id: 'user-1' });
  expect(gate('checker_verdict')?.status).toBe('pass');
  expect(gate('checker_verdict')?.evidence).not.toContain('legacy_unverified_identity');
});

it('P0-4 decision 2: for an authenticated actor the notes field is the reason when none is sent (trimmed, non-empty, <= 2000 chars)', () => {
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', notes: '   ' }, { id: 'user-1' })).toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED');
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', notes: 'x'.repeat(2001) }, { id: 'user-1' })).toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED');
  expect(() => loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', notes: 'Accepted from dashboard' })).toThrow('MANUAL_VERDICT_ATTESTATION_REQUIRED'); // no actor: notes never count
  loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', notes: '  Accepted from dashboard  ' }, { id: 'user-1', email: 'op@example.test' });
  expect(loops.getWorkerLease('checker').metadata.manual_review_attestation).toEqual({ reviewer: 'op@example.test', reviewer_user_id: 'user-1', reviewer_type: 'human', reason: 'Accepted from dashboard' });
  expect(gate('checker_verdict')?.status).toBe('pass');
});

it('direct lease update with manual runtime + accepted verdict but no attestation fails the gate', () => {
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted' });
  expect(gate('checker_verdict')?.status).toBe('fail');
});
