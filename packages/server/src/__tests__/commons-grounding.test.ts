import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { candidateFiles, parseGrounding, pickGroundingTopic, recordCommonsGrounding, validateGrounding } from '../services/commons-grounding';

let db: Database.Database; let root: string;
const env = { ...process.env };
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const park = (id: string, title: string, description: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
  VALUES (?, 'feature', ?, ?, 'r', 'reflection', 'needs_grounding', 0.5, '["reflection:x"]', ?, ?)`).run(id, title, description, new Date().toISOString(), new Date().toISOString());

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-'));
  execFileSync('git', ['init', '-q', root]);
  write('packages/server/src/services/queue-hygiene-service.ts', 'export function sweepZombies() { /* stale runs */ }\n');
  write('packages/server/src/services/other.ts', 'export const unrelated = 1;\n');
  write('packages/server/src/middleware/auth.ts', 'export const sweepZombies = 0;\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  new AgentCommunicationService(db); // creates agent_messages
  process.env.LOOP_REPOSITORY_PATH = root;
});
afterEach(() => { db.close(); process.env = { ...env }; });

it('finds candidate files by distinctive words, never tests or sensitive paths', () => {
  expect(candidateFiles('Make sweepZombies close stale runs', root)).toEqual(['packages/server/src/services/queue-hygiene-service.ts']);
  expect(candidateFiles('xyzzy plugh frobnicate', root)).toEqual([]);
});

it('parses the last TARGET/TEST lines and validates them in code', () => {
  expect(parseGrounding('first TARGET: a.ts\n...\nTARGET: `packages/x.ts`\nTEST: packages/server/src/__tests__/x.test.ts')).toEqual({ target: 'packages/x.ts', test: 'packages/server/src/__tests__/x.test.ts' });
  const target = 'packages/server/src/services/queue-hygiene-service.ts';
  expect(validateGrounding({ target, test: 'packages/server/src/__tests__/queue-hygiene.test.ts' }, root).valid).toBe(true); // new test file is fine
  expect(validateGrounding({ target: 'packages/nope.ts', test: 'x' }, root).reason).toBe('target not found: packages/nope.ts');
  expect(validateGrounding({ target: 'packages/server/src/middleware/auth.ts', test: 'packages/server/src/__tests__/a.test.ts' }, root).valid).toBe(false);
  expect(validateGrounding({ target: '../../etc/passwd', test: 'x' }, root).valid).toBe(false);
  expect(validateGrounding({ target, test: 'scripts/run.sh' }, root).valid).toBe(false);
  expect(validateGrounding({ target: 'none' }, root).reason).toBe('no target');
});

it('picks a parked proposal the code search can place, once, and skips ones triaged as another system', () => {
  park('p-kb', 'DjimitKBWiki provenance graph', 'Add sweepZombies-like cleanup to the wiki');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j', 'reflection_triage', 'self_improvement', 'p-kb', 'h', 'shadow', 'no', 'jev=other_system conf=0.90', ?)`).run(new Date().toISOString());
  park('p-1', 'Close orphaned runs', 'sweepZombies should close stale running runs');
  const t = pickGroundingTopic(db, root)!;
  expect(t.topicRef).toBe('proposal:p-1');
  expect(t.evidence).toEqual(['proposal:p-1', 'file:packages/server/src/services/queue-hygiene-service.ts']);
  expect(t.contexts[0]).toContain('TARGET: <repo path>');
});

it('records a grounding in shadow; with COMMONS_GROUNDING_APPLY a valid one becomes one grounded refinement for the panel', () => {
  park('p-1', 'Close orphaned runs', 'sweepZombies should close stale running runs');
  const text = 'Belongs in the reaper.\nTARGET: packages/server/src/services/queue-hygiene-service.ts\nTEST: packages/server/src/__tests__/zombie-reaper.test.ts';
  expect(recordCommonsGrounding(db, 'p-1', 'm1', text, root)).toEqual({ valid: true, refinementId: null });
  expect(db.prepare("SELECT mode, decision FROM judgments WHERE judgment = 'commons_grounding'").get()).toEqual({ mode: 'shadow', decision: 'yes' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 1 });

  process.env.COMMONS_GROUNDING_APPLY = 'true';
  const { refinementId } = recordCommonsGrounding(db, 'p-1', 'm2', text, root);
  const r = db.prepare('SELECT status, source, panel_id, grounding_json, refined_from_id FROM self_improvements WHERE id = ?').get(refinementId) as Record<string, string>;
  expect(r).toMatchObject({ status: 'proposed', source: 'refinement', refined_from_id: 'p-1' });
  expect(r.panel_id).toBeTruthy();
  expect(JSON.parse(r.grounding_json)).toMatchObject({ target: 'packages/server/src/services/queue-hygiene-service.ts', acceptanceTest: 'packages/server/src/__tests__/zombie-reaper.test.ts', derived: false });
  expect(recordCommonsGrounding(db, 'p-1', 'm3', text, root).refinementId).toBeNull(); // one refinement per original
});

