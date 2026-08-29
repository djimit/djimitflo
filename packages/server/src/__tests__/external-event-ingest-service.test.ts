import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runPreSchemaMigrations } from '../database/migrate';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';

describe('ExternalEventIngestService', () => {
  afterEach(() => vi.unstubAllGlobals());

  function createDb(): Database.Database {
    const db = new Database(':memory:');
    runPreSchemaMigrations(db);
    db.exec(schema);
    return db;
  }

  it('imports one causal Paperclip transition despite bus redelivery', async () => {
    const db = createDb();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [
      null,
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

  it('backfills beyond 5000 events and resumes from a durable cursor', async () => {
    const db = createDb();
    const events = Array.from({ length: 5001 }, (_, index) => ({
      _id: `${6000 - index}-0`,
      event_id: `fleet:${index}`,
      event_type: 'fleet.status.changed',
    }));
    events[0] = { ...events[0], event_id: 'paperclip:newest', event_type: 'paperclip.issue.created' };
    events[5000] = { ...events[5000], event_id: 'paperclip:oldest', event_type: 'paperclip.issue.created' };
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const count = Number(new URL(String(input)).searchParams.get('count'));
      return new Response(JSON.stringify({ events: events.slice(0, count) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await new ExternalEventIngestService(db, 'http://event-bus').pollOnce()).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((db.prepare("SELECT value FROM system_state WHERE key = 'external_event_ingest_cursor:djimit.events'").get() as { value: string }).value).toBe('6000-0');

    events.unshift({ _id: '7000-0', event_id: 'paperclip:after-restart', event_type: 'paperclip.issue.created' });
    expect(await new ExternalEventIngestService(db, 'http://event-bus').pollOnce()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(db.prepare('SELECT id FROM external_events ORDER BY id').all()).toEqual([
      { id: 'paperclip:after-restart' },
      { id: 'paperclip:newest' },
      { id: 'paperclip:oldest' },
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
    db.exec(schema);

    const columns = db.prepare('PRAGMA table_info(external_events)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'causation_id', 'aggregate_id', 'aggregate_version', 'dedupe_key',
    ]));
    const insert = db.prepare("INSERT OR IGNORE INTO external_events (id, event_type, source, dedupe_key, occurred_at, payload) VALUES (?, 'paperclip.issue.created', 'paperclip', 'same', '2026-08-20T00:00:00Z', '{}')");
    expect(insert.run('first').changes).toBe(1);
    expect(insert.run('redelivery').changes).toBe(0);
    db.close();
  });

  it('imports a complete outcome once and rejects incomplete outcome evidence', async () => {
    const db = createDb();
    const outcome = {
      event_id: 'outcome:publication-1:qualified-lead',
      event_type: 'outcome.observed',
      source: 'eve-v',
      outcome_id: 'outcome-1',
      subject_type: 'publication',
      subject_id: 'publication-1',
      task_id: 'task-1',
      candidate_id: 'candidate-1',
      capability_id: 'eve-content',
      model_id: 'model-1',
      skill_hash: 'sha256:skill',
      runtime_identity: 'git:abc123',
      metric: 'qualified_lead',
      value: 1,
      baseline: 0,
      observation_window: 'P30D',
      evidence_refs: ['paperclip:task-1'],
      confidence: 0.8,
      causal_status: 'correlated',
      observed_at: '2026-08-29T14:00:00+02:00',
      occurred_at: '2026-08-29T13:00:00Z',
      dedupe_key: 'outcome:publication-1:qualified-lead:P30D',
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [
      outcome,
      { ...outcome, event_id: '   ', _id: 'outcome:fallback', outcome_id: 'outcome-2', dedupe_key: 'outcome:fallback' },
      { ...outcome, event_id: {}, _id: 'outcome:object-id-fallback', outcome_id: 'outcome-3', dedupe_key: 'outcome:object-id-fallback' },
      { ...outcome, event_id: 'outcome:redelivery' },
      { ...outcome, event_id: 'outcome:padded-redelivery', dedupe_key: ` ${outcome.dedupe_key} ` },
      { ...outcome, event_id: 'outcome:missing-dedupe', dedupe_key: undefined },
      { ...outcome, event_id: 'outcome:blank-id', outcome_id: '   ', dedupe_key: 'outcome:blank-id' },
      { event_id: 'outcome:invalid', event_type: 'outcome.observed', outcome_id: 'missing-fields' },
    ] }), { status: 200 })));

    const service = new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events');
    expect(await service.pollOnce()).toBe(3);
    expect(db.prepare("SELECT id, event_type, source, occurred_at FROM external_events WHERE event_type = 'outcome.observed'").all()).toEqual([
      { id: outcome.event_id, event_type: 'outcome.observed', source: 'eve-v', occurred_at: '2026-08-29T12:00:00.000Z' },
      { id: 'outcome:fallback', event_type: 'outcome.observed', source: 'eve-v', occurred_at: '2026-08-29T12:00:00.000Z' },
      { id: 'outcome:object-id-fallback', event_type: 'outcome.observed', source: 'eve-v', occurred_at: '2026-08-29T12:00:00.000Z' },
    ]);
    db.close();
  });
});
