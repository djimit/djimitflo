import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService, deriveRuntimeReadiness } from '../services/agent-communication-service';
import { failureRecurrence, failureSignature } from '../services/commons-failure-recurrence';

const DAY = 86_400_000;
const now = Date.parse('2026-11-19T00:00:00Z');
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function seeded() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  new AgentCommunicationService(db); // creates agent_messages
  let n = 0;
  const fail = (loop: string, daysAgo: number) => {
    const id = `run-${n += 1}`;
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES (?, ?, 'closed', 'failed', ?, ?, ?)").run(id, loop, JSON.stringify([{ name: 'tests', status: 'fail' }]), at(daysAgo), at(daysAgo));
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'failure_cause', 'loop_run', ?, 'h', 'shadow', 'yes', 'cause=flaky_test', ?)").run(`j-${id}`, id, at(daysAgo));
  };
  const discuss = (loop: string, daysAgo: number) => db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, type, payload_json, timestamp) VALUES (?, 'a', 'b', 'question', ?, ?)")
    .run(`q-${loop}`, JSON.stringify({ action: 'social.question', params: { failure_signature: `${loop}|tests|flaky_test` } }), at(daysAgo));
  return { db, fail, discuss };
}

it('splits failure kinds by Commons discussion and counts a kind as recurred only inside the window after its anchor', () => {
  const { db, fail, discuss } = seeded();
  fail('quiet', 40); discuss('quiet', 39);                 // discussed, never failed again
  fail('back', 40); discuss('back', 39); fail('back', 30); // discussed, came back after 9 days
  fail('late', 60); discuss('late', 59); fail('late', 20); // discussed, next failure outside the 14-day window
  fail('plain', 40); fail('plain', 35);                    // not discussed, came back
  fail('fresh', 3); discuss('fresh', 2);                   // anchor younger than the window: unsettled
  const r = failureRecurrence(db, now)!;
  expect(r).toMatchObject({ windowDays: 14, lookbackDays: 90, minN: 30 });
  expect(r.arms).toEqual([
    { arm: 'discussed', kinds: 3, recurred: 1, unsettled: 1, rate: null }, // below n 30: a count, not a rate
    { arm: 'not_discussed', kinds: 1, recurred: 1, unsettled: 0, rate: null },
  ]);
  db.exec('DROP TABLE judgments');
  expect(failureRecurrence(db, now)).toBeNull(); // unreadable is unknown, not "no recurrence"
});

it('a poller on a timer is scheduled, not offline, and its own failure report is kept as two fixed tokens', () => {
  const stale = at(0.2); // 4.8 h ago
  expect(deriveRuntimeReadiness({ lastHeartbeatAt: stale, lastSuccessAt: stale, lastFailureAt: null, now }).state).toBe('scheduled');
  expect(deriveRuntimeReadiness({ lastHeartbeatAt: stale, lastSuccessAt: stale, lastFailureAt: at(0.1), now }).state).toBe('offline');
  expect(deriveRuntimeReadiness({ lastHeartbeatAt: stale, lastSuccessAt: at(3), lastFailureAt: null, now }).state).toBe('offline');

  const { db } = seeded();
  db.prepare("INSERT INTO agents (id, name, description, status, capabilities, metadata, created_at, updated_at) VALUES ('p1', 'P', 'd', 'idle', '[]', '{}', datetime('now'), datetime('now'))").run();
  const comms = new AgentCommunicationService(db);
  const reported = () => JSON.parse((db.prepare("SELECT metadata FROM agents WHERE id = 'p1'").get() as { metadata: string }).metadata).social_runtime.last_reported_failure;
  comms.heartbeat('p1', 'codex', 'm', 'runtime_token', { stage: 'runtime_inference', code: 'runtime_timeout', detail: 'provider said: secret' });
  expect(Object.keys(reported()).sort()).toEqual(['at', 'code', 'stage']);
  expect(reported()).toMatchObject({ stage: 'runtime_inference', code: 'runtime_timeout' });
  comms.heartbeat('p1', 'codex', 'm', 'runtime_token', { stage: 'Provider error: 401 key=abc', code: 'x' }); // free text is refused, the last valid report stays
  comms.heartbeat('p1', 'codex', 'm', 'runtime_token');
  expect(reported()).toMatchObject({ stage: 'runtime_inference', code: 'runtime_timeout' });
  const agent = comms.listSocialCommons().agents.find((a) => a.id === 'p1')!;
  expect(agent.readiness).toMatchObject({ runtime_failures_reported: true, last_reported_failure: { code: 'runtime_timeout' } });
});

