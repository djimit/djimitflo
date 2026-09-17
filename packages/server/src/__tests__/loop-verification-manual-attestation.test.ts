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

afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

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

it('accepts manual verdict with attestation and persists it on the lease', () => {
  loops.submitCheckerVerdict('run', { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'op', reason: 'documented manual review' } });
  expect(gate('checker_verdict')?.status).toBe('pass');
  const lease = loops.getWorkerLease('checker');
  expect(lease.metadata.manual_review_attestation).toEqual({ reviewer: 'op', reason: 'documented manual review' });
});

it('direct lease update with manual runtime + accepted verdict but no attestation fails the gate', () => {
  loops.updateWorkerLeaseStatus('checker', 'completed', { verdict: 'accepted' });
  expect(gate('checker_verdict')?.status).toBe('fail');
});
