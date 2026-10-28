import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import type { ContextInjectionService as Service } from '../services/context-injection-service';

/**
 * STATE-03: the per-source fetch deadline must cover the response body, not just the headers.
 * A real local server answers 200 + headers + a partial JSON body and then never ends the
 * response. Before the fix the abort timer was cleared once fetch() resolved (headers), so
 * `await res.json()` waited forever and injectContextSnapshot hung. The stalled responses are
 * never released by the test; only the service's own deadline can end the call. The same
 * headers-only deadline was copied into ExperienceRetrievalService (part of injectContext when a db
 * is passed, 2s) and MemoryCandidateService.upsertToSwarmMemory (proof flywheel, 5s).
 */

type Mode = 'stall' | 'ok' | 'malformed';
let mode: Mode = 'ok';

const server = http.createServer((req, res) => {
  const ok = mode !== 'ok' || req.url?.startsWith('/search');
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }); // success control: only djimitkb answers
  if (mode === 'stall') {
    res.write('{"results":[{"title":"part'); // headers + part of a body, then nothing
    return;
  }
  if (mode === 'malformed') {
    res.end('{"results":[ not json');
    return;
  }
  res.end(ok ? JSON.stringify({ results: [{ title: 'KB hit', type: 'entity', score: 0.9, excerpt: 'kb excerpt' }] }) : '{}');
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

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('STATE-03 context injection deadline covers the response body', () => {
  it('a source that sends headers and stalls the body is skipped within the deadline', async () => {
    mode = 'stall';
    const started = Date.now();
    const snapshot = await new ContextInjectionService(undefined, 200).injectContextSnapshot('stalled body task');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(snapshot.text).toBe('');
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.unavailable?.map((u) => u.source)).toEqual(['qdrant_swarm']);
  }, 5_000);

  it('success control: a full JSON body is injected', async () => {
    mode = 'ok';
    const snapshot = await new ContextInjectionService(undefined, 200).injectContextSnapshot('kb task');
    expect(snapshot.sources).toEqual(['djimitkb_search']);
    expect(snapshot.text).toContain('KB hit');
    expect(snapshot.unavailable?.[0]?.reason).toContain('404');
  }, 5_000);

  it('malformed JSON control: every source returns nothing and injection does not throw', async () => {
    mode = 'malformed';
    const snapshot = await new ContextInjectionService(undefined, 200).injectContextSnapshot('malformed task');
    expect(snapshot.text).toBe('');
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.unavailable?.map((u) => u.source)).toEqual(['qdrant_swarm']);
  }, 5_000);

  it('with a db, the experience-retrieval source is bounded too (fixed 2s deadline)', async () => {
    mode = 'stall';
    const db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    try {
      const started = Date.now();
      const snapshot = await new ContextInjectionService(db, 200).injectContextSnapshot('stalled body task');
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(snapshot.text).toBe('');
    } finally {
      db.close();
    }
  }, 8_000);

  it('memory flywheel write-back skips a stalled Ollama body instead of hanging the proof (fixed 5s deadline)', async () => {
    mode = 'stall';
    const db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    const flywheelEnv = process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    delete process.env.PROOF_RUN_MEMORY_FLYWHEEL;
    try {
      const svc = new MemoryCandidateService(db);
      const c = svc.create({ title: 'stall', content: 'stalled ollama body', memory_type: 'operational_memory' });
      svc.promote(c.id, { approved_by: 'test' });
      const started = Date.now();
      const result = await svc.upsertToSwarmMemory(c.id);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^exception:/);
    } finally {
      if (flywheelEnv !== undefined) process.env.PROOF_RUN_MEMORY_FLYWHEEL = flywheelEnv;
      db.close();
    }
  }, 12_000);
});
