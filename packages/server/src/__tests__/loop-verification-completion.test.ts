import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { ExperienceRetrievalService } from '../services/experience-retrieval-service';
import type { WorkerLeaseRecord } from '../services/loop-types';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let loops: LoopService;
let root: string;

beforeEach(() => {
  vi.spyOn(ExperienceRetrievalService.prototype, 'indexRun').mockResolvedValue();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-completion-gates-'));
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
    .run('run', 'doc-drift-and-small-fix-loop', 'closed', 'running', root,
      JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fixture', evidence: 'Synthetic', suggested_fix: 'None' }]),
      JSON.stringify({ risk_class: 'high', provenance: 'retained' }));
  for (const index of [1, 2]) {
    const worktree = path.join(root, `maker-${index}`); fs.mkdirSync(worktree);
    const assignment = path.join(worktree, 'LOOP_WORK.md'); fs.writeFileSync(assignment, 'Synthetic assignment');
    for (const role of ['maker', 'checker', 'security_checker'] as const) {
      const id = `${role}-${index}`;
      loops.insertWorkerLease({ id, loopRunId: 'run', role, runtime: 'manual', findingId: 'finding',
        worktreePath: role === 'maker' ? worktree : null, branchName: null, now: new Date().toISOString(),
        metadata: role === 'maker' ? { assignment_file: assignment, diff_lines: 0, diff_max_lines: 20,
          deterministic_checks: [{ name: 'fixture', status: 'pass' }] } : { maker_lease_id: `maker-${index}` } });
      loops.updateWorkerLeaseStatus(id, 'completed', role === 'maker' ? {} : { verdict: 'accepted' });
    }
  }
});

afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it.each(['prepared', 'running', 'failed', 'cancelled'] as WorkerLeaseRecord['status'][])
('does not certify a completed subset while another active maker is %s', (status) => {
  loops.updateWorkerLeaseStatus('maker-2', status, {});
  loops.updateWorkerLeaseStatus('checker-2', 'prepared', {});
  loops.updateWorkerLeaseStatus('security_checker-2', 'prepared', {});
  const result = loops.certifyLoopRun('run');
  expect(result.certified).toBe(false);
  expect(result.run.status).not.toBe('ready_for_human_merge');
  expect(result.gates.find(gate => gate.name === 'maker_completion')?.status).toBe('fail');
  expect(() => loops.completeLoopRun('run', { human_approval_ref: 'fixture' })).toThrow(/LOOP_COMPLETION/);
});

it('does not certify vacuously when no maker is completed', () => {
  loops.updateWorkerLeaseStatus('maker-1', 'prepared', {});
  loops.updateWorkerLeaseStatus('maker-2', 'prepared', {});
  expect(loops.certifyLoopRun('run').certified).toBe(false);
});

it('requires at least one non-superseded maker', () => {
  db.prepare('DELETE FROM worker_leases').run();
  const result = loops.certifyLoopRun('run');
  expect(result.certified).toBe(false);
  expect(result.gates.find(gate => gate.name === 'maker_completion')?.status).toBe('fail');
});

it('preserves a cancelled run and refuses completion even if every lease was reviewed', () => {
  db.prepare('UPDATE loop_runs SET status = ? WHERE id = ?').run('cancelled', 'run');
  const result = loops.certifyLoopRun('run');
  expect(result.run.status).toBe('cancelled');
  expect(result.certified).toBe(false);
  expect(() => loops.completeLoopRun('run', { human_approval_ref: 'fixture' })).toThrow('LOOP_COMPLETION_CANCELLED');
  expect(loops.getLoopRun('run').status).toBe('cancelled');
});

it('preserves completed status on reverify and returns completion idempotently', () => {
  const completed = loops.completeLoopRun('run', { human_approval_ref: 'fixture-original' }).run;
  const eventCount = loops.listLoopEvents('run').filter(event => event.event_type === 'loop_completed').length;
  expect(loops.verifyLoopRun('run').run.status).toBe('completed');
  const repeated = loops.completeLoopRun('run').run;
  expect(repeated.status).toBe('completed');
  expect(repeated.completed_at).toBe(completed.completed_at);
  expect(repeated.metadata.human_approval_ref).toBe('fixture-original');
  expect(loops.listLoopEvents('run').filter(event => event.event_type === 'loop_completed')).toHaveLength(eventCount);
});

it('certifies a fully reviewed high-risk run but still requires human approval to complete', () => {
  const result = loops.certifyLoopRun('run');
  expect(result.certified).toBe(true);
  expect(result.run.status).toBe('ready_for_human_merge');
  expect(result.gates.find(gate => gate.name === 'security_checker_verdict')?.status).toBe('pass');
  expect(result.run.metadata.provenance).toBe('retained');
  expect(() => loops.completeLoopRun('run')).toThrow('LOOP_HUMAN_APPROVAL_REQUIRED');
});

it('ignores reviews of superseded makers consistently when a retry is fully reviewed', () => {
  loops.updateWorkerLeaseStatus('maker-1', 'failed', { superseded_by_maker_lease_id: 'maker-2' });
  loops.updateWorkerLeaseStatus('checker-1', 'prepared', {});
  loops.updateWorkerLeaseStatus('security_checker-1', 'prepared', {});
  expect(loops.certifyLoopRun('run').certified).toBe(true);
  expect(loops.completeLoopRun('run', { human_approval_ref: 'fixture' }).run.status).toBe('completed');
});

it('returns an HTTP conflict rather than a server error for cancelled completion', async () => {
  db.prepare('UPDATE loop_runs SET status = ? WHERE id = ?').run('cancelled', 'run');
  const app = express(); app.use(express.json());
  app.use('/loops', createLoopRoutes(db, undefined, path.join(root, 'evidence')));
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/loops/runs/run/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ human_approval_ref: 'fixture' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'LOOP_COMPLETION_CANCELLED' } });
    expect(loops.getLoopRun('run').status).toBe('cancelled');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
