import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ProofRunService } from '../services/proof-run-service';

/**
 * CODE-002 follow-up (review of #1049): the proof-run maker context injection must not
 * collapse an incompatible swarm-memory collection into "no matching memory". The unavailable
 * sources + reasons are persisted on the maker lease; successful context from other sources is
 * still appended; retrieval stays non-fatal. Fake fetch only — no real Ollama/Qdrant/DjimitKB.
 */

const ENV_KEYS = ['DJIMITFLO_EMBED_MODEL', 'OLLAMA_EMBED_MODEL', 'QDRANT_URL', 'OLLAMA_URL', 'OKF_BASE', 'DJIMITKB_MCP_URL'];
let saved: Record<string, string | undefined>;
let db: Database.Database;
let tmp: string;

type Opts = { swarmDim: number; embedDim: number; kbHit: boolean; throwAll?: boolean };

function stubFetch(opts: Opts) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    if (opts.throwAll) throw new Error('network down');
    const method = init.method || 'GET';
    if (url.includes('/api/embed')) {
      const vec = Array.from({ length: opts.embedDim }, () => 0.5);
      return { ok: true, status: 200, json: async () => ({ embedding: vec, embeddings: [vec] }) };
    }
    if (url.includes('/search?q=')) {
      return { ok: true, status: 200, json: async () => ({ results: opts.kbHit ? [{ title: 'KB hit', type: 'report', score: 0.9, excerpt: 'kb context about the loop' }] : [] }) };
    }
    if (url.endsWith('/collections/djimitflo_swarm') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ result: { points_count: 10, config: { params: { vectors: { size: opts.swarmDim } } } } }) };
    }
    if (url.endsWith('/points/search')) return { ok: true, status: 200, json: async () => ({ result: [] }) };
    if (method === 'DELETE') throw new Error('DELETE must never be issued');
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

function makerLease(): { id: string; metadata: Record<string, unknown>; file: string } {
  const file = path.join(tmp, 'LOOP_WORK.md');
  fs.writeFileSync(file, '# Assignment\n\n## Finding\nfix the flaky loop test\n', 'utf8');
  const metadata = { assignment_file: file, existing: 'kept' };
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('lease-m', 'loop-1', 'maker', 'mock', 'prepared', ?)")
    .run(JSON.stringify(metadata));
  db.pragma('foreign_keys = ON');
  return { id: 'lease-m', metadata, file };
}

const leaseMeta = () => JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'lease-m'").get() as { metadata: string }).metadata);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-ctx-'));
  process.env.OKF_BASE = tmp;
  process.env.QDRANT_URL = 'http://qdrant.test:6333';
  process.env.OLLAMA_URL = 'http://ollama.test:11434';
  process.env.DJIMITKB_MCP_URL = 'http://kb.test:8008';
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('proof-run maker context: swarm-memory unavailable is persisted, not silent', () => {
  it('swarm dimension mismatch while another source succeeds: context appended AND swarm failure recorded', async () => {
    stubFetch({ swarmDim: 768, embedDim: 384, kbHit: true });
    const lease = makerLease();
    await new ProofRunService(db).injectMakerContext(lease);

    expect(fs.readFileSync(lease.file, 'utf8')).toContain('kb context about the loop');
    const meta = leaseMeta();
    expect(meta.existing).toBe('kept');
    expect(meta.context_retrieval).toMatchObject({ degraded: true, sources: ['djimitkb_search'] });
    expect(meta.context_retrieval.unavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'qdrant_swarm', reason: expect.stringMatching(/dimension mismatch/) }),
    ]));
  });

  it('swarm dimension mismatch and no other context: assignment untouched, failure still recorded', async () => {
    stubFetch({ swarmDim: 768, embedDim: 384, kbHit: false });
    const lease = makerLease();
    const before = fs.readFileSync(lease.file, 'utf8');
    await new ProofRunService(db).injectMakerContext(lease);

    expect(fs.readFileSync(lease.file, 'utf8')).toBe(before);
    expect(leaseMeta().context_retrieval).toMatchObject({ degraded: true, sources: [] });
    expect(leaseMeta().context_retrieval.unavailable[0]).toMatchObject({ source: 'qdrant_swarm' });
  });

  it('every backend down: non-fatal, swarm reason recorded', async () => {
    stubFetch({ swarmDim: 3, embedDim: 3, kbHit: false, throwAll: true });
    const lease = makerLease();
    await expect(new ProofRunService(db).injectMakerContext(lease)).resolves.toBeUndefined();
    expect(leaseMeta().context_retrieval.degraded).toBe(true);
    expect(leaseMeta().context_retrieval.unavailable[0]).toMatchObject({ source: 'qdrant_swarm', reason: 'network down' });
  });

  it('compatible swarm collection: not degraded', async () => {
    stubFetch({ swarmDim: 3, embedDim: 3, kbHit: true });
    const lease = makerLease();
    await new ProofRunService(db).injectMakerContext(lease);
    expect(leaseMeta().context_retrieval).toMatchObject({ degraded: false, unavailable: [] });
  });
});
