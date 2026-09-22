import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentRegistrySyncService } from '../services/agent-registry-sync-service';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => { delete process.env.AGENT_REGISTRY_URL; db.close(); });

it('is DISABLED without a registry url', async () => {
  expect((await new AgentRegistrySyncService(db).sync()).status).toBe('DISABLED');
});
it('upserts agents, skips malformed rows, and updates versions on re-sync', async () => {
  process.env.AGENT_REGISTRY_URL = 'http://reg:8088/';
  const fetchFn = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'a', version: '1', capabilities: ['x'] }, { nope: 1 }] })
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'a', version: '2' }] });
  const svc = new AgentRegistrySyncService(db, fetchFn as unknown as typeof fetch);
  expect(await svc.sync()).toMatchObject({ synced: 1, status: 'OK' });
  await svc.sync();
  expect(svc.list()).toMatchObject([{ name: 'a', version: '2' }]);
  expect(fetchFn.mock.calls[0][0]).toBe('http://reg:8088/agents');
});
it('reports registry errors without throwing', async () => {
  process.env.AGENT_REGISTRY_URL = 'http://reg:8088';
  const svc = new AgentRegistrySyncService(db, vi.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch);
  expect(await svc.sync()).toMatchObject({ status: 'ERROR', error: 'registry returned 502' });
});
