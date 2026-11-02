import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createLoopRoutes } from '../routes/loops';
import { LoopService } from '../services/loop-service';
import { ExperienceRetrievalService } from '../services/experience-retrieval-service';

// P0-4: a manual checker/security verdict is an approval. Only approve:task may submit it, and the recorded reviewer is
// the authenticated user — a body-supplied reviewer string is ignored and never passes the gate on its own.
let db: Database.Database;
let root: string;
let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const savedSecret = process.env.JWT_SECRET;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T12:00:00Z') }); // after MANUAL_ATTESTATION_IDENTITY_SINCE
  vi.spyOn(ExperienceRetrievalService.prototype, 'indexRun').mockResolvedValue();
  process.env.JWT_SECRET = 'loop-verdict-identity-secret-'.repeat(3);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-verdict-identity-'));
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  const authService = new AuthService(db);
  for (const role of [UserRole.APPROVER, UserRole.MAKER, UserRole.VIEWER]) {
    const user = authService.createUser(`${role}@verdict.test`, 'Verdict-identity-test-password-123!', role);
    ids[role] = user.id; tokens[role] = authService.generateToken(user);
  }
  db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
    .run('run', 'doc-drift-and-small-fix-loop', 'closed', 'running', root,
      JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fixture', evidence: 'Synthetic', suggested_fix: 'None' }]),
      JSON.stringify({ risk_class: 'low' }));
  const loops = new LoopService(db, path.join(root, 'evidence'));
  for (const role of ['maker', 'checker'] as const) {
    loops.insertWorkerLease({ id: role, loopRunId: 'run', role, runtime: 'manual', findingId: 'finding',
      worktreePath: role === 'maker' ? root : null, branchName: null, now: new Date().toISOString(),
      metadata: role === 'maker'
        ? { assignment_file: path.join(root, 'LOOP_WORK.md'), diff_lines: 0, diff_max_lines: 20, deterministic_checks: [{ name: 'fixture', status: 'pass' }] }
        : { maker_lease_id: 'maker' } });
  }
  fs.writeFileSync(path.join(root, 'LOOP_WORK.md'), 'Synthetic assignment');
  loops.updateWorkerLeaseStatus('maker', 'completed', {});
  const auth = createAuthMiddleware(authService);
  const app = express(); app.use(express.json()); app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  app.use('/loops', auth.requireAuth, createLoopRoutes(db, auth, path.join(root, 'evidence')));
  app.use(errorHandler);
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/loops`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.useRealTimers(); vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  if (savedSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = savedSecret;
});

const body = { lease_id: 'checker', verdict: 'accepted', manual_attestation: { reviewer: 'someone-else', reason: 'reviewed the diff', reviewer_type: 'human' } };
const post = (route: string, token?: string) => fetch(`${base}/runs/run/${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const attestation = () => new LoopService(db, path.join(root, 'evidence')).getWorkerLease('checker').metadata.manual_review_attestation;
const gate = () => new LoopService(db, path.join(root, 'evidence')).verifyLoopRun('run').gates.find((g) => g.name === 'checker_verdict')?.status;

it('verdict routes need approve:task: viewer and maker (create:task only) get 403, no token 401', async () => {
  for (const route of ['checker-verdict', 'security-verdict']) {
    expect((await post(route)).status).toBe(401);
    expect((await post(route, tokens[UserRole.VIEWER])).status).toBe(403);
    expect((await post(route, tokens[UserRole.MAKER])).status).toBe(403);
  }
  expect(attestation()).toBeUndefined();
});

it('the recorded reviewer is the authenticated user; the body reviewer is ignored', async () => {
  const res = await post('checker-verdict', tokens[UserRole.APPROVER]);
  expect(res.status).toBe(200);
  expect(attestation()).toEqual({ reviewer: 'approver@verdict.test', reviewer_user_id: ids[UserRole.APPROVER], reviewer_type: 'human', reason: 'reviewed the diff' });
  expect(gate()).toBe('pass');
});

it('an in-process call without an actor cannot claim human attestation and fails the gate', () => {
  const loops = new LoopService(db, path.join(root, 'evidence'));
  loops.submitCheckerVerdict('run', body as never);
  expect(attestation()).toEqual({ reviewer: 'someone-else', reason: 'reviewed the diff' });
  expect(gate()).toBe('fail');
});
