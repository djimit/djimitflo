import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { MemorySyncService } from '../services/memory-sync-service';
import { ensureReceiptsTable, memoryDeliveryEvidence, qdrantIntentHash } from '../services/memory-delivery-receipts';
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

/** A fake UAMS + Ollama + Qdrant. `qdrantPoints` maps stored point ids to their payloads (read-back reads it). */
type UamsBehaviour = 'ok' | 'timeout' | 401 | 503 | 'reset' | 'refused';
const transportError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

/** upsert 'timeout': no response, nothing stored; 'timeout_landed': stored, then no response (the ambiguous case). */
type UpsertBehaviour = 'ok' | 503 | 'timeout' | 'timeout_landed';
function fakeTargets(opts: { uams?: UamsBehaviour; upsert?: UpsertBehaviour } = {}) {
  const calls: Call[] = [];
  const qdrantPoints = new Map<string, Record<string, unknown>>();
  /** UAMS entries the server applied (a reset/5xx after commit still counts) */
  const uamsCommitted: string[] = [];
  const state: { uams: UamsBehaviour; upsert: UpsertBehaviour } = { uams: opts.uams ?? 'ok', upsert: opts.upsert ?? 'ok' };
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
      if (typeof state.upsert === 'number') return new Response('{}', { status: state.upsert });
      if (state.upsert === 'timeout') throw timeoutError();
      for (const p of JSON.parse(String(init?.body)).points) qdrantPoints.set(String(p.id), p.payload);
      if (state.upsert === 'timeout_landed') throw timeoutError();
      return new Response('{}');
    }
    const point = url.match(/\/collections\/djimitflo_swarm\/points\/([^/?]+)$/);
    if (point) {
      return qdrantPoints.has(point[1])
        ? new Response(JSON.stringify({ result: { id: point[1], payload: qdrantPoints.get(point[1]) } }))
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

/** The payload a tracked upsert of a taskDb() task writes (intent hash over the current content and embed model). */
const EMBED_MODEL = 'snowflake-arctic-embed:s';
const landedPayload = (task: string, over: { content?: string; model?: string } = {}) => ({
  task_id: task, machine_id: 'macbook', agent_type: 'maker', content_excerpt: over.content ?? 'do the thing', embedding_model: over.model ?? EMBED_MODEL,
  embedding_dim: 3, intent_sha256: qdrantIntentHash(task, over.content ?? 'do the thing', 'macbook', 'maker', over.model ?? EMBED_MODEL),
});
const LEGACY_RECEIPTS_DDL = `CREATE TABLE IF NOT EXISTS memory_sync_receipts (task_id TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, target))`;
/**
 * An unknown Qdrant receipt left by an ambiguous send. Default: it recorded the intent of the attempt (content/model as given,
 * defaulting to the task's current ones). 'legacy': a receipt from before intents were recorded (pre-STATE-02 schema).
 */
const unknownQdrantReceipt = (db: Database.Database, task: string, intent: { content?: string; model?: string } | 'legacy' = {}) => {
  db.exec(LEGACY_RECEIPTS_DDL);
  if (intent === 'legacy') {
    db.prepare(`INSERT INTO memory_sync_receipts VALUES (?, 'qdrant', 'unknown', 'timeout 10000ms', 1, '2026-01-01T00:00:00.000Z')`).run(task);
    return;
  }
  ensureReceiptsTable(db);
  db.prepare(`INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at, intent_sha256, embed_model)
    VALUES (?, 'qdrant', 'unknown', 'timeout 10000ms', 1, '2026-01-01T00:00:00.000Z', ?, ?)`).run(task, landedPayload(task, intent).intent_sha256, intent.model ?? EMBED_MODEL);
};

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
  for (const k of ['OKF_BASE', 'UAMS_URL', 'QDRANT_URL', 'OLLAMA_URL', 'MEMORY_DELIVERY_RECEIPTS', 'DJIMITFLO_EMBED_MODEL']) delete process.env[k];
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
    db.prepare(`INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at, intent_sha256, embed_model)
      VALUES ('task-2', 'qdrant', 'unknown', 'in_flight', 1, '2026-01-01T00:00:00.000Z', ?, ?)`).run(landedPayload('task-2').intent_sha256, EMBED_MODEL);
    t.qdrantPoints.set(pointIdForTask('task-2'), landedPayload('task-2'));

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

describe('STATE-02: a Qdrant read-back settles only the exact intended point', () => {
  const qdrantReceipt = (db: Database.Database) =>
    db.prepare(`SELECT status, detail, attempts, intent_sha256, embed_model FROM memory_sync_receipts WHERE task_id = 'task-1' AND target = 'qdrant'`)
      .get() as { status: string; detail: string; attempts: number; intent_sha256: string | null; embed_model: string | null };
  const setContent = (db: Database.Database, content: string) => db.prepare(`UPDATE tasks SET description = ? WHERE id = 'task-1'`).run(content);
  const hashOf = (content: string, model = EMBED_MODEL) => qdrantIntentHash('task-1', content, 'macbook', 'maker', model);
  const pointOf = (t: ReturnType<typeof fakeTargets>) => t.qdrantPoints.get(pointIdForTask('task-1'));

  it('the receipt records the intent hash and embed model before the send; the point payload carries the same hash', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    const fake = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    let atSend: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && url.endsWith('/points')) atSend = qdrantReceipt(db);
      return fake(url, init);
    }));
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(atSend).toMatchObject({ status: 'unknown', intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
    expect(pointOf(t)).toMatchObject({ intent_sha256: hashOf('do the thing'), embedding_model: EMBED_MODEL });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
  });

  it('a timed-out upsert keeps the recorded intent in its own columns (detail holds the timeout)', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    fakeTargets({ upsert: 'timeout' });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(qdrantReceipt(db)).toMatchObject({ status: 'unknown', detail: 'timeout 10000ms', intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
  });

  it('a landed ambiguous send is certified against the recorded intent, not overwritten after a later content and model change', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ upsert: 'timeout_landed' });
    setContent(db, 'version B');
    await new MemorySyncService(db).onTaskCompleted('task-1');
    expect(qdrantReceipt(db)).toMatchObject({ status: 'unknown', intent_sha256: hashOf('version B') });
    db.prepare(`UPDATE memory_sync_receipts SET updated_at = '2026-01-01T00:00:00.000Z'`).run(); // settled, eligible for this pass
    setContent(db, 'version C');
    process.env.DJIMITFLO_EMBED_MODEL = 'nomic-embed-text';
    t.state.upsert = 'ok';
    t.calls.length = 0;

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 1, read_back_stale: 0, retried: 0 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', detail: 'read_back', intent_sha256: hashOf('version B'), embed_model: EMBED_MODEL });
    expect(upserts(t.calls, 'task-1')).toHaveLength(0);
    expect(pointOf(t)).toMatchObject({ intent_sha256: hashOf('version B'), embedding_model: EMBED_MODEL });
  });

  it('A→B→A: an unlanded attempt B is not certified by an older point A that matches the current config; resent once as A', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ upsert: 'timeout' });
    t.qdrantPoints.set(pointIdForTask('task-1'), landedPayload('task-1')); // A landed earlier
    setContent(db, 'version B');
    await new MemorySyncService(db).onTaskCompleted('task-1'); // attempt B: timed out, never landed
    expect(qdrantReceipt(db)).toMatchObject({ status: 'unknown', intent_sha256: hashOf('version B') });
    db.prepare(`UPDATE memory_sync_receipts SET updated_at = '2026-01-01T00:00:00.000Z'`).run();
    setContent(db, 'do the thing'); // back to A
    t.state.upsert = 'ok';
    t.calls.length = 0;

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 0, read_back_stale: 1, retried: 1, delivered: 1 });
    expect(upserts(t.calls, 'task-1')).toHaveLength(1);
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', attempts: 2, intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
  });

  it('content changed after an unlanded ambiguous send: absent, resent with the current content, which the receipt records', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets({ upsert: 'timeout' });
    await new MemorySyncService(db).onTaskCompleted('task-1');
    db.prepare(`UPDATE memory_sync_receipts SET updated_at = '2026-01-01T00:00:00.000Z'`).run();
    setContent(db, 'version B');
    t.state.upsert = 'ok';

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_stale: 0, retried: 1, delivered: 1 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', intent_sha256: hashOf('version B') });
    expect(pointOf(t)).toMatchObject({ intent_sha256: hashOf('version B') });
  });

  for (const [name, stale] of [
    ['an older payload without an intent hash', () => ({ task_id: 'task-1', content_excerpt: 'old', embedding_model: EMBED_MODEL, embedding_dim: 3 })],
    ['an older content version', () => landedPayload('task-1', { content: 'an earlier description' })],
    ['an older embed model', () => landedPayload('task-1', { model: 'nomic-embed-text' })],
    ['the intended hash but another embed model label', () => ({ ...landedPayload('task-1'), embedding_model: 'nomic-embed-text' })],
  ] as const) {
    it(`same task id with ${name}: stale, not read back as delivered; overwritten by one resend carrying the intent hash`, async () => {
      process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
      const db = taskDb();
      const t = fakeTargets();
      unknownQdrantReceipt(db, 'task-1');
      t.qdrantPoints.set(pointIdForTask('task-1'), stale());

      const svc = new MemorySyncService(db);
      const report = await svc.reconcile();
      await svc.reconcile(Date.now() + 3_600_000); // a later tick: settled, nothing resent

      expect(report).toMatchObject({ read_back_delivered: 0, read_back_inconclusive: 0, read_back_stale: 1, retried: 1, delivered: 1 });
      expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', attempts: 2, intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
      expect(upserts(t.calls, 'task-1')).toHaveLength(1);
      expect(pointOf(t)).toMatchObject({ embedding_model: EMBED_MODEL, intent_sha256: hashOf('do the thing') });
    });
  }

  it('a legacy receipt without a recorded intent is never certified: stale, one resend that records the intent', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    unknownQdrantReceipt(db, 'task-1', 'legacy');
    t.qdrantPoints.set(pointIdForTask('task-1'), landedPayload('task-1')); // even a point matching the current config

    const svc = new MemorySyncService(db);
    const report = await svc.reconcile();
    await svc.reconcile(Date.now() + 3_600_000);

    expect(report).toMatchObject({ read_back_delivered: 0, read_back_stale: 1, retried: 1, delivered: 1 });
    expect(upserts(t.calls, 'task-1')).toHaveLength(1);
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', attempts: 2, intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
  });

  it('a stale point on a receipt out of attempts is failed with a distinct detail (read_back: stale), not resent', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    unknownQdrantReceipt(db, 'task-1');
    db.prepare(`UPDATE memory_sync_receipts SET attempts = 5 WHERE task_id = 'task-1'`).run();
    t.qdrantPoints.set(pointIdForTask('task-1'), landedPayload('task-1', { content: 'an earlier description' }));

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 0, read_back_stale: 1, retried: 0 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'failed', detail: 'read_back: stale', attempts: 5 });
    expect(upserts(t.calls, 'task-1')).toHaveLength(0);
  });

  it('task row gone: the recorded intent still certifies its own landed point; a legacy receipt is not certified (no send)', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    unknownQdrantReceipt(db, 'task-1');
    unknownQdrantReceipt(db, 'task-2', 'legacy');
    t.qdrantPoints.set(pointIdForTask('task-1'), landedPayload('task-1'));
    t.qdrantPoints.set(pointIdForTask('task-2'), landedPayload('task-2'));
    db.prepare(`DELETE FROM tasks`).run();

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 1, read_back_stale: 1 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', detail: 'read_back' });
    expect(statusOf(db, 'task-2', 'qdrant')).toBe('failed');
    expect(t.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('the exact intended point is read back as delivered without a resend', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    unknownQdrantReceipt(db, 'task-1');
    t.qdrantPoints.set(pointIdForTask('task-1'), landedPayload('task-1'));

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 1, retried: 0 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', detail: 'read_back' });
    expect(upserts(t.calls, 'task-1')).toHaveLength(0);
  });

  it('absent point (unchanged): proven not delivered, resent once, delivered', async () => {
    process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
    const db = taskDb();
    const t = fakeTargets();
    unknownQdrantReceipt(db, 'task-1');

    const report = await new MemorySyncService(db).reconcile();

    expect(report).toMatchObject({ read_back_delivered: 0, retried: 1, delivered: 1 });
    expect(qdrantReceipt(db)).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(upserts(t.calls, 'task-1')).toHaveLength(1);
  });

  for (const [name, respond] of [
    ['HTTP 500', async () => new Response('{}', { status: 500 })],
    ['a transport error', async () => { throw transportError('ECONNRESET'); }],
  ] as const) {
    it(`read-back ${name} (unchanged): inconclusive, left unknown with its recorded intent, not resent`, async () => {
      process.env.MEMORY_DELIVERY_RECEIPTS = 'on';
      const db = taskDb();
      const t = fakeTargets();
      unknownQdrantReceipt(db, 'task-1');
      const fake = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
        (/\/points\/[^/?]+$/.test(url) && !init?.method ? respond() : fake(url, init))));

      const report = await new MemorySyncService(db).reconcile();

      expect(report).toMatchObject({ read_back_delivered: 0, read_back_inconclusive: 1, retried: 0 });
      expect(qdrantReceipt(db)).toMatchObject({ status: 'unknown', detail: 'read_back_inconclusive', attempts: 1, intent_sha256: hashOf('do the thing'), embed_model: EMBED_MODEL });
      expect(upserts(t.calls, 'task-1')).toHaveLength(0);
    });
  }

  it('the intent columns are an additive migration: a pre-STATE-02 receipts table keeps its rows, gains nullable columns, idempotently', () => {
    const db = taskDb();
    db.exec(LEGACY_RECEIPTS_DDL);
    db.prepare(`INSERT INTO memory_sync_receipts VALUES ('task-1', 'okf', 'delivered', 'written', 1, '2026-01-01T00:00:00.000Z')`).run();
    ensureReceiptsTable(db);
    ensureReceiptsTable(db);
    const cols = (db.prepare('PRAGMA table_info(memory_sync_receipts)').all() as Array<{ name: string; notnull: number }>);
    expect(cols.filter((c) => c.name === 'intent_sha256' || c.name === 'embed_model')).toEqual([
      expect.objectContaining({ name: 'intent_sha256', notnull: 0 }), expect.objectContaining({ name: 'embed_model', notnull: 0 }),
    ]);
    expect(db.prepare('SELECT task_id, target, status, intent_sha256, embed_model FROM memory_sync_receipts').all())
      .toEqual([{ task_id: 'task-1', target: 'okf', status: 'delivered', intent_sha256: null, embed_model: null }]);
  });
});
