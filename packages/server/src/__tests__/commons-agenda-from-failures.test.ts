import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { createTestDb } from './helpers/test-db';

let db: Database.Database;
const now = () => new Date().toISOString();
beforeEach(() => {
  db = createTestDb();
  db.exec('CREATE TABLE IF NOT EXISTS judgments (id TEXT PRIMARY KEY, judgment TEXT, subject_type TEXT, subject_id TEXT, state_hash TEXT, mode TEXT, decision TEXT, reason TEXT, created_at TEXT)');
  db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"security\"]'), ('agent-b', 'Agent B', 'active', '[\"ux\"]')").run();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r1', 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
    .run(JSON.stringify([{ name: 'checker_verdict', status: 'fail', evidence: 'insufficient_evidence' }]), now(), now());
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'failure_cause', 'loop_run', 'r1', 'h', 'shadow', 'yes', 'cause=parse_error conf=0.90 platform_fault=0.80', ?)").run(now());
});
afterEach(() => { delete process.env.COMMONS_AGENDA_FROM_FAILURES; db.close(); });

it('with the flag on, an undiscussed dream-state failure becomes the next topic, once', () => {
  const comms = new AgentCommunicationService(db);
  comms.heartbeat('agent-a', 'codex', 'm'); comms.heartbeat('agent-b', 'opencode', 'm');
  expect(comms.socialize(0).messages[0].payload.params.topic_ref).not.toBe('run:r1'); // off by default
  process.env.COMMONS_AGENDA_FROM_FAILURES = 'true';
  const round = comms.socialize(0);
  expect(round.messages[0].payload.params.topic_ref).toBe('run:r1');
  expect(round.topic).toContain('cause=parse_error');
  expect(round.topic).toContain('checker_verdict: insufficient_evidence');
  expect(comms.socialize(0).messages[0].payload.params.topic_ref).not.toBe('run:r1'); // discussed once
});
