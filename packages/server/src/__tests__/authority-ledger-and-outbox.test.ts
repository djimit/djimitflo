import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRequestType, type Task, type RiskAssessment } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { recordAuthorityEvent } from '../services/authority-ledger-service';
import { EventOutboxService, bridgeGoalEvents, enqueueEvent } from '../services/event-outbox-service';
import { swarmEventBus } from '../services/swarm-event-bus';

const assessment = { action_type: 'shell_command', risk_level: 'high', matched_rules: [], explanation: 'x', recommended_decision: 'require_approval', metadata: {} } as RiskAssessment;
let db: Database.Database;
let service: ApprovalService;
let task: Task;
const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.EVENT_PUBLISH_ENABLED = 'true';
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(schema); runMigrations(db);
  db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode) VALUES (?,?,?,?,?,?,?)')
    .run('t1', 'Fixture', 'Review', 'awaiting_approval', 'low', 'high', 'local');
  task = db.prepare('SELECT * FROM tasks WHERE id=?').get('t1') as Task;
  service = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
});
afterEach(() => { delete process.env.EVENT_PUBLISH_ENABLED; delete process.env.DJIMIT_EVENT_BUS_URL; delete process.env.DJIMIT_EVENT_BUS_TOKEN; db.close(); vi.restoreAllMocks(); });

const create = () => service.createApproval({ task, assessment, requestType: ApprovalRequestType.HIGH_RISK_ACTION, title: 'T', description: 'D', requestedBy: 'maker', metadata: {} });

describe('authority ledger', () => {
  it('sequences per correlation id', () => {
    recordAuthorityEvent(db, { correlationId: 'c', artifactId: 'a', actorSubject: 's', actorType: 'service', requestedState: 'X', decision: 'HOLD' });
    recordAuthorityEvent(db, { correlationId: 'c', artifactId: 'a', actorSubject: 's', actorType: 'service', requestedState: 'Y', decision: 'ALLOW' });
    expect(rows('SELECT sequence FROM authority_events ORDER BY sequence').map(r => r.sequence)).toEqual([1, 2]);
  });
  it('returns null instead of throwing when the table is missing', () => {
    db.exec('DROP TABLE authority_events');
    expect(recordAuthorityEvent(db, { correlationId: 'c', artifactId: 'a', actorSubject: 's', actorType: 'service', requestedState: 'X', decision: 'HOLD' })).toBeNull();
  });
  it('records HOLD then ALLOW / DENY for approvals, plus outbox events', () => {
    const a = create(); service.decideApproval(a.id, true, 'independent');
    const b = create(); service.decideApproval(b.id, false, 'independent', 'no');
    const ledger = rows('SELECT requested_state, policy_decision AS decision FROM authority_events ORDER BY occurred_at, sequence');
    expect(ledger.map(r => r.decision)).toEqual(['HOLD', 'ALLOW', 'HOLD', 'DENY']);
    expect(ledger.map(r => r.requested_state)).toContain('EXECUTION_DENIED');
    expect(rows('SELECT event_type FROM event_outbox').length).toBeGreaterThanOrEqual(4);
  });
  it('labels only real users as human; autonomy:/inherit:/agent:/system deciders are not human', () => {
    db.prepare('INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,?)').run('u-1', 'op@test', 'unused', 'approver');
    for (const decider of ['autonomy:test-gap-rule-v1', 'inherit:appr-0', 'agent:checker', 'system', 'u-1', 'op@test', 'unknown-label']) {
      service.decideApproval(create().id, true, decider);
    }
    const decided = rows("SELECT actor_subject, actor_type FROM authority_events WHERE requested_state = 'EXECUTION_APPROVED'");
    const typeOf = Object.fromEntries(decided.map((r) => [r.actor_subject, r.actor_type]));
    expect(typeOf).toEqual({
      'autonomy:test-gap-rule-v1': 'service', 'inherit:appr-0': 'service', 'agent:checker': 'agent', system: 'service',
      'u-1': 'human', 'op@test': 'human', 'unknown-label': 'service',
    });
    // the HOLD of a request made by a non-user ('maker') is not a human event either
    expect(rows("SELECT DISTINCT actor_type FROM authority_events WHERE requested_state = 'EXECUTION_APPROVAL_REQUESTED'")).toEqual([{ actor_type: 'service' }]);
  });
});

