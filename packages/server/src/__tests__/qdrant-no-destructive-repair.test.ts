import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemorySyncService } from '../services/memory-sync-service';
import { ReasoningBankService } from '../services/reasoning-bank-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { ContextInjectionService } from '../services/context-injection-service';

/**
 * CODE-001 / CODE-002 (forensic audit 2026-10-26).
 * CODE-001: the per-task write paths must never DELETE a Qdrant collection — not for a missing
 * points_count, a stale 0, a concurrent writer or a model drift. A dimension mismatch is reported
 * as unavailable and the write is skipped; a missing collection (404) may still be created.
 * CODE-002: the djimitflo_swarm writers and the reader resolve one embedding model; the reader
 * reports a dimension mismatch as unavailable instead of querying with a foreign vector space.
 * Every test runs against a fake fetch — no real Ollama/Qdrant.
 */

type Call = { url: string; method: string; body?: any };

interface FakeQdrant {
  calls: Call[];
  /** Synthetic points in the collection; a DELETE wipes them. */
  rows: number;
  /** Models seen by the fake Ollama; vector[0] of every embedding is (index in this list + 1). */
  models: string[];
  fetch: ReturnType<typeof vi.fn>;
}

/**
 * Fake Ollama + Qdrant. `info` is the GET /collections/<name> body (or a status code for 404),
 * `dim` the embedding length the fake model returns, `onInfo` runs after the GET is answered
 * (a concurrent writer inserting a point between the count read and any later action).
 */
function fakeQdrant(opts: { info: Record<string, unknown> | 404; dim: number; onInfo?: (q: FakeQdrant) => void }): FakeQdrant {
  const q: FakeQdrant = { calls: [], rows: 0, models: [], fetch: vi.fn() };
  q.fetch.mockImplementation(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    q.calls.push({ url, method, body });
    if (url.includes('/api/embed')) {
      if (!q.models.includes(body?.model)) q.models.push(body?.model);
      const vec = Array.from({ length: opts.dim }, (_, i) => (i === 0 ? q.models.indexOf(body?.model) + 1 : 0.5));
      return { ok: true, status: 200, json: async () => ({ embedding: vec, embeddings: [vec] }) };
    }
    if (url.includes('/memory/entry')) return { ok: true, status: 201, json: async () => ({}) }; // UAMS leg
    if (!url.includes('/collections/')) return { ok: false, status: 503, json: async () => ({}) };
    if (method === 'DELETE') { q.rows = 0; return { ok: true, status: 200, json: async () => ({}) }; }
    if (url.endsWith('/points/search')) return { ok: true, status: 200, json: async () => ({ result: [] }) };
    if (method === 'PUT' && url.endsWith('/points')) { q.rows++; return { ok: true, status: 200, json: async () => ({}) }; }
    if (method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
    // GET collection info
    if (opts.info === 404) return { ok: false, status: 404, json: async () => ({}) };
    const info = opts.info;
    const res = { ok: true, status: 200, json: async () => ({ result: info }) };
    opts.onInfo?.(q);
    return res;
  });
  vi.stubGlobal('fetch', q.fetch);
  return q;
}

const deletes = (q: FakeQdrant) => q.calls.filter((c) => c.method === 'DELETE');
const pointWrites = (q: FakeQdrant, collection: string) =>
  q.calls.filter((c) => c.method === 'PUT' && c.url.endsWith(`/collections/${collection}/points`));
const creates = (q: FakeQdrant, collection: string) =>
  q.calls.filter((c) => c.method === 'PUT' && c.url.endsWith(`/collections/${collection}`));
const embedModels = (q: FakeQdrant) => q.calls.filter((c) => c.url.includes('/api/embed')).map((c) => c.body?.model);

const info = (size: number, count?: number) => ({
  config: { params: { vectors: { size, distance: 'Cosine' } } },
  ...(count === undefined ? {} : { points_count: count }),
});

function fakeTaskDb() {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('FROM tasks')) return { id: 'task-1', title: 'T', description: 'do the thing', status: 'completed', created_by: 'macbook', agent_id: 'a1', metadata: '{}' };
        if (sql.includes('FROM agents')) return { agent_type: 'maker' };
        return undefined;
      },
    }),
  } as any;
}