it('failureSignature: only fail gates, sorted and + joined; cause parsed from reason; nulls and no-matches fall back to unknown', () => {
  // only status:'fail' gates count, names sorted and joined with '+'
  expect(failureSignature('loopA', JSON.stringify([{ name: 'b', status: 'fail' }, { name: 'a', status: 'fail' }]), 'cause=oom')).toBe('loopA|a+b|oom');
  // a non-fail gate is dropped
  expect(failureSignature('loopA', JSON.stringify([{ name: 'tests', status: 'pass' }, { name: 'a', status: 'fail' }]), 'cause=oom')).toBe('loopA|a|oom');
  // null gates_json -> empty gate list
  expect(failureSignature('loopA', null, 'cause=flaky')).toBe('loopA||flaky');
  // invalid gates_json is swallowed -> empty gate list
  expect(failureSignature('loopA', 'not-json', 'cause=x')).toBe('loopA||x');
  // null reason -> unknown cause
  expect(failureSignature('loopA', JSON.stringify([{ name: 'a', status: 'fail' }]), null)).toBe('loopA|a|unknown');
  // reason without a cause= match -> unknown (optional-chain short-circuits, no throw)
  expect(failureSignature('loopA', JSON.stringify([{ name: 'a', status: 'fail' }]), 'no cause here')).toBe('loopA|a|unknown');
  // cause= with no lowercase/score tail -> no match -> unknown
  expect(failureSignature('loopA', JSON.stringify([{ name: 'a', status: 'fail' }]), 'cause=')).toBe('loopA|a|unknown');
  // uppercase cause label is not matched by [a-z_]+
  expect(failureSignature('loopA', JSON.stringify([{ name: 'a', status: 'fail' }]), 'cause=ABC')).toBe('loopA|a|unknown');
});

it('rate is reported only at >= minN settled kinds per arm, as recurred/kinds', () => {
  const { db, fail } = seeded();
  for (let i = 1; i <= 30; i++) {
    fail(`loop${i}`, 40); // anchor at 40d ago, settled
    if (i <= 15) fail(`loop${i}`, 30); // recur 10d after anchor, inside the 14d window
  }
  const r = failureRecurrence(db, now)!;
  const nd = r.arms.find((a) => a.arm === 'not_discussed')!;
  expect(nd).toMatchObject({ kinds: 30, recurred: 15, unsettled: 0 });
  expect(nd.rate).toBe(0.5);
  expect(r.arms.find((a) => a.arm === 'discussed')!.rate).toBeNull(); // below minN
});

it('a failure at the exact anchor instant is not a recurrence (strict greater-than on the lower bound)', () => {
  const { db, fail, discuss } = seeded();
  fail('edge', 40); discuss('edge', 40); // same instant as the anchor; not a recurrence
  const r = failureRecurrence(db, now)!;
  expect(r.arms.find((a) => a.arm === 'discussed')!).toMatchObject({ kinds: 1, recurred: 0, unsettled: 0 });
});

it('a failure exactly at anchor + window counts as a recurrence (inclusive upper bound)', () => {
  const { db, fail, discuss } = seeded();
  fail('w', 40); discuss('w', 40); fail('w', 26); // 14d after anchor, exactly on the edge
  const r = failureRecurrence(db, now)!;
  expect(r.arms.find((a) => a.arm === 'discussed')!).toMatchObject({ kinds: 1, recurred: 1, unsettled: 0 });
});

it('a kind anchored exactly at now - window is settled (strict greater-than unsettled check)', () => {
  const { db, fail, discuss } = seeded();
  fail('u', 14); discuss('u', 14); // anchor exactly at now - 14d
  const r = failureRecurrence(db, now)!;
  expect(r.arms.find((a) => a.arm === 'discussed')!).toMatchObject({ kinds: 1, recurred: 0, unsettled: 0 });
});

it('a not-discussed kind uses its first failure as anchor (min, not max): a later-only recurrence outside the window stays not-recurred', () => {
  const { db, fail } = seeded();
  fail('minmax', 40); fail('minmax', 25); // 15d apart -> outside the 14d window from the 40d anchor
  const r = failureRecurrence(db, now)!;
  expect(r.arms.find((a) => a.arm === 'not_discussed')!).toMatchObject({ kinds: 1, recurred: 0, unsettled: 0 });
});

it('failures older than the lookback are excluded from the kind population', () => {
  const { db, fail } = seeded();
  fail('old', 100); // > 90d lookback -> excluded
  fail('new', 40);
  const r = failureRecurrence(db, now)!;
  expect(r.arms.find((a) => a.arm === 'not_discussed')!).toMatchObject({ kinds: 1, recurred: 0, unsettled: 0 });
});
