import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemorySyncService } from '../services/memory-sync-service';
import { memoryDeliveryEvidence } from '../services/memory-delivery-receipts';
import { pointIdForTask } from '../utils/qdrant-point-id';

/**
 * CODE-004 follow-up (#1056): durable per-task, per-target delivery receipts behind MEMORY_DELIVERY_RECEIPTS.
 * A restart is a new MemorySyncService on the same database.
 */
let tmpOkf: string;

function taskDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, created_by TEXT, agent_id TEXT, created_at TEXT, completed_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, agent_type TEXT);
    INSERT INTO agents VALUES ('a1', 'maker');`);
  for (const id of ['task-1', 'task-2']) {
    db.prepare(`INSERT INTO tasks VALUES (?, 'T', 'do the thing', 'completed', 'macbook', 'a1', '2026-10-27T00:00:00Z', '2026-10-27T00:01:00Z')`).run(id);
  }
  return db;
}

type Call = { url: string; method: string; body?: string };
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** A fake UAMS + Ollama + Qdrant. `qdrantPoints` is the set of stored point ids (read-back reads it). */
function fakeTargets(opts: { uams?: 'ok' | 'timeout' | 401; upsert?: 'ok' | 503 } = {}) {
  const calls: Call[] = [];
  const qdrantPoints = new Set<string>();
  const state = { uams: opts.uams ?? 'ok', upsert: opts.upsert ?? 'ok' };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url.endsWith('/memory/entry')) {
      if (state.uams === 'timeout') throw timeoutError();
      return new Response('{}', { status: state.uams === 'ok' ? 201 : state.uams });
    }
    if (url.includes('/api/embed')) return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    if (url.endsWith('/collections/djimitflo_swarm/points') && method === 'PUT') {
      if (state.upsert !== 'ok') return new Response('{}', { status: state.upsert });
      for (const p of JSON.parse(String(init?.body)).points) qdrantPoints.add(String(p.id));
      return new Response('{}');
    }
    const point = url.match(/\/collections\/djimitflo_swarm\/points\/([^/?]+)$/);
    if (point) {
      return qdrantPoints.has(point[1])
        ? new Response(JSON.stringify({ result: { id: point[1], payload: {} } }))
        : new Response(JSON.stringify({ status: { error: 'Not found' } }), { status: 404 });
    }
    if (url.endsWith('/collections/djimitflo_swarm')) return new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 3 } } } } }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFn);
  return { calls, qdrantPoints, state };
}

const receipts = (db: Database.Database) =>
  db.prepare('SELECT task_id, target, status, attempts FROM memory_sync_receipts ORDER BY task_id, target').all() as Array<{ task_id: string; target: string; status: string; attempts: number }>;
const statusOf = (db: Database.Database, task: string, target: string) => receipts(db).find((r) => r.task_id === task && r.target === target)?.status;
const posts = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/memory/entry'));
const upserts = (calls: Call[], task: string) =>
  calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/points') && JSON.parse(c.body || '{}').points?.[0]?.id === pointIdForTask(task));

beforeEach(() => {
  tmpOkf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-receipts-'));
  process.env.OKF_BASE = tmpOkf;
  process.env.UAMS_URL = 'http://uams.test:8000';
  process.env.QDRANT_URL = 'http://qdrant.test:6333';
  process.env.OLLAMA_URL = 'http://ollama.test:11434';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['OKF_BASE', 'UAMS_URL', 'QDRANT_URL', 'OLLAMA_URL', 'MEMORY_DELIVERY_RECEIPTS']) delete process.env[k];
  fs.rmSync(tmpOkf, { recursive: true, force: true });
});

describe('CODE-004: memory delivery receipts', () => {
  it('a restart reconciles failed and unknown legs: idempotent legs retried or read back, the UAMS unknown left and reported', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ uams: 'timeout', upsert: 503 });
    const first = new MemorySyncService(db);
    await first.onTaskCompleted('task-1');
    expect(receipts(db).map((r) => [r.task_id, r.target, r.status])).toEqual([
      ['task-1', 'okf', 'delivered'], ['task-1', 'qdrant', 'failed'], ['task-1', 'uams', 'unknown'],
    ]);

    // task-2: the process died with the Qdrant upsert in flight (write-ahead receipt, no outcome) — but the point landed
    db.prepare(`INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at) VALUES ('task-2', 'qdrant', 'unknown', 'in_flight', 1, '2026-01-01T00:00:00.000Z')`).run();
    t.qdrantPoints.add(pointIdForTask('task-2'));

    t.state.uams = 'ok';
    t.state.upsert = 'ok';
    t.calls.length = 0;
    const restarted = new MemorySyncService(db);
    const report = await restarted.reconcile();

    expect(statusOf(db, 'task-1', 'qdrant')).toBe('delivered');
    expect(upserts(t.calls, 'task-1')).toHaveLength(1);
    expect(statusOf(db, 'task-2', 'qdrant')).toBe('delivered'); // read back, not resent
    expect(upserts(t.calls, 'task-2')).toHaveLength(0);
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
    expect(posts(t.calls)).toHaveLength(0);
    expect(report).toMatchObject({ mode: 'on', retried: 1, delivered: 1, read_back_delivered: 1, unknown_unreconcilable: 1 });
  });

  it('an idempotent retry delivers exactly once', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ upsert: 503 });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(statusOf(db, 'task-1', 'qdrant')).toBe('failed');
    t.state.upsert = 'ok';
    t.calls.length = 0;

    const restarted = new MemorySyncService(db);
    await restarted.reconcile();
    await restarted.reconcile();
    await restarted.reconcile(Date.now() + 3_600_000); // a later tick

    expect(upserts(t.calls, 'task-1')).toHaveLength(1);
    expect(t.qdrantPoints.has(pointIdForTask('task-1'))).toBe(true);
    expect(receipts(db).find((r) => r.target === 'qdrant')).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(posts(t.calls)).toHaveLength(0); // the delivered UAMS leg is not touched
  });

  it('an unknown non-idempotent leg (UAMS POST) is never resent; a failed one is not retried either', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ uams: 'timeout' });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    t.state.uams = 401;
    await new MemorySyncService(db).onTaskCompleted('task-2');
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
    expect(statusOf(db, 'task-2', 'uams')).toBe('failed');

    t.state.uams = 'ok';
    t.calls.length = 0;
    const restarted = new MemorySyncService(db);
    for (let i = 0; i < 3; i++) await restarted.reconcile(Date.now() + i * 3_600_000);

    expect(posts(t.calls)).toHaveLength(0);
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
    expect(statusOf(db, 'task-2', 'uams')).toBe('failed');
    const evidence = memoryDeliveryEvidence(db, process.env);
    expect(evidence.mode).toBe('on');
    expect(evidence.by_target?.uams).toMatchObject({ idempotent: false, unknown: 1, failed: 1, delivered: 0 });
    expect(evidence.by_target?.qdrant).toMatchObject({ idempotent: true, delivered: 2 });
    expect(evidence.by_target?.okf).toMatchObject({ idempotent: true, delivered: 2 });
  });

  it('shadow records receipts but never replays', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'shadow';
    const db = taskDb();
    const t = fakeTargets({ upsert: 503 });
    const svc = new MemorySyncService(db);
    await svc.onTaskCompleted('task-1');
    expect(statusOf(db, 'task-1', 'qdrant')).toBe('failed');
    t.state.upsert = 'ok';
    t.calls.length = 0;
    expect(await svc.reconcile()).toMatchObject({ mode: 'shadow', retried: 0 });
    expect(svc.start()).toBe(false);
    expect(t.calls).toHaveLength(0);
    expect(statusOf(db, 'task-1', 'qdrant')).toBe('failed');
  });

  it('off (default) does not change behaviour: same calls, no table, no reconciliation', async () => {
    const run = async (mode: string | undefined) => {
      if (mode) process.env.MEMORY_DELIVERY_RECEIPTS = mode; else delete process.env.MEMORY_DELIVERY_RECEIPTS;
      const db = taskDb();
      const t = fakeTargets({ uams: 'timeout', upsert: 503 });
      const svc = new MemorySyncService(db);
      await expect(svc.onTaskCompleted('task-1')).resolves.toBeUndefined();
      return { db, t, svc };
    };
    const off = await run(undefined);
    const explicit = await run('off');
    const strip = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url}`);
    expect(strip(off.t.calls)).toEqual(strip(explicit.t.calls));
    expect(posts(off.t.calls)).toHaveLength(1);
    expect(upserts(off.t.calls, 'task-1')).toHaveLength(1);
    expect(off.db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_sync_receipts'").get()).toBeUndefined();

    off.t.calls.length = 0;
    expect(await off.svc.reconcile()).toMatchObject({ mode: 'off', retried: 0 });
    expect(off.svc.start()).toBe(false);
    expect(off.t.calls).toHaveLength(0);
    expect(off.db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_sync_receipts'").get()).toBeUndefined();
    expect(memoryDeliveryEvidence(off.db, process.env)).toMatchObject({ mode: 'off', by_target: null });
  });
});
