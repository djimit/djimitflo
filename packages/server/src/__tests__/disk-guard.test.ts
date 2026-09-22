import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { DiskGuardService } from '../services/disk-guard-service';
import { AgentRegistrySyncService } from '../services/agent-registry-sync-service';

let db: Database.Database;
const disk = (usedPct: number) => () => ({ blocks: 1000, bavail: Math.round(1000 * (1 - usedPct / 100)), bsize: 1_000_000_000 / 1000 * 1000 });
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); process.env.EVENT_PUBLISH_ENABLED = 'true'; });
afterEach(() => { delete process.env.EVENT_PUBLISH_ENABLED; delete process.env.AGENT_REGISTRY_URL; delete process.env.AGENT_REGISTRY_EXCLUDE_FRAMEWORKS; db.close(); });
const items = () => db.prepare("SELECT source_ref, risk_class FROM work_items WHERE source = 'disk_guard' ORDER BY source_ref").all();

it('is silent below 80 %', () => {
  expect(new DiskGuardService(db, disk(60)).check().level).toBe('ok');
  expect(items()).toEqual([]);
});
it('raises one work item + one bus event per day and level, escalating to critical', () => {
  const now = new Date('2026-09-22T10:00:00Z');
  const svc = new DiskGuardService(db, disk(85));
  expect(svc.check(now).level).toBe('warn'); svc.check(now); // second check same day: no duplicate
  expect(items()).toEqual([{ source_ref: '2026-09-22:warn', risk_class: 'medium' }]);
  expect(db.prepare("SELECT COUNT(*) n FROM event_outbox WHERE event_type = 'djimitflo.alert.disk'").get()).toEqual({ n: 1 });
  expect(new DiskGuardService(db, disk(95)).check(now).level).toBe('critical');
  expect(items().length).toBe(2);
});
it('registry sync skips (and drops) retired frameworks such as paperclip', async () => {
  process.env.AGENT_REGISTRY_URL = 'http://reg';
  db.prepare("INSERT INTO registry_agents (name, framework, synced_at) VALUES ('paperclip-control', 'paperclip', 'x')").run();
  const list = [{ name: 'paperclip-control', framework: 'paperclip' }, { name: 'djimitflo-vps', framework: 'djimitflo' }];
  const svc = new AgentRegistrySyncService(db, (async () => ({ ok: true, json: async () => list })) as unknown as typeof fetch);
  expect((await svc.sync()).synced).toBe(1);
  expect((svc.list() as Array<{ name: string }>).map((a) => a.name)).toEqual(['djimitflo-vps']);
});
