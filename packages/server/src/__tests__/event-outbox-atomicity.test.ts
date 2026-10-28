// CODE-003 (forensic audit 2026-10-26): a domain row whose contract promises a durable event commits together with its
// event_outbox row or not at all. Faults are injected on the outbox insert, between the domain write and the enqueue,
// and after the commit (bus outage), and the dispatcher's retry + dedupe key must still yield exactly one delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRequestType, type RiskAssessment, type Task } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { EventOutboxService, enqueueRequiredEvent } from '../services/event-outbox-service';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';
import { WorkItemService } from '../services/work-item-service';

let db: Database.Database;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const failOutboxInserts = () => db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox fault'); END`);
const healOutbox = () => db.exec('DROP TRIGGER fail_outbox');
const item = (title: string) => ({ title, description: 'd', source: 'manual' });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.EVENT_PUBLISH_ENABLED = 'true';
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
});
afterEach(() => { delete process.env.EVENT_PUBLISH_ENABLED; delete process.env.DJIMIT_EVENT_BUS_URL; db.close(); vi.restoreAllMocks(); });

describe('work item created: required event', () => {
  it('an outbox insert failure rolls back the work item and surfaces the error', () => {
    failOutboxInserts();
    expect(() => new WorkItemService(db).create(item('a'))).toThrow(/injected outbox fault/);
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(0);
  });

  it('a fault after the domain write but before the enqueue leaves neither row', () => {
    const svc = new WorkItemService(db);
    vi.spyOn(svc, 'get').mockImplementationOnce(() => { throw new Error('crash between row and outbox'); });
    expect(() => svc.create(item('a'))).toThrow(/crash between row and outbox/);
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_outbox')).toBe(0);
  });

  it('the source_ref paths (createIfMissing / upsert) are atomic too', () => {
    failOutboxInserts();
    const svc = new WorkItemService(db);
    expect(() => svc.createIfMissingBySourceRef({ ...item('a'), source: 'roborev', source_ref: 'r1' })).toThrow(/injected/);
    expect(() => svc.upsertBySourceRef({ ...item('b'), source: 'roborev', source_ref: 'r2' })).toThrow(/injected/);
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(0);
  });

  it('a work item never exists without its event, across interleaved faults', () => {
    const svc = new WorkItemService(db);
    for (let i = 0; i < 12; i++) {
      const faulty = i % 3 === 1;
      if (faulty) failOutboxInserts();
      try { svc.create(item(`w${i}`)); } catch { /* expected for faulty rounds */ }
      if (faulty) healOutbox();
    }
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(8);
    expect(count(`SELECT COUNT(*) AS n FROM work_items w WHERE NOT EXISTS (
      SELECT 1 FROM event_outbox o WHERE o.aggregate_id = w.id AND o.event_type = 'djimitflo.work_item.created')`)).toBe(0);
  });

  it('stays a no-op for the outbox while publishing is off (no event is promised)', () => {
    process.env.EVENT_PUBLISH_ENABLED = 'false';
    failOutboxInserts();
    expect(new WorkItemService(db).create(item('a')).title).toBe('a');
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(1);
  });
});

describe('approval lifecycle: required events', () => {
  const assessment = { action_type: 'shell_command', risk_level: 'high', matched_rules: [], explanation: 'x', recommended_decision: 'require_approval', metadata: {} } as RiskAssessment;
  let service: ApprovalService; let task: Task;
  beforeEach(() => {
    db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode) VALUES (?,?,?,?,?,?,?)')
      .run('t1', 'Fixture', 'Review', 'awaiting_approval', 'low', 'high', 'local');
    task = db.prepare('SELECT * FROM tasks WHERE id=?').get('t1') as Task;
    service = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
    process.env.TELEGRAM_PUSH_DELAY_MS = '0';
  });
  afterEach(() => { delete process.env.TELEGRAM_PUSH_DELAY_MS; });
  const create = () => service.createApproval({ task, assessment, requestType: ApprovalRequestType.HIGH_RISK_ACTION, title: 'T', description: 'D', requestedBy: 'maker', metadata: {} });
  const outboxFor = (id: string) => db.prepare('SELECT event_type FROM event_outbox WHERE aggregate_id = ? ORDER BY rowid').all(id).map((r) => (r as { event_type: string }).event_type);

  it('an outbox insert failure rolls back the approval request', () => {
    failOutboxInserts();
    expect(() => create()).toThrow(/injected outbox fault/);
    expect(count('SELECT COUNT(*) AS n FROM approvals')).toBe(0);
  });

  it('an outbox insert failure rolls back the decision: the approval stays pending', () => {
    const a = create();
    failOutboxInserts();
    expect(() => service.decideApproval(a.id, true, 'independent')).toThrow(/injected outbox fault/);
    expect(service.getApproval(a.id)?.status).toBe('pending');
    healOutbox();
    service.decideApproval(a.id, true, 'independent');
    expect(outboxFor(a.id)).toEqual(['djimitflo.approval.requested', 'djimitflo.approval.approved']);
  });

  it('an outbox insert failure rolls back an expiry', () => {
    const a = create();
    db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), a.id);
    failOutboxInserts();
    expect(() => service.getLatestPendingForTask('t1')).toThrow(/injected outbox fault/);
    expect(service.getApproval(a.id)?.status).toBe('pending');
    healOutbox();
    service.getLatestPendingForTask('t1');
    expect(service.getApproval(a.id)?.status).toBe('expired');
    expect(outboxFor(a.id)).toEqual(['djimitflo.approval.requested', 'djimitflo.approval.expired']);
  });
});