it('end to end: a grounding round asks for TARGET/TEST and its learning makes no new proposal', () => {
  process.env.COMMONS_AGENDA_GROUNDING = 'true';
  park('p-1', 'Close orphaned runs', 'sweepZombies should close stale running runs');
  db.prepare(`INSERT INTO agents (id, name, description, status, capabilities) VALUES ('agent-a', 'A', 'a', 'active', '["security"]'), ('agent-b', 'B', 'b', 'active', '["ux"]')`).run();
  const comms = new AgentCommunicationService(db);
  comms.heartbeat('agent-a', 'codex', 'm'); comms.heartbeat('agent-b', 'opencode', 'm');
  expect(comms.socialize(0).topic).toBe('Ground parked proposal: Close orphaned runs');
  const [q] = comms.receiveSocial('agent-b');
  expect(q.payload.context).toContain('TARGET: <repo path>');
  const reply = { answer: 'The reaper. TARGET: packages/server/src/services/queue-hygiene-service.ts', uncertainty: 'u', falsifiable_next_step: 'TEST: packages/server/src/__tests__/zombie-reaper.test.ts',
    creative_alternative: 'c', stop_condition: 's', runtime: 'opencode', ecosystem_component: 'Djimitflo', proposed_improvement: 'Reap orphaned runs.', delivery_lease_token: q.deliveryLeaseToken };
  const response = comms.respondSocial('agent-b', q.id, reply);
  const peer = comms.receiveSocial('agent-a').find((m) => m.id === response.message.id)!;
  const learning = comms.respondSocial('agent-a', peer.id, { ...reply, delivery_lease_token: peer.deliveryLeaseToken });
  expect(learning.message.payload.params.improvement_id).toBe('p-1');
  expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 1 }); // no proposal about the proposal
  expect(db.prepare("SELECT decision FROM judgments WHERE judgment = 'commons_grounding'").get()).toEqual({ decision: 'yes' });
  // G10i: reputation from outcomes, per agent
  expect(comms.listSocialCommons().stats?.guild).toEqual([{ agent: 'agent-a', groundings: 1, valid: 1, verified: 0 }]);
});

it('failure and grounding topics alternate, so a failure backlog cannot starve grounding', () => {
  process.env.COMMONS_AGENDA_GROUNDING = 'true'; process.env.COMMONS_AGENDA_FROM_FAILURES = 'true';
  park('p-1', 'Close orphaned runs', 'sweepZombies should close stale running runs');
  const now = new Date().toISOString();
  for (const id of ['r1', 'r2']) {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
      .run(id, JSON.stringify([{ name: id === 'r1' ? 'checker_verdict' : 'maker_completion', status: 'fail' }]), now, now);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'failure_cause', 'loop_run', ?, 'h', 'shadow', 'yes', 'cause=infra conf=0.9 platform_fault=0.9', ?)`).run(`j-${id}`, id, now);
  }
  db.prepare(`INSERT INTO agents (id, name, description, status, capabilities) VALUES ('agent-a', 'A', 'a', 'active', '["security"]'), ('agent-b', 'B', 'b', 'active', '["ux"]')`).run();
  const comms = new AgentCommunicationService(db);
  comms.heartbeat('agent-a', 'codex', 'm'); comms.heartbeat('agent-b', 'opencode', 'm');
  const refs = [0, 1, 2].map(() => comms.socialize(0).messages[0].payload.params.topic_ref as string);
  expect(refs.map((r) => r.split(':')[0])).toEqual(['run', 'proposal', 'run']);
});
