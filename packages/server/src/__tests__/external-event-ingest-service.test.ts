import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';

describe('ExternalEventIngestService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('imports Paperclip events once and ignores unrelated events', async () => {
    const db = new Database(':memory:');
    db.exec(schema);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [
      { _id: '1-0', event_type: 'paperclip.issue.created', source: 'paperclip', correlation_id: 'issue-1', occurred_at: '2026-08-20T00:00:00Z' },
      { _id: '2-0', event_type: 'fleet.status.changed', source: 'agent-registry' },
    ] }), { status: 200 })));

    const service = new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events');
    expect(await service.pollOnce()).toBe(1);
    expect(await service.pollOnce()).toBe(0);
    expect(db.prepare('SELECT event_type, correlation_id FROM external_events').all()).toEqual([
      { event_type: 'paperclip.issue.created', correlation_id: 'issue-1' },
    ]);
    db.close();
  });
});
