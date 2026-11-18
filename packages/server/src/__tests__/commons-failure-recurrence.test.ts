import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService, deriveRuntimeReadiness } from '../services/agent-communication-service';
import { failureRecurrence } from '../services/commons-failure-recurrence';

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
  expect(r).toMatchObject({ windowDays: 14, minN: 30 });
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