describe('goal created from a self-improvement: required event', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
      VALUES ('imp-1', 'feature', 'Add tests', 'd', 'r', 'gap_analysis', 'scheduled', 0.5, datetime('now'), datetime('now'))`).run();
  });

  it('an outbox insert failure rolls back the goal and the proposal status', () => {
    failOutboxInserts();
    expect(() => new AutonomousGoalGenerator(db).generateImprovement('imp-1')).toThrow(/injected outbox fault/);
    expect(count('SELECT COUNT(*) AS n FROM goals')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'scheduled'")).toBe(1);
    healOutbox();
    expect(new AutonomousGoalGenerator(db).generateImprovement('imp-1')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM goals g JOIN event_outbox o ON o.aggregate_id = g.id AND o.event_type = 'djimitflo.goal.created'`)).toBe(1);
  });
});

describe('required enqueue contract', () => {
  it('refuses to run outside a transaction (it would not be atomic with anything)', () => {
    expect(() => enqueueRequiredEvent(db, { type: 'djimitflo.x', aggregateId: 'a' })).toThrow(/REQUIRED_EVENT_OUTSIDE_TRANSACTION/);
  });
});

describe('roborev intake: an outbox failure is retried, not skipped', () => {
  const finding = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, event_id: `roborev:${id}`, event_type: 'roborev.finding', source: 'roborev',
    task_title: `Fix ${id}`, context: 'ctx', severity: 'high', task_type: 'review_fix', dedupe_key: `roborev:dk:${id}`, ...extra });
  const serve = (events: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
  afterEach(() => vi.unstubAllGlobals());

  it('rolls the whole poll back (no event stored, cursor not advanced) and the next poll creates the work item and its event', async () => {
    serve([finding('1-0')]);
    const ingest = new ExternalEventIngestService(db, 'http://bus', 'djimit.events');
    failOutboxInserts();
    await expect(ingest.pollOnce()).rejects.toThrow(/injected outbox fault/);
    expect(count('SELECT COUNT(*) AS n FROM work_items')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM external_events')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM system_state WHERE key = 'external_event_ingest_cursor:djimit.events'")).toBe(0);
    healOutbox();
    expect(await ingest.pollOnce()).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM work_items w JOIN event_outbox o ON o.aggregate_id = w.id AND o.event_type = 'djimitflo.work_item.created'
      WHERE w.source = 'roborev' AND w.source_ref = 'roborev:dk:1-0'`)).toBe(1);
  });

  it('still skips a malformed finding without blocking the rest of the batch', async () => {
    serve([finding('2-0'), finding('1-0', { task_title: '  ' })]);
    expect(await new ExternalEventIngestService(db, 'http://bus', 'djimit.events').pollOnce()).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM work_items WHERE source = 'roborev'")).toBe(1);
  });
});

describe('after the commit: dispatcher retry + bus dedupe', () => {
  it('delivers at least once with a stable dedupe key; a bus that dedupes on it records the event once even when an ack is lost', async () => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083';
    const created = new WorkItemService(db).create(item('a'));
    const stored = new Set<string>(); let arrivals = 0; // the bus stores each dedupe_key once
    let posts = 0;
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      posts++;
      if (posts === 1) throw new Error('ECONNREFUSED'); // outage: never reached the bus
      if (posts === 2) return { ok: false, status: 503 }; // bus refused it
      const key = JSON.parse(init.body as string).dedupe_key as string;
      arrivals++; stored.add(key);
      if (posts === 3) throw new Error('socket hang up'); // accepted, but the ack was lost
      return { ok: true, status: 200 };
    });
    const svc = new EventOutboxService(db, fetchFn as unknown as typeof fetch);
    for (let i = 0; i < 3; i++) expect(await svc.publishPending()).toMatchObject({ attempted: 1, failed: 1 });
    expect(await svc.publishPending()).toMatchObject({ attempted: 1, published: 1 }); // the redelivery of an accepted event
    expect(await svc.publishPending()).toMatchObject({ attempted: 0, published: 0 }); // a published row is never re-sent
    const keys = fetchFn.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).dedupe_key);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1); // every retry carries the same key
    expect(arrivals).toBe(2); // at least once: the accepted-but-unacked event arrived again
    expect(stored.size).toBe(1); // the bus's dedupe made it one stored event
    expect(db.prepare('SELECT aggregate_id, status, attempts FROM event_outbox').get()).toEqual({ aggregate_id: created.id, status: 'published', attempts: 4 });
  });
});
