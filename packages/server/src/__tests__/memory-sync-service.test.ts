import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemorySyncService } from '../services/memory-sync-service';

let tmpOkf: string;

// Minimal in-memory task/agent rows for the SELECTs in onTaskCompleted.
function fakeDb() {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('FROM tasks')) {
          return {
            id: 'task-1',
            title: 'T',
            description: 'do the thing',
            status: 'completed',
            created_by: 'macbook',
            agent_id: 'a1',
            created_at: '2026-09-15T00:00:00Z',
            completed_at: '2026-09-15T00:01:00Z',
          };
        }
        if (sql.includes('FROM agents')) return { agent_type: 'maker' };
        return null;
      },
    }),
  } as any;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubbedFetch(overrides: (url: string) => any) {
  return vi.fn(async (url: string, _init: any) => {
    const o = overrides(url);
    if (o) return o;
    if (url.includes('/api/embed')) return { ok: true, status: 200, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) } as any;
    if (url.includes('/collections/djimitflo_swarm/points')) return { ok: true, status: 200 } as any;
    if (url.includes('/collections/djimitflo_swarm')) return { ok: true, status: 200, json: async () => ({ result: { points_count: 0, config: { params: { vectors: { size: 3 } } } } }) } as any;
    return { ok: true, status: 200 } as any;
  });
}

beforeEach(() => {
  // Isolate the OKF projection so the test never writes to a real knowledge base.
  tmpOkf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-test-'));
  process.env.OKF_BASE = tmpOkf;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UAMS_URL;
  delete process.env.QDRANT_URL;
  delete process.env.UAMS_API_KEY;
  delete process.env.QDRANT_API_KEY;
  delete process.env.OKF_BASE;
  fs.rmSync(tmpOkf, { recursive: true, force: true });
});

describe('MemorySyncService', () => {
  it('posts to the real UAMS contract (/memory/entry) with auth and body', async () => {
    process.env.UAMS_URL = 'http://uams.test:8000';
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    process.env.UAMS_API_KEY = 'secret';

    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({}) } as any;
    }));

    await new MemorySyncService(fakeDb()).onTaskCompleted('task-1');

    const uams = calls.find((c) => c.url.includes('uams.test'));
    expect(uams).toBeDefined();
    expect(uams!.url).toBe('http://uams.test:8000/memory/entry');
    expect(uams!.init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(uams!.init.body);
    expect(body).toMatchObject({ memory_type: 'active', scope: 'system', agent_id: 'macbook', topic: 'task:task-1' });
    expect(body.tags).toBeUndefined();
  });

  it('upserts Qdrant with a real embedding and a valid point id', async () => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/api/embed')) return { ok: true, status: 200, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) } as any;
      if (url.includes('/collections/djimitflo_swarm/points')) return { ok: true, status: 200 } as any;
      return { ok: true, status: 200, json: async () => ({ result: { points_count: 0, config: { params: { vectors: { size: 3 } } } } }) } as any;
    }));

    await new MemorySyncService(fakeDb()).onTaskCompleted('task-1');

    const upsert = calls.find((c) => c.url.endsWith('/collections/djimitflo_swarm/points'));
    expect(upsert).toBeDefined();
    const point = JSON.parse(upsert!.init.body).points[0];
    expect(point.vector).toEqual([0.1, 0.2, 0.3]);
    expect(point.vector.length).toBeGreaterThan(0);
    expect(String(point.id)).toMatch(UUID_RE);
    expect(point.payload.task_id).toBe('task-1');
  });

  it('does not report Qdrant success when the upsert is rejected (401)', async () => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.stubGlobal('fetch', stubbedFetch((url) =>
      url.includes('/collections/djimitflo_swarm/points') ? { ok: false, status: 401 } : null,
    ));

    await new MemorySyncService(fakeDb()).onTaskCompleted('task-1');

    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('→ Qdrant');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Qdrant sync failed');
  });

  it('does not recreate a populated collection at a different dimension', async () => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const methods: Array<{ url: string; method: string }> = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      methods.push({ url, method: init?.method || 'GET' });
      if (url.includes('/api/embed')) return { ok: true, status: 200, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) } as any;
      return { ok: true, status: 200, json: async () => ({ result: { points_count: 42, config: { params: { vectors: { size: 768 } } } } }) } as any;
    }));

    await new MemorySyncService(fakeDb()).onTaskCompleted('task-1');

    expect(methods.some((m) => m.method === 'DELETE')).toBe(false);
    expect(methods.some((m) => m.url.endsWith('/collections/djimitflo_swarm/points'))).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('not recreating populated data');
  });

  it('skips Qdrant without failing when no embedding model is available', async () => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/embed')) return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }));

    await expect(new MemorySyncService(fakeDb()).onTaskCompleted('task-1')).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('embedding unavailable');
  });

  it('does not fail the sync when the OKF base is missing/dangling', async () => {
    // A regular file where a directory is expected makes the OKF projection uncreatable.
    const blocker = path.join(tmpOkf, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.OKF_BASE = path.join(blocker, 'okf');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', stubbedFetch(() => null));

    await expect(new MemorySyncService(fakeDb()).onTaskCompleted('task-1')).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('OKF concept write failed');
  });
});
