import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { MemorySyncService } from '../services/memory-sync-service';
import {
  memoryDeliveryEvidence,
  receiptMode,
  ensureReceiptsTable,
  claimInitial,
  recordOutcome,
  touchReceipt,
  reconcileCandidates,
  unreconcilableUnknown,
  okfIntent,
  okfIntentHash,
} from '../services/memory-delivery-receipts';
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
type UamsBehaviour = 'ok' | 'timeout' | 401 | 503 | 'reset' | 'refused';
const transportError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

function fakeTargets(opts: { uams?: UamsBehaviour; upsert?: 'ok' | 503 } = {}) {
  const calls: Call[] = [];
  const qdrantPoints = new Set<string>();
  /** UAMS entries the server applied (a reset/5xx after commit still counts) */
  const uamsCommitted: string[] = [];
  const state: { uams: UamsBehaviour; upsert: 'ok' | 503 } = { uams: opts.uams ?? 'ok', upsert: opts.upsert ?? 'ok' };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url.endsWith('/memory/entry')) {
      if (state.uams === 'refused') throw transportError('ECONNREFUSED');
      uamsCommitted.push(String(init?.body));
      if (state.uams === 'timeout') throw timeoutError();
      if (state.uams === 'reset') throw transportError('ECONNRESET'); // committed, then the connection dropped
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
  return { calls, qdrantPoints, state, uamsCommitted };
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

  // byte-identity of off with origin/main is pinned in memory-sync-off-pinned.test.ts
  it('off (default) records nothing and arms nothing', async () => {
    const off = { db: taskDb(), t: fakeTargets({ uams: 'timeout', upsert: 503 }), svc: null as unknown as MemorySyncService };
    off.svc = new MemorySyncService(off.db);
    await expect(off.svc.onTaskCompleted('task-1')).resolves.toBeUndefined();
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

describe('CODE-004 review (#1058): ambiguous UAMS writes, duplicate completion, durable intent, crash-safe OKF', () => {
  it('UAMS committed then reset: one POST, receipt unknown (not a misleading failed)', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ uams: 'reset' });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(posts(t.calls)).toHaveLength(1);
    expect(t.uamsCommitted).toHaveLength(1);
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
  });

  it('UAMS 5xx is ambiguous in tracked modes: one POST, unknown', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'shadow';
    const db = taskDb();
    const t = fakeTargets({ uams: 503 });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(posts(t.calls)).toHaveLength(1);
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
  });

  it('UAMS refused connection is proven non-delivery: retried, then failed', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ uams: 'refused' });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(posts(t.calls)).toHaveLength(3);
    expect(t.uamsCommitted).toHaveLength(0);
    expect(statusOf(db, 'task-1', 'uams')).toBe('failed');
  }, 10_000);

  it('repeated completion across two service instances sends each leg once (sequential and concurrent)', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ uams: 'timeout' });
    const a = new MemorySyncService(db);
    const b = new MemorySyncService(db);
    await a.onTaskCompleted('task-1');
    await b.onTaskCompleted('task-1');
    await Promise.all([a.onTaskCompleted('task-2'), b.onTaskCompleted('task-2')]);
    for (const task of ['task-1', 'task-2']) {
      expect(t.calls.filter((c) => c.url.endsWith('/memory/entry') && JSON.parse(c.body || '{}').topic === `task:${task}`)).toHaveLength(1);
      expect(upserts(t.calls, task)).toHaveLength(1);
    }
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown'); // the second completion did not overwrite the receipt
    expect(receipts(db).every((r) => r.attempts === 1)).toBe(true);
  });

  it('on: a failed intent insert prevents every external write; shadow still sends untracked', async () => {
    for (const mode of ['on', 'shadow'] as const) {
      process.env.MEMORY_DELIVERY_RECEIPTS = mode;
      const db = taskDb();
      db.exec(`CREATE TABLE memory_sync_receipts (task_id TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, target));
        CREATE TRIGGER no_receipts BEFORE INSERT ON memory_sync_receipts BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
      const t = fakeTargets();
      await new MemorySyncService(db).onTaskCompleted('task-1');
      const okf = fs.existsSync(path.join(tmpOkf, 'tasks', 'task-1.md'));
      if (mode === 'on') {
        expect(posts(t.calls)).toHaveLength(0);
        expect(upserts(t.calls, 'task-1')).toHaveLength(0);
        expect(okf).toBe(false);
      } else {
        expect(posts(t.calls)).toHaveLength(1);
        expect(upserts(t.calls, 'task-1')).toHaveLength(1);
        expect(okf).toBe(true);
      }
      fs.rmSync(path.join(tmpOkf, 'tasks'), { recursive: true, force: true });
    }
  });

  it('a truncated OKF file from an interrupted write is not read back as delivered; it is rewritten whole', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    fakeTargets();
    const file = path.join(tmpOkf, 'tasks', 'task-1.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\ntype: Compl'); // the process died mid-write
    db.exec(`CREATE TABLE IF NOT EXISTS memory_sync_receipts (task_id TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, target))`);
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-1', 'okf', 'unknown', 'in_flight', 1, '2026-01-01T00:00:00.000Z')`).run();

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 0, retried: 1, delivered: 1 });
    expect(statusOf(db, 'task-1', 'okf')).toBe('delivered');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^---\ntype: CompletedTask\n[\s\S]*## Description\n\ndo the thing\n\n$/);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['task-1.md']); // no temp file left behind
  });

  it('a complete OKF file matching the recorded intent hash is read back without a rewrite', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    fakeTargets();
    await new MemorySyncService(db).onTaskCompleted('task-1');
    const file = path.join(tmpOkf, 'tasks', 'task-1.md');
    const written = fs.readFileSync(file, 'utf8');
    // simulate: the write completed but the outcome was never recorded
    db.prepare(`UPDATE memory_sync_receipts SET status = 'unknown', detail = 'in_flight sha256:' || ?, updated_at = '2026-01-01T00:00:00.000Z' WHERE target = 'okf'`)
      .run(createHash('sha256').update(written).digest('hex'));
    const before = fs.statSync(file).mtimeMs;

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 1, retried: 0 });
    expect(statusOf(db, 'task-1', 'okf')).toBe('delivered');
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe('CODE-004 review round 2 (#1058): redirects and shadow OKF fallback', () => {
  it('UAMS POST → 307 → refused is not proven non-delivery: one POST to the origin, unknown (native fetch)', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    // a port nothing listens on: the redirect target refuses the connection
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    let originPosts = 0;
    const origin = http.createServer((req, res) => {
      if (req.method === 'POST') originPosts++;
      req.resume();
      res.writeHead(307, { Location: `http://127.0.0.1:${deadPort}/memory/entry` }).end();
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
    process.env.UAMS_URL = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    process.env.OLLAMA_URL = `http://127.0.0.1:${deadPort}`; // Qdrant leg fails fast (no embedding)
    const db = taskDb();
    try {
      await new MemorySyncService(db).onTaskCompleted('task-1');
    } finally {
      await new Promise<void>((r) => origin.close(() => r()));
    }
    expect(originPosts).toBe(1);
    expect(statusOf(db, 'task-1', 'uams')).toBe('unknown');
  }, 10_000);

  it('shadow: a failing receipt table never publishes an empty OKF file over an existing one', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'shadow';
    const db = taskDb();
    fakeTargets();
    (db as unknown as { exec: () => never }).exec = () => { throw new Error('disk I/O error'); };
    const file = path.join(tmpOkf, 'tasks', 'task-1.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\ntype: CompletedTask\nold but whole\n');
    await new MemorySyncService(db).onTaskCompleted('task-1');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/^---\ntype: CompletedTask\n[\s\S]*## Description\n\ndo the thing\n\n$/); // sent untracked, whole
  });
});

