import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createSwarmOrchestrationRoutes } from '../routes/swarm-orchestration';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import {
  EVIDENCE_ROOM_AUTHOR, parseArtefact, replyToEvidenceRoom, sweepEvidenceRoom,
} from '../services/commons-evidence-room';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const ON = { COMMONS_EVIDENCE_ROOM_MODE: 'on' } as NodeJS.ProcessEnv;
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
let db: Database.Database;
const iso = (t: number) => new Date(t).toISOString();
const rows = (thread: string) => db.prepare("SELECT from_agent, payload_json FROM agent_messages WHERE json_extract(payload_json, '$.thread_id') = ? ORDER BY timestamp, rowid").all(thread)
  .map((r: any) => ({ from: r.from_agent as string, payload: JSON.parse(r.payload_json) }));

function seedRun(id: string, opts: { success: number; outcomeClass?: string; objective?: string; prUrl?: string; prOutcome?: unknown; status?: string; twice?: boolean } ) {
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, grounding_json) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', 'verified', ?)")
    .run(`si-${id}`, JSON.stringify({ target: 'packages/server/src/services/foo.ts' }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES (?, ?, 'low', 'completed', ?)").run(`g-${id}`, opts.objective ?? 'Add a test for foo', `si-${id}`);
  const meta = { ...(opts.prUrl ? { pr_url: opts.prUrl } : {}), ...(opts.prOutcome ? { pr_outcome: opts.prOutcome } : {}) };
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at) VALUES (?, ?, 'test-gap', 'closed', ?, ?, ?, ?)")
    .run(id, `g-${id}`, opts.status ?? 'completed', JSON.stringify([{ name: 'tests_lint_typecheck', status: opts.success ? 'pass' : 'fail' }]), JSON.stringify(meta), iso(NOW - 20 * DAY));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'completed', ?)")
    .run(`m-${id}`, id, JSON.stringify({ model: 'qwen', effective_runtime: 'claude', effective_model: 'sonnet', deterministic_checks: [{ name: 'test', exit_status: opts.success ? 0 : 1 }], graded: { score: 0.667, kind: 'mutant_kill', ms: 1 } }));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'checker', 'codex', 'completed', ?)")
    .run(`c-${id}`, id, JSON.stringify({ verdict: opts.success ? 'accepted' : 'rejected', maker_lease_id: `m-${id}` }));
  const refs = JSON.stringify([`loop_run:${id}`, ...(opts.outcomeClass ? [`outcome_class:${opts.outcomeClass}`] : [])]);
  for (let i = 0; i < (opts.twice ? 2 : 1); i++) {
    db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap:claude', ?, 'test-gap', ?, ?, ?, ?)")
      .run(`o-${id}-${i}`, opts.success, id, `m-${id}`, refs, iso(NOW - 20 * DAY));
  }
}

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.exec(`CREATE TABLE IF NOT EXISTS skill_outcomes (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, domain TEXT NOT NULL DEFAULT '', task_id TEXT, agent_id TEXT, model TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
});
afterEach(() => db.close());

describe('Commons evidence room', () => {
  it('is a registered, non-acting evolution flag', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'COMMONS_EVIDENCE_ROOM_MODE', acting: false });
  });

  it('mode off creates nothing and refuses replies', () => {
    seedRun('r1', { success: 1 });
    expect(sweepEvidenceRoom(db, NOW, {})).toEqual({ mode: 'off', threads: 0, survival_posts: 0 });
    new AgentCommunicationService(db);
    expect((db.prepare('SELECT COUNT(*) n FROM agent_messages').get() as { n: number }).n).toBe(0);
    expect(() => replyToEvidenceRoom(db, 'evidence-room:r1', 'operator:x', { text: 'hi' }, {})).toThrow('EVIDENCE_ROOM_OFF');
  });

  it('opens exactly one thread per verified run with a structured summary from durable records (idempotent)', () => {
    seedRun('r1', { success: 1, twice: true, prUrl: 'https://github.com/djimit/djimitflo/pull/901' });
    expect(sweepEvidenceRoom(db, NOW, ON).threads).toBe(1);
    expect(sweepEvidenceRoom(db, NOW, ON).threads).toBe(0);
    const msgs = rows('evidence-room:r1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe(EVIDENCE_ROOM_AUTHOR);
    const s = msgs[0].payload.params.summary;
    expect(s).toMatchObject({
      run_id: 'r1', outcome: 'verified', lane: 'test-gap', target_file: 'packages/server/src/services/foo.ts',
      maker: { species: 'loop-maker:test-gap:claude', requested_runtime: 'opencode', effective_runtime: 'claude', model: 'sonnet' },
      deterministic_checks: [{ name: 'test', exit_status: 0, passed: true, reason: null }],
      graded: { score: 0.667, kind: 'mutant_kill' }, reviewers: [{ role: 'checker', runtime: 'codex', verdict: 'accepted' }],
      pr_url: 'https://github.com/djimit/djimitflo/pull/901',
    });
    expect(msgs[0].payload.context).toContain('Merge survival (14 d): pending');
  });

  it('opens a regression thread, but not for infra failures or non-terminal runs', () => {
    seedRun('reg', { success: 0, outcomeClass: 'regressed' });
    seedRun('infra', { success: 0, outcomeClass: 'infra_failed' });
    seedRun('live', { success: 1, status: 'running' });
    expect(sweepEvidenceRoom(db, NOW, ON).threads).toBe(1);
    const [root] = rows('evidence-room:reg');
    expect(root.payload.params.summary).toMatchObject({ outcome: 'regressed', pr_url: null, reviewers: [{ verdict: 'rejected' }] });
    expect(root.payload.params.summary.unknown.pr_url).toMatch(/no draft PR/);
    expect(rows('evidence-room:infra')).toHaveLength(0);
    expect(rows('evidence-room:live')).toHaveLength(0);
  });

  it('appends the 14-day merge-survival result once, when it settles', () => {
    const merged = NOW - 16 * DAY;
    seedRun('r1', { success: 1, prUrl: 'https://github.com/djimit/djimitflo/pull/902', prOutcome: { state: 'merged', merged_at: iso(merged), checked_at: iso(NOW - DAY) } });
    sweepEvidenceRoom(db, NOW, ON);
    expect(rows('evidence-room:r1')).toHaveLength(1); // merged, survival pending: no follow-up
    db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_outcome', json(?)) WHERE id = 'r1'")
      .run(JSON.stringify({ state: 'merged', merged_at: iso(merged), survived: true, settled_at: iso(merged + 15 * DAY), checked_at: iso(NOW) }));
    expect(sweepEvidenceRoom(db, NOW, ON).survival_posts).toBe(1);
    expect(sweepEvidenceRoom(db, NOW, ON).survival_posts).toBe(0);
    const msgs = rows('evidence-room:r1');
    expect(msgs).toHaveLength(2);
    expect(msgs[1].payload.params).toMatchObject({ evidence_room_kind: 'survival', survival: { state: 'SETTLED_SURVIVED', survived: true } });
  });

  it('redacts secrets in every posted field and in replies', () => {
    seedRun('r1', { success: 1, objective: `Rotate token ${SECRET} now` });
    sweepEvidenceRoom(db, NOW, ON);
    const raw = (db.prepare('SELECT payload_json FROM agent_messages').get() as { payload_json: string }).payload_json;
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('[REDACTED:GitHub PAT]');
    const r = replyToEvidenceRoom(db, 'evidence-room:r1', 'operator:u1', { text: `see ${SECRET}`, artefact: { kind: 'repro', command: `curl -H "x: ${SECRET}" localhost` } }, ON);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const all = (db.prepare('SELECT group_concat(payload_json) AS j FROM agent_messages').get() as { j: string }).j;
    expect(all).not.toContain(SECRET);
  });

  it('types replies: an executable artefact is evidence, plain text is flagged unverified', () => {
    seedRun('r1', { success: 1 });
    sweepEvidenceRoom(db, NOW, ON);
    const withTest = replyToEvidenceRoom(db, 'evidence-room:r1', 'agent-a', { text: 'reproduces', artefact: { kind: 'test', test_file: 'packages/server/src/__tests__/foo.test.ts', command: 'npx vitest run src/__tests__/foo.test.ts' } }, ON);
    expect(withTest).toMatchObject({ evidence_status: 'artefact', artefact: { kind: 'test', test_file: 'packages/server/src/__tests__/foo.test.ts' } });
    const repro = replyToEvidenceRoom(db, 'evidence-room:r1', 'operator:u1', { artefact: { kind: 'repro', command: 'npm run test -w packages/server' } }, ON);
    expect(repro.evidence_status).toBe('artefact');
    const plain = replyToEvidenceRoom(db, 'evidence-room:r1', 'agent-b', { text: 'I think this is fine' }, ON);
    expect(plain).toMatchObject({ evidence_status: 'unverified', artefact: null });
    expect(() => parseArtefact({ kind: 'test', test_file: '../etc/passwd', command: 'cat' })).toThrow('EVIDENCE_ARTEFACT_TEST_FILE_INVALID');
    expect(() => parseArtefact({ kind: 'test', test_file: 'a/b.test.ts' })).toThrow('EVIDENCE_ARTEFACT_COMMAND_REQUIRED');
    expect(() => parseArtefact({ kind: 'vibes', command: 'x' })).toThrow('EVIDENCE_ARTEFACT_KIND_INVALID');
    expect(() => replyToEvidenceRoom(db, 'evidence-room:nope', 'agent-a', { text: 'x' }, ON)).toThrow('EVIDENCE_ROOM_THREAD_NOT_FOUND');
    expect(() => replyToEvidenceRoom(db, 'evidence-room:r1', 'agent-a', {}, ON)).toThrow('EVIDENCE_REPLY_TEXT_REQUIRED');

    const thread = new AgentCommunicationService(db).listSocialCommons(10).threads.find((t) => t.id === 'evidence-room:r1');
    expect(thread?.messages.map((m) => m.evidence_status ?? null)).toEqual([null, 'artefact', 'artefact', 'unverified']);
  });

  it('evidence-room threads neither delay a Commons round nor count in the Commons stats', () => {
    seedRun('r1', { success: 1 });
    sweepEvidenceRoom(db, NOW, ON);
    expect(new AgentCommunicationService(db).commonsStats()?.threads_7d ?? 0).toBe(0);
  });

  it('operator reply route stores a typed reply as operator:<sub> (404 while off)', async () => {
    seedRun('r1', { success: 1 });
    sweepEvidenceRoom(db, NOW, ON);
    const auth = { requirePermission: () => (req: any, _res: any, next: any) => { req.user = { sub: 'op-1' }; next(); } } as any;
    const app = express().use(express.json()).use('/swarm-v2', createSwarmOrchestrationRoutes(db, auth));
    const url = '/swarm-v2/social/evidence-room/evidence-room%3Ar1/replies';
    expect((await request(app).post(url).send({ text: 'x' })).status).toBe(404);
    process.env.COMMONS_EVIDENCE_ROOM_MODE = 'on';
    try {
      const ok = await request(app).post(url).send({ text: 'repro', artefact: { kind: 'repro', command: 'npm test' } });
      expect(ok.status).toBe(201);
      expect(ok.body.evidence_status).toBe('artefact');
      expect(rows('evidence-room:r1').at(-1)?.from).toBe('operator:op-1');
      expect((await request(app).post(url).send({ artefact: { kind: 'test', test_file: '/abs.test.ts', command: 'x' } })).status).toBe(400);
    } finally { delete process.env.COMMONS_EVIDENCE_ROOM_MODE; }
  });
});
