import { afterEach, expect, it, vi } from 'vitest';
// admission is judged at a fixed instant, not the wall clock (helpers/admission-now.ts; ledger expiries 2026-11-27 / 2026-12-31)
vi.mock('../execution/runtime-admission', () => import('./helpers/admission-now').then((m) => m.admissionAtFixedNow()));
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';

afterEach(() => vi.unstubAllEnvs());
it('registers a bounded DjimitSec executor rather than sending scan tasks to an LLM shell', () => {
  vi.stubEnv('DJIMITSEC_SCAN_MODE', 'off');
  const db = new Database(':memory:');
  try {
    db.exec(schema); runMigrations(db);
    const executor = new ExecutionEngine(db).getExecutor('djimitsec' as ExecutorKind);
    expect(executor).toBeDefined();
    expect(executor?.canExecute({ metadata: {} } as never)).toBe(false);
  } finally { db.close(); }
});

import { createServer, type Server } from 'http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@djimitflo/shared';
import { DjimitSecExecutor } from '../execution/executors/djimitsec-executor';

const taskId = '0040b22b-86d1-488d-bcd3-5def1bc09bca';
const commit = 'a'.repeat(40), workerDigest = 'b'.repeat(64), investigationId = '4b6a3b23-696f-4438-9223-79aa7adb8898';
const scanTask = (): Task => ({ id: taskId, title: 'Fixed scan', description: 'Untrusted content is never executed', status: 'pending', metadata: { executor: 'djimitsec', djimitsecScan: { repositoryId: 'owned/fixture', commit } } } as Task);
const collected = () => ({ taskId, repositoryId: 'owned/fixture', commit, investigationId, bundleDigest: 'c'.repeat(64), state: 'collected', verified: false });
async function fixture(handler?: (path: string, request: Record<string, unknown>, response: import('http').ServerResponse) => void) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += String(chunk);
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    requests.push({ path: req.url!, body });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-only-never-production') { res.writeHead(401).end('{}'); return; }
    if (req.url === '/health') { res.end(JSON.stringify({ service: 'djimitsec-scanner', version: '1.0.0', implementationDigest: workerDigest, ready: true })); return; }
    if (handler) handler(req.url!, body, res); else res.end(JSON.stringify(collected()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind');
  const directory = mkdtempSync(join(tmpdir(), 'djimitsec-executor-')); chmodSync(directory, 0o700);
  const token = join(directory, 'token'), path = join(directory, 'config.json');
  writeFileSync(token, 'fixture-only-never-production', { mode: 0o600 });
  writeFileSync(path, JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, tokenFile: token, repositoryIds: ['owned/fixture'], implementationDigest: workerDigest, timeoutMs: 1000 }), { mode: 0o600 });
  vi.stubEnv('DJIMITSEC_SCAN_CONFIG', path); vi.stubEnv('DJIMITSEC_SCAN_MODE', 'execute');
  const db = new Database(':memory:');
  return { db, requests, token, path, executor: new DjimitSecExecutor(db), close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
it('probes the pinned actual HTTP worker and sends only the fixed native identity/repository/revision', async () => {
  const f = await fixture();
  try {
    await f.executor.prepare(scanTask());
    const probe = f.db.prepare('SELECT contract_json FROM runtime_contract_probes WHERE runtime=?').get('djimitsec') as { contract_json: string };
    expect(JSON.parse(probe.contract_json)).toMatchObject({ version: '1.0.0', worker: { implementationDigest: workerDigest } });
    const session = await f.executor.start(scanTask());
    const events = (async () => { const rows = []; for await (const row of session.events) rows.push(row); return rows; })();
    const result = await session.result; await session.closed;
    expect(result.status).toBe('completed'); expect(JSON.parse(result.stdout!)).toEqual(collected());
    expect(result.message).toContain('verified=false');
    expect(f.requests).toEqual([{ path: '/health', body: {} }, { path: '/scan', body: { taskId, repositoryId: 'owned/fixture', commit } }]);
    expect((await events).at(-1)?.tool_output).toEqual(collected());
  } finally { await f.close(); }
});
it('fails closed on disabled/shadow, caller control fields, foreign repository and public token files', async () => {
  const f = await fixture();
  try {
    for (const name of ['off', 'shadow']) { vi.stubEnv('DJIMITSEC_SCAN_MODE', name); expect(f.executor.canExecute(scanTask())).toBe(false); }
    vi.stubEnv('DJIMITSEC_SCAN_MODE', 'execute');
    for (const metadata of [{ djimitsecScan: { repositoryId: 'foreign/repo', commit } }, { djimitsecScan: { repositoryId: 'owned/fixture', commit: 'main' } }, { djimitsecScan: { repositoryId: 'owned/fixture', commit, url: 'http://attacker' } }, ...['model', 'environment', 'workingDirectory', 'timeoutMs', 'skipPermissions', 'sandbox'].map(key => ({ ...scanTask().metadata, [key]: 'caller' }))]) expect(f.executor.canExecute({ ...scanTask(), metadata })).toBe(false);
    chmodSync(f.token, 0o644);
    await expect(f.executor.prepare(scanTask())).rejects.toThrow('PRIVATE_FILE');
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});
it('readbacks an ambiguous POST exactly once without retrying the scan or accepting mismatched observations', async () => {
  let reads = 0;
  const f = await fixture((path, _body, res) => {
    if (path === '/scan') res.destroy();
    else { reads++; res.end(JSON.stringify(collected())); }
  });
  try {
    const result = await (await f.executor.start(scanTask())).result;
    expect(result.status).toBe('completed'); expect(reads).toBe(1);
    expect(f.requests.filter(row => row.path === '/scan')).toHaveLength(1);
  } finally { await f.close(); }
  const bad = await fixture((_path, _body, res) => res.end(JSON.stringify({ ...collected(), commit: 'd'.repeat(40), verified: true })));
  try {
    const result = await (await bad.executor.start(scanTask())).result;
    expect(result.failure).toMatchObject({ code: 'DJIMITSEC_SCAN_HELD', retryable: false, sideEffectsPossible: true });
    expect(bad.requests).toHaveLength(1);
  } finally { await bad.close(); }
});
it('requires an observed cancellation receipt and preserves running/held as non-success', async () => {
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture((path, _body, res) => {
    if (path === '/scan') { started(); return; }
    res.end(JSON.stringify({ ...collected(), state: path.endsWith('/cancel') ? 'cancelled' : 'running' }));
  });
  try {
    const session = await f.executor.start(scanTask()); await pending;
    await session.cancel();
    expect((await session.result).status).toBe('cancelled');
    expect(f.requests.filter(row => row.path.endsWith('/cancel'))).toHaveLength(1);
  } finally { await f.close(); }
  const held = await fixture((_path, _body, res) => res.end(JSON.stringify({ ...collected(), state: 'running' })));
  try { expect((await (await held.executor.start(scanTask())).result).failure?.code).toBe('DJIMITSEC_SCAN_HELD'); }
  finally { await held.close(); }
});

it('uses native admission, task state, shared capacity and immutable tool events for an actual worker HTTP operation', async () => {
  const f = await fixture();
  try {
    f.db.exec(schema); runMigrations(f.db);
    f.db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata) VALUES(?,?,?,?,?,?,?,?)')
      .run(taskId, 'Repository observation', 'Inspect fixed owned source only', 'pending', 'low', 'low', 'local', JSON.stringify(scanTask().metadata));
    const engine = new ExecutionEngine(f.db);
    const execution = await engine.executeTask(taskId, 'djimitsec');
    expect(execution.status).toBe('started');
    expect((await execution.completion)?.status).toBe('completed');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'completed' });
    const events = f.db.prepare('SELECT tool_name,tool_input,tool_output FROM execution_events WHERE task_id=? AND tool_name=? ORDER BY rowid').all(taskId, 'djimitsec.scan_repository') as Array<{ tool_name: string; tool_input: string | null; tool_output: string | null }>;
    expect(events.some(row => row.tool_input && JSON.parse(row.tool_input).commit === commit)).toBe(true);
    expect(events.some(row => row.tool_output && JSON.parse(row.tool_output).verified === false)).toBe(true);
    expect(f.requests.filter(row => row.path === '/scan')).toHaveLength(1);
    await expect(engine.executeTask(taskId, 'codex')).rejects.toMatchObject({ code: 'DJIMITSEC_EXECUTOR_REQUIRED' });
  } finally { await f.close(); }
});

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import supertest from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';
import * as filesystem from 'fs';
import { privateScanText } from '../execution/executors/djimitsec-executor';
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