describe('CODE-004: pure receipt helpers (mutation hardening)', () => {
  it('receiptMode normalises whitespace and case; unset/empty/unknown default to off', () => {
    expect(receiptMode({ MEMORY_DELIVERY_RECEIPTS: '  Shadow  ' })).toBe('shadow');
    expect(receiptMode({ MEMORY_DELIVERY_RECEIPTS: 'ON' })).toBe('on');
    expect(receiptMode({})).toBe('off');
    expect(receiptMode({ MEMORY_DELIVERY_RECEIPTS: '  ' })).toBe('off');
    expect(receiptMode({ MEMORY_DELIVERY_RECEIPTS: 'bogus' })).toBe('off');
  });

  it('okfIntent formats the sha256 intent and okfIntentHash parses it back (null-safe)', () => {
    const sha = '0'.repeat(64);
    expect(okfIntent(sha)).toBe(`in_flight sha256:${sha}`);
    expect(okfIntentHash(okfIntent(sha))).toBe(sha);
    expect(okfIntentHash(null)).toBeNull();
    expect(okfIntentHash('in_flight')).toBeNull();
    expect(okfIntentHash('in_flight sha256:deadbeef')).toBeNull(); // too short — not 64 hex chars
  });

  it('recordOutcome truncates detail to 300 chars', () => {
    const db = taskDb();
    ensureReceiptsTable(db);
    expect(claimInitial(db, 'task-1', 'qdrant')).toBe(true);
    recordOutcome(db, 'task-1', 'qdrant', { status: 'failed', detail: 'x'.repeat(400) });
    const row = db.prepare('SELECT detail FROM memory_sync_receipts WHERE task_id = ? AND target = ?').get('task-1', 'qdrant') as { detail: string };
    expect(row.detail).toHaveLength(300);
    expect(row.detail).toBe('x'.repeat(300));
  });

  it('touchReceipt moves the row to the back of the queue and truncates detail', () => {
    const db = taskDb();
    ensureReceiptsTable(db);
    const now = Date.parse('2026-10-27T10:00:00.000Z');
    claimInitial(db, 'task-1', 'okf', 'in_flight', now);
    touchReceipt(db, 'task-1', 'okf', 'y'.repeat(400), now + 5_000);
    const row = db.prepare('SELECT detail, updated_at, status FROM memory_sync_receipts WHERE task_id = ? AND target = ?').get('task-1', 'okf') as { detail: string; updated_at: string; status: string };
    expect(row.detail).toHaveLength(300);
    expect(row.detail).toBe('y'.repeat(300));
    expect(row.updated_at).toBe(new Date(now + 5_000).toISOString());
    expect(row.status).toBe('unknown'); // touchReceipt leaves the status alone
  });

  it('reconcileCandidates excludes in-flight unknowns younger than the grace window and never returns non-idempotent targets', () => {
    const db = taskDb();
    ensureReceiptsTable(db);
    const now = Date.parse('2026-10-27T10:00:00.000Z');
    const bootIso = '2026-10-27T09:00:00.000Z'; // this process started at 09:00

    // a failed qdrant leg with attempts left — candidate
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-failed', 'qdrant', 'failed', 'oops', 2, '2026-10-27T09:30:00.000Z')`).run();
    // an unknown qdrant leg written by this process, younger than grace — NOT a candidate (may still be in flight)
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-young', 'qdrant', 'unknown', 'in_flight', 1, ?)`).run(new Date(now).toISOString());
    // an unknown okf leg older than grace, written by an earlier process — candidate
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-old', 'okf', 'unknown', 'in_flight', 1, '2026-10-27T08:00:00.000Z')`).run();
    // a failed uams leg (non-idempotent) — NOT a candidate (never retried)
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-uams', 'uams', 'failed', 'no', 1, '2026-10-27T09:30:00.000Z')`).run();

    const candidates = reconcileCandidates(db, now, bootIso);
    const ids = candidates.map((r) => r.task_id);
    expect(ids).toContain('task-failed');
    expect(ids).toContain('task-old');
    expect(ids).not.toContain('task-young');
    expect(ids).not.toContain('task-uams');
  });

  it('unreconcilableUnknown counts only unknown legs on non-idempotent targets', () => {
    const db = taskDb();
    ensureReceiptsTable(db);
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('t1', 'uams', 'unknown', 'in_flight', 1, '2026-10-27T09:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('t2', 'uams', 'unknown', 'in_flight', 1, '2026-10-27T09:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('t3', 'qdrant', 'unknown', 'in_flight', 1, '2026-10-27T09:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('t4', 'uams', 'delivered', 'ok', 1, '2026-10-27T09:00:00.000Z')`).run();
    expect(unreconcilableUnknown(db)).toBe(2);
  });

  it('memoryDeliveryEvidence reports by_target null when the receipts query fails mid-way', () => {
    const fakeDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('MIN(updated_at)')) return { get: () => { throw new Error('boom'); } };
        return { all: () => [{ target: 'qdrant', status: 'delivered', n: 1, exhausted: 0 }] };
      }),
    };
    const ev = memoryDeliveryEvidence(fakeDb as unknown as Database, { MEMORY_DELIVERY_RECEIPTS: 'on' });
    expect(ev.mode).toBe('on');
    expect(ev.by_target).toBeNull();
  });
});
