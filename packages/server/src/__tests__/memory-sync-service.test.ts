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
      return { ok: true, status: 201 } as any;
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

  it('does not report Qdrant success when the upsert is rejected (401)', async () => {
    process.env.QDRANT_URL = 'http://qdrant.test:6333';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/collections/djimitflo_swarm/points')) return { ok: false, status: 401 } as any;
      return { ok: true, status: 200 } as any;
    }));

    await new MemorySyncService(fakeDb()).onTaskCompleted('task-1');

    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('→ Qdrant');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Qdrant sync failed');
  });

  it('does not fail the sync when the OKF base is missing/dangling', async () => {
    // A regular file where a directory is expected makes the OKF projection uncreatable.
    const blocker = path.join(tmpOkf, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.OKF_BASE = path.join(blocker, 'okf');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as any));

    await expect(new MemorySyncService(fakeDb()).onTaskCompleted('task-1')).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('OKF concept write failed');
  });
});