describe('event outbox', () => {
  it('is a no-op when EVENT_PUBLISH_ENABLED is off', () => {
    process.env.EVENT_PUBLISH_ENABLED = 'false';
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a' });
    expect(rows('SELECT * FROM event_outbox')).toHaveLength(0);
  });
  it('is DISABLED without a bus url', async () => {
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a' });
    expect((await new EventOutboxService(db).publishPending()).status).toBe('DISABLED');
  });
  it('publishes with bearer token, then retries failures', async () => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083'; process.env.DJIMIT_EVENT_BUS_TOKEN = 'tok';
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a', payload: { k: 1 } });
    const fetchFn = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, status: 200 });
    const svc = new EventOutboxService(db, fetchFn as unknown as typeof fetch);
    expect(await svc.publishPending()).toMatchObject({ failed: 1, published: 0 });
    expect(rows('SELECT status, last_error FROM event_outbox')[0]).toMatchObject({ status: 'failed', last_error: 'event bus returned 503' });
    expect(await svc.publishPending()).toMatchObject({ failed: 0, published: 1 });
    const [url, init] = fetchFn.mock.calls[1];
    expect(url).toBe('http://bus:8083/events/djimit.events');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ event_type: 'djimitflo.x', source: 'djimitflo', k: 1 });
  });
  it('keeps persisted event identity authoritative across retries despite payload collisions', async () => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083';
    enqueueEvent(db, { type: 'djimitflo.goal.created', aggregateId: 'goal-1', correlationId: 'task-1', payload: {
      event_id: 'forged', event_type: 'approval.granted', source: 'external', occurred_at: 'forged',
      aggregate_id: 'other', correlation_id: 'other', dedupe_key: 'shared', title: 'Preserved data',
    } });
    const row = rows('SELECT * FROM event_outbox')[0];
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ ok: true });
    await new EventOutboxService(db, fetchFn).publishPending();
    await new EventOutboxService(db, fetchFn).publishPending();
    for (const [, init] of fetchFn.mock.calls) expect(JSON.parse(init.body)).toMatchObject({
      event_id: `djimitflo:${row.event_id}`, event_type: row.event_type, source: 'djimitflo',
      occurred_at: row.created_at, aggregate_id: 'goal-1', correlation_id: 'task-1',
      dedupe_key: `djimitflo:${row.event_id}`, title: 'Preserved data',
    });
  });
  it.each([
    { source: 'roborev' }, { work_item_source: 'roborev' },
  ])('preserves legacy and current work-item origins outside the canonical envelope: %j', async (payload) => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083';
    enqueueEvent(db, { type: 'djimitflo.work_item.created', aggregateId: 'work-1', payload });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    await new EventOutboxService(db, fetchFn).publishPending();
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({ source: 'djimitflo', work_item_source: 'roborev' });
  });
  it('does not drain persisted events when publishing is disabled', async () => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083';
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a' });
    process.env.EVENT_PUBLISH_ENABLED = 'false';
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    expect(await new EventOutboxService(db, fetchFn).publishPending()).toMatchObject({ status: 'DISABLED', attempted: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(rows('SELECT status, attempts FROM event_outbox')).toEqual([{ status: 'pending', attempts: 0 }]);
  });
  it('honors disablement before sending the next queued event without resetting attempts', async () => {
    process.env.DJIMIT_EVENT_BUS_URL = 'http://bus:8083';
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a' });
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'b' });
    const fetchFn = vi.fn().mockImplementation(async () => {
      process.env.EVENT_PUBLISH_ENABLED = 'false';
      return { ok: true };
    });
    const svc = new EventOutboxService(db, fetchFn);
    expect(await svc.publishPending()).toEqual({ status: 'DISABLED', attempted: 1, published: 1, failed: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(rows('SELECT status, attempts FROM event_outbox ORDER BY rowid')).toEqual([
      { status: 'published', attempts: 1 }, { status: 'pending', attempts: 0 },
    ]);
    process.env.EVENT_PUBLISH_ENABLED = 'true';
    expect(await svc.publishPending()).toMatchObject({ attempted: 1, published: 1 });
    expect(rows('SELECT attempts FROM event_outbox')).toEqual([{ attempts: 1 }, { attempts: 1 }]);
  });
  it('bridges goal lifecycle events from the in-process bus', () => {
    const off = bridgeGoalEvents(db);
    swarmEventBus.emit('convergence', { daemon: 'goal_completed', goal_id: 'g1', run_id: 'r1' });
    off();
    expect(rows('SELECT event_type, aggregate_id FROM event_outbox')).toEqual([{ event_type: 'djimitflo.goal.completed', aggregate_id: 'g1' }]);
  });
});
