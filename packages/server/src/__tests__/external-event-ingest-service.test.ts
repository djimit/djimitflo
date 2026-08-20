import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runPreSchemaMigrations } from '../database/migrate';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';

describe('ExternalEventIngestService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('imports one causal Paperclip transition despite bus redelivery', async () => {
    const db = new Database(':memory:');
    db.exec(schema);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [
      { _id: '1-0', event_id: 'paperclip:issue-1:1', event_type: 'paperclip.issue.created', source: 'paperclip', correlation_id: 'issue-1', aggregate_id: 'issue-1', aggregate_version: '1', dedupe_key: 'paperclip:issue-1:todo', occurred_at: '2026-08-20T00:00:00Z' },
      { _id: '2-0', event_id: 'paperclip:issue-1:retry', event_type: 'paperclip.issue.created', source: 'paperclip', correlation_id: 'issue-1', aggregate_id: 'issue-1', aggregate_version: '1', dedupe_key: 'paperclip:issue-1:todo', occurred_at: '2026-08-20T00:00:00Z' },
      { _id: '3-0', event_type: 'fleet.status.changed', source: 'agent-registry' },
    ] }), { status: 200 })));

    const service = new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events');
    expect(await service.pollOnce()).toBe(1);
    expect(await service.pollOnce()).toBe(0);
    expect(db.prepare('SELECT id, correlation_id, causation_id, aggregate_id, aggregate_version FROM external_events').all()).toEqual([
      { id: 'paperclip:issue-1:1', correlation_id: 'issue-1', causation_id: null, aggregate_id: 'issue-1', aggregate_version: 1 },
    ]);
    db.close();
  });

  it('adds causal columns to an existing external-events table', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE external_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, source TEXT NOT NULL,
      correlation_id TEXT, occurred_at TEXT NOT NULL, payload TEXT NOT NULL
    )`);

    runPreSchemaMigrations(db);

    const columns = db.prepare('PRAGMA table_info(external_events)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'causation_id', 'aggregate_id', 'aggregate_version', 'dedupe_key',
    ]));
    db.close();
  });
});
