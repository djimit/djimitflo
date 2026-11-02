import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemorySyncService } from '../services/memory-sync-service';

/**
 * CODE-004 (#1058 review): MEMORY_DELIVERY_RECEIPTS=off must be byte-identical to origin/main before receipts existed.
 * The fixture was captured from origin/main 4d27af57's memory-sync-service.ts with this exact scenario (frozen clock,
 * mocked I/O): UAMS answers 503, then a connection reset, then 201 (main retries both), Qdrant and OKF succeed.
 * Every request (method, url, headers, body) and the OKF file bytes must match.
 */
const FIXTURE = path.join(__dirname, 'fixtures', 'memory-sync-off-main-4d27af57.json');
const FROZEN = new Date('2026-10-27T12:00:00.000Z');
let tmpOkf: string;

const db = {
  prepare: (sql: string) => ({
    get: () => {
      if (sql.includes('FROM tasks')) {
        return { id: 'task-1', title: 'T', description: 'do the thing', status: 'completed', created_by: 'macbook', agent_id: 'a1',
          created_at: '2026-10-27T00:00:00Z', completed_at: '2026-10-27T00:01:00Z' };
      }
      if (sql.includes('FROM agents')) return { agent_type: 'maker' };
      return null;
    },
    run: () => { throw new Error('off mode must not write to the database'); },
    all: () => { throw new Error('off mode must not read receipts'); },
  }),
  exec: () => { throw new Error('off mode must not create tables'); },
} as any;

async function runOffScenario(): Promise<{ calls: Array<{ method: string; url: string; headers: unknown; body: string | null }>; okf: string }> {
  const calls: Array<{ method: string; url: string; headers: unknown; body: string | null }> = [];
  let uams = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method || 'GET', url, headers: init?.headers ?? null, body: (init?.body as string | undefined) ?? null });
    if (url.endsWith('/memory/entry')) {
      uams++;
      if (uams === 1) return new Response('{}', { status: 503 });
      if (uams === 2) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      return new Response('{}', { status: 201 });
    }
    if (url.includes('/api/embed')) return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    if (url.endsWith('/collections/djimitflo_swarm/points')) return new Response('{}');
    if (url.endsWith('/collections/djimitflo_swarm')) return new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 3 } } } } }));
    return new Response('{}', { status: 404 });
  }));
  await new MemorySyncService(db).onTaskCompleted('task-1');
  const sorted = [...calls].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
  return { calls: sorted, okf: fs.readFileSync(path.join(tmpOkf, 'tasks', 'task-1.md'), 'utf8') };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });
  tmpOkf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-off-pinned-'));
  process.env.OKF_BASE = tmpOkf;
  process.env.UAMS_URL = 'http://uams.test:8000';
  process.env.UAMS_API_KEY = 'uams-key';
  process.env.QDRANT_URL = 'http://qdrant.test:6333';
  process.env.QDRANT_API_KEY = 'qdrant-key';
  process.env.OLLAMA_URL = 'http://ollama.test:11434';
  delete process.env.MEMORY_DELIVERY_RECEIPTS;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['OKF_BASE', 'UAMS_URL', 'UAMS_API_KEY', 'QDRANT_URL', 'QDRANT_API_KEY', 'OLLAMA_URL', 'MEMORY_DELIVERY_RECEIPTS']) delete process.env[k];
  fs.rmSync(tmpOkf, { recursive: true, force: true });
});

describe('CODE-004: MEMORY_DELIVERY_RECEIPTS=off is pinned to origin/main', () => {
  for (const mode of [undefined, 'off']) {
    it(`flag ${mode ?? 'unset'}: identical requests and OKF bytes to main`, async () => {
      if (mode) process.env.MEMORY_DELIVERY_RECEIPTS = mode;
      const got = await runOffScenario();
      expect(got).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
      expect(got.calls.filter((c) => c.url.endsWith('/memory/entry'))).toHaveLength(3);
    }, 15_000);
  }
});
