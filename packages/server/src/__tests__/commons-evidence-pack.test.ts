import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { buildEvidencePack } from '../services/commons-evidence-pack';
import { createTestDb } from './helpers/test-db';

let db: Database.Database;
const now = () => new Date().toISOString();
beforeEach(() => {
  db = createTestDb();
  // the helper schema predates the judgments migration; the pack only needs these columns
  db.exec('CREATE TABLE IF NOT EXISTS judgments (id TEXT PRIMARY KEY, judgment TEXT, subject_type TEXT, subject_id TEXT, state_hash TEXT, mode TEXT, decision TEXT, reason TEXT, created_at TEXT)');
  db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"security\"]'), ('agent-b', 'Agent B', 'active', '[\"ux\"]')").run();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r1', 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
    .run(JSON.stringify([{ name: 'checker_verdict', status: 'fail' }, { name: 'tests', status: 'pass' }]), now(), now());
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'failure_cause', 'loop_run', 'r1', 'h', 'shadow', 'yes', 'cause=parse_error conf=0.90 platform_fault=0.80', ?)`).run(now());
});
afterEach(() => { delete process.env.COMMONS_EVIDENCE_PACK_ENABLED; db.close(); });

it('summarises runs, failing gates and failure causes without raw content', () => {
  const pack = buildEvidencePack(db);
  expect(pack.loop_runs).toEqual({ blocked: 1 });
  expect(pack.top_failing_gates).toEqual([{ gate: 'checker_verdict', n: 1 }]);
  expect(pack.failure_causes).toEqual([{ cause: 'parse_error', n: 1 }]);
});

it('a Commons round carries the pack only when enabled', () => {
  const comms = new AgentCommunicationService(db);
  comms.heartbeat('agent-a', 'codex', 'm'); comms.heartbeat('agent-b', 'opencode', 'm');
  expect(comms.socialize(0).messages[0].payload.params.evidence_pack).toBeUndefined();
  process.env.COMMONS_EVIDENCE_PACK_ENABLED = 'true';
  const pack = comms.socialize(0).messages[0].payload.params.evidence_pack as { top_failing_gates: unknown[] };
  expect(pack.top_failing_gates).toEqual([{ gate: 'checker_verdict', n: 1 }]);
});