const ENV_KEYS = ['DJIMITFLO_EMBED_MODEL', 'OLLAMA_EMBED_MODEL', 'QDRANT_URL', 'QDRANT_WRITE_URL', 'OLLAMA_URL', 'OKF_BASE', 'PROOF_RUN_MEMORY_FLYWHEEL', 'DJIMITKB_MCP_URL'];
let saved: Record<string, string | undefined>;
let tmpOkf: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpOkf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-code001-'));
  process.env.OKF_BASE = tmpOkf;
  process.env.QDRANT_URL = 'http://qdrant.test:6333';
  process.env.OLLAMA_URL = 'http://ollama.test:11434';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmpOkf, { recursive: true, force: true });
});

const warned = () => (console.warn as any).mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('CODE-001: MemorySyncService never deletes the swarm collection', () => {
  it('missing points_count + dimension mismatch: no DELETE, write skipped, reported unavailable', async () => {
    const q = fakeQdrant({ info: info(768), dim: 3 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(warned()).toMatch(/unavailable.*dimension mismatch/);
  });

  it('stale points_count=0 + dimension mismatch: no DELETE, no recreate', async () => {
    const q = fakeQdrant({ info: info(768, 0), dim: 3 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(0);
  });

  it('concurrent writer between the count read and the repair: its point survives', async () => {
    const q = fakeQdrant({ info: info(768, 0), dim: 3, onInfo: (fq) => { fq.rows = 1; } });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(q.rows).toBe(1);
  });

  it('model drift (operator switches DJIMITFLO_EMBED_MODEL to another dimension): no DELETE', async () => {
    process.env.DJIMITFLO_EMBED_MODEL = 'nomic-embed-text:latest';
    const q = fakeQdrant({ info: info(384, 0), dim: 768 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(warned()).toMatch(/unavailable/);
  });

  it('404: creates the collection at the embedding dimension, then upserts', async () => {
    const q = fakeQdrant({ info: 404, dim: 3 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_swarm')).toHaveLength(1);
    expect(creates(q, 'djimitflo_swarm')[0].body).toEqual({ vectors: { size: 3, distance: 'Cosine' } });
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(1);
  });

  it('matching dimension: upserts without create or delete', async () => {
    const q = fakeQdrant({ info: info(3, 5), dim: 3 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(1);
  });
});

describe('CODE-001: ReasoningBankService never deletes the reasoning collection', () => {
  it.each([
    ['missing count', info(768)],
    ['stale count 0', info(768, 0)],
  ])('%s + dimension mismatch: no DELETE, write skipped', async (_label, body) => {
    const q = fakeQdrant({ info: body, dim: 3 });
    await new ReasoningBankService(fakeTaskDb()).recordReasoning('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_reasoning')).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_reasoning')).toHaveLength(0);
    expect(warned()).toMatch(/unavailable.*dimension mismatch/);
  });

  it('concurrent writer: its point survives', async () => {
    const q = fakeQdrant({ info: info(768, 0), dim: 3, onInfo: (fq) => { fq.rows = 1; } });
    await new ReasoningBankService(fakeTaskDb()).recordReasoning('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(q.rows).toBe(1);
  });

  it('404: creates, then upserts', async () => {
    const q = fakeQdrant({ info: 404, dim: 3 });
    await new ReasoningBankService(fakeTaskDb()).recordReasoning('task-1');
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_reasoning')).toHaveLength(1);
    expect(pointWrites(q, 'djimitflo_reasoning')).toHaveLength(1);
  });
});

describe('CODE-001/002: memory flywheel (second djimitflo_swarm writer)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });
  afterEach(() => db.close());

  function promoted(svc: MemoryCandidateService) {
    const c = svc.create({ title: 'lesson', content: 'a promoted lesson', memory_type: 'operational_memory' });
    svc.promote(c.id, { approved_by: 'test' });
    return c.id;
  }

  it('stale count 0 + dimension mismatch: no DELETE, returns unavailable', async () => {
    const svc = new MemoryCandidateService(db);
    const id = promoted(svc);
    const q = fakeQdrant({ info: info(384, 0), dim: 768 });
    const result = await svc.upsertToSwarmMemory(id);
    expect(deletes(q)).toHaveLength(0);
    expect(pointWrites(q, 'djimitflo_swarm')).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/dimension mismatch/);
  });

  it('404: creates, then upserts', async () => {
    const svc = new MemoryCandidateService(db);
    const id = promoted(svc);
    const q = fakeQdrant({ info: 404, dim: 3 });
    const result = await svc.upsertToSwarmMemory(id);
    expect(result).toEqual({ ok: true });
    expect(deletes(q)).toHaveLength(0);
    expect(creates(q, 'djimitflo_swarm')).toHaveLength(1);
  });
});

describe('CODE-002: one embedding contract for djimitflo_swarm writers and reader', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });
  afterEach(() => db.close());

  async function modelsUsed(): Promise<{ sync: string[]; flywheel: string[]; reader: string[] }> {
    let q = fakeQdrant({ info: info(3, 1), dim: 3 });
    await new MemorySyncService(fakeTaskDb()).onTaskCompleted('task-1');
    const sync = embedModels(q);

    const svc = new MemoryCandidateService(db);
    const c = svc.create({ title: `lesson ${Math.random()}`, content: 'a promoted lesson', memory_type: 'operational_memory' });
    svc.promote(c.id, { approved_by: 'test' });
    q = fakeQdrant({ info: info(3, 1), dim: 3 });
    await svc.upsertToSwarmMemory(c.id);
    const flywheel = embedModels(q);

    q = fakeQdrant({ info: info(3, 1), dim: 3 });
    await new ContextInjectionService().injectContextSnapshot('find related work');
    // The reader embeds concurrently for several sources; the vector it searches djimitflo_swarm
    // with identifies the model that produced it.
    const reader = q.calls
      .filter((c) => c.url.endsWith('/collections/djimitflo_swarm/points/search'))
      .map((c) => q.models[c.body.vector[0] - 1]);
    return { sync, flywheel, reader };
  }

  it.each([
    ['default env', undefined],
    ['DJIMITFLO_EMBED_MODEL override', 'custom-embed:v2'],
  ])('%s: writer, flywheel and reader resolve the same model', async (_label, override) => {
    if (override) process.env.DJIMITFLO_EMBED_MODEL = override;
    const { sync, flywheel, reader } = await modelsUsed();
    const expected = override ?? sync[0];
    expect(sync.length).toBeGreaterThan(0);
    expect(new Set(sync)).toEqual(new Set([expected]));
    expect(new Set(flywheel)).toEqual(new Set([expected]));
    expect(reader.length).toBeGreaterThan(0);
    expect(new Set(reader)).toEqual(new Set([expected]));
  });

  it('reader: collection at another dimension is reported unavailable and never searched', async () => {
    const q = fakeQdrant({ info: info(768, 10), dim: 384 });
    const snap = await new ContextInjectionService().injectContextSnapshot('find related work');
    expect(q.calls.some((c) => c.url.endsWith('/collections/djimitflo_swarm/points/search'))).toBe(false);
    expect(snap.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'qdrant_swarm', reason: expect.stringMatching(/dimension mismatch/) }),
    ]));
    expect(deletes(q)).toHaveLength(0);
  });

  it('reader: search only matches points written with the contract model', async () => {
    process.env.DJIMITFLO_EMBED_MODEL = 'custom-embed:v2';
    const q = fakeQdrant({ info: info(3, 10), dim: 3 });
    const snap = await new ContextInjectionService().injectContextSnapshot('find related work', true, 'semantic');
    const search = q.calls.find((c) => c.url.endsWith('/collections/djimitflo_swarm/points/search'));
    expect(search).toBeDefined();
    expect(search!.body.filter.must).toEqual(expect.arrayContaining([
      { key: 'embedding_model', match: { value: 'custom-embed:v2' } },
      { key: 'store', match: { value: 'semantic' } },
    ]));
    expect(snap.unavailable ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: 'qdrant_swarm' })]));
  });
});
