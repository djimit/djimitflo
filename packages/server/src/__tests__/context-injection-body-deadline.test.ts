import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import type { ContextInjectionService as Service } from '../services/context-injection-service';

/**
 * STATE-03: the per-source fetch deadline must cover the response body, not just the headers.
 * A real local server plays Ollama + Qdrant + djimitkb-mcp with valid answers, except for ONE
 * endpoint per case: that one answers 200 + headers + a partial JSON body and then never ends the
 * response. Before the fix the abort timer was cleared once fetch() resolved (headers), so
 * `await res.json()` waited forever and the call hung. The stalled responses are never released by
 * the test; only the service's own deadline can end the call. Each case asserts the stalled
 * endpoint was actually reached, so it pins the deadline of that specific call site. The same
 * headers-only deadline was copied into ExperienceRetrievalService (part of injectContext when a db
 * is passed, 2s) and MemoryCandidateService.upsertToSwarmMemory (proof flywheel, 5s).
 */

const EMBED = '/api/embeddings';
const SWARM_INFO = '/collections/djimitflo_swarm';
const SWARM_SEARCH = '/collections/djimitflo_swarm/points/search';
const OKF_SEARCH = '/collections/djimit_okf/points/search';
const EXPERIENCE_SEARCH = '/collections/djimitflo_experience/points/search';
const KB_SEARCH = '/search';

let stall: string | null = null; // the one path that stalls its body
let malformed = false; // every path answers 200 with broken JSON
const reached = new Set<string>();

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  reached.add(path);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (path === stall) {
    res.write('{"result":[{"score":0.9,"payload":{"title":"part'); // headers + part of a body, then nothing
    return;
  }
  if (malformed) {
    res.end('{"results":[ not json');
    return;
  }
  let body: unknown = { result: [] };
  if (path === EMBED) body = { embedding: [0.1, 0.2, 0.3] };
  else if (path === SWARM_INFO) body = { result: { config: { params: { vectors: { size: 3 } } } } };
  else if (path === KB_SEARCH) body = { results: [{ title: 'KB hit', type: 'entity', score: 0.9, excerpt: 'kb excerpt' }] };
  res.end(JSON.stringify(body));
});

const ENV_KEYS = ['DJIMITKB_MCP_URL', 'QDRANT_URL', 'OLLAMA_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
let ContextInjectionService: typeof Service;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; process.env[k] = base; }
  vi.resetModules(); // the service reads its source URLs at import time
  ({ ContextInjectionService } = await import('../services/context-injection-service'));
});

beforeEach(() => {
  stall = null;
  malformed = false;
  reached.clear();
});

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const memDb = () => {
  const db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  return db;
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; elapsed: number }> => {
  const started = Date.now();
  const value = await fn();
  return { value, elapsed: Date.now() - started };
};

describe('STATE-03 context injection deadline covers the response body', () => {
  it('success control: every source answers, the djimitkb hit is injected', async () => {
    const snapshot = await new ContextInjectionService(undefined, 200).injectContextSnapshot('kb task');
    expect(reached).toEqual(new Set([EMBED, SWARM_INFO, SWARM_SEARCH, OKF_SEARCH, KB_SEARCH]));
    expect(snapshot.sources).toEqual(['djimitkb_search']);
    expect(snapshot.text).toContain('KB hit');
    expect(snapshot.unavailable).toBeUndefined();
  }, 5_000);

  it('malformed JSON control: every source returns nothing and injection does not throw', async () => {
    malformed = true;
    const snapshot = await new ContextInjectionService(undefined, 200).injectContextSnapshot('malformed task');
    expect(snapshot.text).toBe('');
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.unavailable?.map((u) => u.source)).toEqual(['qdrant_swarm']);
  }, 5_000);

  it('with a db, a stalled Ollama embedding body (swarm, OKF, experience) degrades each source, injection continues', async () => {
    stall = EMBED;
    const db = memDb();
    try {
      const { value: snapshot, elapsed } = await timed(() => new ContextInjectionService(db, 200).injectContextSnapshot('stalled embed'));
      expect(reached.has(EMBED)).toBe(true);
      expect(elapsed).toBeLessThan(4_000); // experience retrieval keeps its fixed 2s deadline
      expect(snapshot.unavailable?.map((u) => u.source)).toEqual(['qdrant_swarm']);
      expect(snapshot.sources).toEqual(['djimitkb_search']);
    } finally {
      db.close();
    }
  }, 8_000);

  it('a stalled Qdrant swarm-memory search body: swarm memory reports unavailable, injection continues', async () => {
    stall = SWARM_SEARCH;
    const { value: snapshot, elapsed } = await timed(() => new ContextInjectionService(undefined, 200).injectContextSnapshot('stalled swarm search'));
    expect(reached.has(SWARM_SEARCH)).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(snapshot.unavailable?.map((u) => u.source)).toEqual(['qdrant_swarm']);
    expect(snapshot.sources).toEqual(['djimitkb_search']);
  }, 5_000);

  it('a stalled Qdrant OKF search body: OKF returns nothing, injection continues', async () => {
    stall = OKF_SEARCH;
    const { value: snapshot, elapsed } = await timed(() => new ContextInjectionService(undefined, 200).injectContextSnapshot('stalled okf search'));
    expect(reached.has(OKF_SEARCH)).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(snapshot.sources).toEqual(['djimitkb_search']);
    expect(snapshot.unavailable).toBeUndefined();
  }, 5_000);

  it('a stalled djimitkb search body: djimitkb returns nothing, injection continues', async () => {
    stall = KB_SEARCH;
    const { value: snapshot, elapsed } = await timed(() => new ContextInjectionService(undefined, 200).injectContextSnapshot('stalled kb search'));
    expect(reached.has(KB_SEARCH)).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.text).toBe('');
  }, 5_000);

  it('with a db, a stalled Qdrant experience query body falls back to local runs (fixed 2s deadline)', async () => {
    stall = EXPERIENCE_SEARCH;
    const db = memDb();
    try {
      const { value: snapshot, elapsed } = await timed(() => new ContextInjectionService(db, 200).injectContextSnapshot('stalled experience query'));
      expect(reached.has(EXPERIENCE_SEARCH)).toBe(true);
      expect(elapsed).toBeLessThan(4_000);
      expect(snapshot.sources).toEqual(['djimitkb_search']);
    } finally {
      db.close();
    }
  }, 8_000);

  it('memory flywheel write-back skips a stalled Ollama body instead of hanging the proof (fixed 5s deadline)', async () => {
    stall = EMBED;
    const db = memDb();
    const flywheelEnv = process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    delete process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    try {
      const svc = new MemoryCandidateService(db);
      const c = svc.create({ title: 'stall', content: 'stalled ollama body', memory_type: 'operational_memory' });
      svc.promote(c.id, { approved_by: 'test' });
      const { value: result, elapsed } = await timed(() => svc.upsertToSwarmMemory(c.id));
      expect(reached.has(EMBED)).toBe(true);
      expect(elapsed).toBeLessThan(8_000);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^exception:/);
    } finally {
      if (flywheelEnv !== undefined) process.env.PROOF_RUN_MEMORY_FLYWHEEL = flywheelEnv;
      db.close();
    }
  }, 12_000);
});
