import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { KnowledgeMaintenanceService, periodKey } from '../services/knowledge-maintenance-service';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';

let db: Database.Database;
let okf: string;
beforeEach(() => {
  db = new Database(':memory:'); runPreSchemaMigrations(db); db.exec(schema); runMigrations(db);
  okf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-'));
  fs.writeFileSync(path.join(okf, 'good.md'), '---\ntitle: ok\n---\nbody');
  fs.writeFileSync(path.join(okf, 'no-frontmatter.md'), 'just text');
  fs.writeFileSync(path.join(okf, 'empty.md'), '');
});
afterEach(() => { db.close(); fs.rmSync(okf, { recursive: true, force: true }); vi.unstubAllGlobals(); });

const knowledge = (over: Record<string, unknown> = {}) => ({
  syncCapabilities: vi.fn(() => ({ created: 2, updated: 1, unchanged: 5, blocked: 0 })),
  health: vi.fn(() => ({ okf_base: okf })),
  ...over,
}) as never;

const wikiEvent = (id: string, at: string, pages: string[]) => db.prepare(
  "INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'wiki.page.changed', 'djimitkb-wiki', ?, ?)"
).run(id, at, JSON.stringify({ event_type: 'wiki.page.changed', pages }));

describe('periodKey', () => {
  it('uses the UTC day for daily jobs and the ISO week for weekly jobs', () => {
    expect(periodKey('daily', new Date('2026-09-21T23:59:00Z'))).toBe('2026-09-21');
    expect(periodKey('weekly', new Date('2026-09-21T10:00:00Z'))).toBe('2026-W39');
    expect(periodKey('weekly', new Date('2027-01-01T10:00:00Z'))).toBe('2026-W53');
  });
});

describe('KnowledgeMaintenanceService', () => {
  it('runs every job once per period, records a ledger row and creates idempotent work items for findings', async () => {
    wikiEvent('w1', '2026-09-21T08:00:00.000Z', ['wiki/a.md', 'wiki/b.md']);
    const svc = new KnowledgeMaintenanceService(db, knowledge());
    const ran = await svc.runDue(new Date('2026-09-21T12:00:00Z'));
    expect(ran.map((r) => [r.job, r.status, r.findings])).toEqual([['okf_sync_drift', 'findings', 3], ['wiki_delta', 'findings', 2], ['okf_lint', 'findings', 2]]);
    expect(await svc.runDue(new Date('2026-09-21T18:00:00Z'))).toEqual([]); // same period: nothing repeats (restart-safe)
    const items = db.prepare("SELECT title, source_ref, recommended_loop, status FROM work_items WHERE source = 'knowledge_maintenance' ORDER BY source_ref").all() as Array<{ title: string; source_ref: string; recommended_loop: string }>;
    expect(items.map((i) => i.source_ref)).toEqual(['okf_lint:2026-W39', 'okf_sync_drift:2026-09-21', 'wiki_delta:2026-09-21']);
    expect(items.every((i) => i.recommended_loop === 'okf-synchronization-loop')).toBe(true);
    expect(items.find((i) => i.source_ref.startsWith('wiki_delta'))!.title).toContain('2 changed page(s)');
  });

  it('daily jobs run again the next day, the weekly one waits for the next week', async () => {
    const svc = new KnowledgeMaintenanceService(db, knowledge());
    await svc.runDue(new Date('2026-09-21T12:00:00Z'));
    expect((await svc.runDue(new Date('2026-09-22T12:00:00Z'))).map((r) => r.job)).toEqual(['okf_sync_drift', 'wiki_delta']);
    expect((await svc.runDue(new Date('2026-09-28T12:00:00Z'))).map((r) => r.job)).toEqual(['okf_sync_drift', 'wiki_delta', 'okf_lint']);
  });

  it('wiki_delta only counts events after the previous successful run', async () => {
    const svc = new KnowledgeMaintenanceService(db, knowledge());
    wikiEvent('old', '2026-09-20T08:00:00.000Z', ['wiki/old.md']);
    await svc.runDue(new Date('2026-09-21T12:00:00Z'));
    wikiEvent('new', '2026-09-21T15:00:00.000Z', ['wiki/new.md']);
    const ran = await svc.runDue(new Date('2026-09-22T12:00:00Z'));
    expect(ran.find((r) => r.job === 'wiki_delta')).toMatchObject({ status: 'findings', findings: 1 });
    const detail = JSON.parse((db.prepare("SELECT detail_json d FROM knowledge_maintenance_runs WHERE job = 'wiki_delta' AND period = '2026-09-22'").get() as { d: string }).d);
    expect(detail.pages).toEqual(['wiki/new.md']);
  });

  it('a failing job is recorded as failed and does not stop the others or create a work item', async () => {
    const svc = new KnowledgeMaintenanceService(db, knowledge({ syncCapabilities: vi.fn(() => { throw new Error('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING'); }) }));
    const ran = await svc.runDue(new Date('2026-09-21T12:00:00Z'));
    expect(ran.map((r) => [r.job, r.status])).toEqual([['okf_sync_drift', 'failed'], ['wiki_delta', 'ok'], ['okf_lint', 'findings']]);
    expect(db.prepare("SELECT COUNT(*) n FROM work_items WHERE source_ref LIKE 'okf_sync_drift%'").get()).toEqual({ n: 0 });
  });

  it('a clean knowledge base leaves a ledger row and no work items', async () => {
    fs.rmSync(path.join(okf, 'no-frontmatter.md')); fs.rmSync(path.join(okf, 'empty.md'));
    const svc = new KnowledgeMaintenanceService(db, knowledge({ syncCapabilities: vi.fn(() => ({ created: 0, updated: 0, unchanged: 9, blocked: 0 })) }));
    const ran = await svc.runDue(new Date('2026-09-21T12:00:00Z'));
    expect(ran.every((r) => r.status === 'ok')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM work_items WHERE source = 'knowledge_maintenance'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM knowledge_maintenance_runs').get()).toEqual({ n: 3 });
  });
});

describe('bus ingestion of wiki.page.changed', () => {
  it('stores the event so the wiki_delta job can see it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [
      { _id: '1-0', event_id: 'wiki:ws:abc', event_type: 'wiki.page.changed', source: 'djimitkb-wiki', occurred_at: '2026-09-21T09:00:00.000Z', pages: ['wiki/x.md'] },
    ] }), { status: 200 })));
    await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
    expect(db.prepare("SELECT event_type FROM external_events WHERE id = 'wiki:ws:abc'").get()).toEqual({ event_type: 'wiki.page.changed' });
    const ran = await new KnowledgeMaintenanceService(db, knowledge()).runDue(new Date('2026-09-21T12:00:00Z'));
    expect(ran.find((r) => r.job === 'wiki_delta')).toMatchObject({ findings: 1 });
  });
});