it('bounds private descriptor reads and rejects growth between captured stat and read', async () => {
  const f = await fixture();
  try {
    const original = (await vi.importActual<typeof import('fs')>('fs')).readSync;
    const spy = vi.mocked(filesystem.readSync).mockImplementationOnce((...args: Parameters<typeof filesystem.readSync>) => {
      filesystem.appendFileSync(f.token, 'x'.repeat(70000));
      return original(...args);
    });
    expect(() => privateScanText(f.token, 16384)).toThrow('PRIVATE_FILE_CHANGED');
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls.at(-1)?.[1] as Buffer).length).toBeLessThanOrEqual(16384); spy.mockRestore();
  } finally { await f.close(); }
});
it.each(['cancelled', 'held'])('native authenticated cancel preserves the observed worker stop outcome %s', async workerState => {
  let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
  let scanSocketClosed = false;
  const f = await fixture((path, _body, res) => {
    if (path === '/scan') { res.on('close', () => { scanSocketClosed = true; }); started(); return; }
    res.end(JSON.stringify({ ...collected(), state: path.endsWith('/cancel') ? workerState : 'running' }));
  });
  try {
    f.db.exec(schema); runMigrations(f.db);
    const authService = new AuthService(f.db), owner = authService.createUser('owner@fixture.test', 'Disposable-fixture-only-123!', UserRole.MAKER), foreign = authService.createUser('foreign@fixture.test', 'Disposable-fixture-only-123!', UserRole.MAKER);
    const token = authService.generateToken(owner), otherToken = authService.generateToken(foreign), auth = createAuthMiddleware(authService);
    f.db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata,created_by,owner_user_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(taskId, 'Fixed scan', 'Inspect fixed owned source', 'pending', 'low', 'low', 'local', JSON.stringify(scanTask().metadata), owner.id, owner.id);
    const engine = new ExecutionEngine(f.db), app = express(); app.use(express.json()); app.use('/api/tasks', rateLimit({ windowMs: 60000, limit: 300 }), auth.requireAuth, createTaskRoutes(f.db, engine, auth)); app.use(errorHandler);
    const execute = await supertest(app).post(`/api/tasks/${taskId}/execute`).set('authorization', `Bearer ${token}`).send({ executor: 'djimitsec' });
    expect(execute.status).toBe(200); await pending;
    expect((await supertest(app).post(`/api/tasks/${taskId}/cancel`).set('authorization', `Bearer ${otherToken}`).send({})).status).toBe(404);
    expect(f.requests.some(row => row.path.endsWith('/cancel'))).toBe(false);
    const cancelled = await supertest(app).post(`/api/tasks/${taskId}/cancel`).set('authorization', `Bearer ${token}`).send({});
    if (workerState === 'cancelled') {
      expect(cancelled.status).toBe(200);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'cancelled' });
    } else {
      expect(cancelled.status).toBe(500);
      const held = f.db.prepare('SELECT status,metadata FROM tasks WHERE id=?').get(taskId) as { status: string; metadata: string };
      expect(held.status).toBe('paused'); expect(JSON.parse(held.metadata).execution_recovery_hold).toBe(true);
      expect((await supertest(app).post(`/api/tasks/${taskId}/cancel`).set('authorization', `Bearer ${token}`).send({})).status).toBe(409);
      await expect(engine.executeTask(taskId, 'djimitsec')).rejects.toMatchObject({ code: 'EXECUTION_RECOVERY_REQUIRED' });
    }
    const patched = await supertest(app).patch(`/api/tasks/${taskId}`).set('authorization', `Bearer ${token}`).send({ metadata: { executor: 'codex', djimitsecScan: { repositoryId: 'foreign/repo', commit: 'd'.repeat(40) }, djimitsecScanTrigger: { dedupeKey: 'forged' } } });
    expect(patched.status).toBe(200); expect(patched.body.metadata.djimitsecScan).toEqual(scanTask().metadata.djimitsecScan); expect(patched.body.metadata.executor).toBe('djimitsec'); expect(patched.body.metadata.djimitsecScanTrigger).toBeUndefined();
    expect(f.requests.filter(row => row.path === `/runs/${taskId}/cancel`)).toHaveLength(1);
    expect(f.requests.find(row => row.path === `/runs/${taskId}/cancel`)?.body).toEqual({});
    await vi.waitFor(() => expect(scanSocketClosed).toBe(true));
    expect(engine.isTaskRunning(taskId)).toBe(false);
  } finally { await f.close(); }
});

import { createHash } from 'crypto';
import { RUNTIME_ADMISSIONS } from '../execution/runtime-admission';
it('binds the prepared first-party adapter bytes in the independent-review admission record', () => {
  const record = RUNTIME_ADMISSIONS.find(row => row.runtime_id === 'djimitsec');
  const bytes = filesystem.readFileSync(new URL('../execution/executors/djimitsec-executor.ts', import.meta.url));
  expect(record?.artifact_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(record?.runtime_version).toBe('1.0.0'); expect(record?.child_agents).toBe('NONE');
  expect(record?.conditions).toEqual(expect.arrayContaining([expect.stringContaining('off'), expect.stringContaining('No caller URL')]));
});
