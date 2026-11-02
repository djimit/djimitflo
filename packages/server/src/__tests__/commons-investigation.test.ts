import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentLureService } from '../services/agent-lure-service';
import { AgentCommonsOpenDoorService } from '../services/agent-commons-open-door-service';
import { extractReply } from '../services/agent-social-autopilot-service';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { listSubmissions } from '../services/commons-falsifier';
import {
  INVESTIGATION_OUTCOME_AUTHOR, buildInvestigationEvidence, investigationMode, parseInvestigationArtefact, sweepInvestigationOutcomes,
} from '../services/commons-investigation';

const env = { ...process.env };
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
const TARGET = 'packages/server/src/services/queue-hygiene.ts';
const TEST = 'packages/server/src/__tests__/queue-hygiene.test.ts';
let db: Database.Database; let root: string; let base: string;
const now = () => new Date().toISOString();
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const judgments = (kind: string) => db.prepare('SELECT * FROM judgments WHERE judgment = ? ORDER BY created_at, rowid').all(kind) as Array<Record<string, any>>;
const thread = (id: string) => db.prepare("SELECT from_agent, to_agent, status, payload_json FROM agent_messages WHERE json_extract(payload_json, '$.thread_id') = ? ORDER BY timestamp, rowid").all(id)
  .map((r: any) => ({ from: r.from_agent as string, to: r.to_agent as string, status: r.status as string, payload: JSON.parse(r.payload_json) }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'investigation-'));
  execFileSync('git', ['init', '-q', root]);
  write(TARGET, [
    "import { other } from './other';",
    '',
    '/** Closes runs that stopped heart-beating. */',
    'export function sweepZombies(limit: number): number {',
    `  const token = '${SECRET}';`,
    '  return Math.min(limit, other(token.length));',
    '}',
    '',
    'export const unrelatedHelper = 1;',
  ].join('\n'));
  write('packages/server/src/services/other.ts', 'export const other = (n: number) => n;\n');
  write(TEST, "import { expect, it } from 'vitest';\nimport { sweepZombies } from '../services/queue-hygiene';\nit('caps', () => { expect(sweepZombies(1)).toBe(1); });\n");
  git('add', '.'); git('commit', '-q', '-m', 'init');
  base = git('rev-parse', 'HEAD');
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.exec(`CREATE TABLE IF NOT EXISTS skill_outcomes (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, domain TEXT NOT NULL DEFAULT '', task_id TEXT, agent_id TEXT, model TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO agents (id, name, description, status, capabilities) VALUES ('agent-a', 'Agent A', 'a', 'active', '[\"security\"]'), ('agent-b', 'Agent B', 'b', 'active', '[\"ux\"]')").run();
  process.env.LOOP_REPOSITORY_PATH = root;
  process.env.LOOP_DAEMON_REPOSITORY_PATH = root;
  delete process.env.COMMONS_INVESTIGATION_MODE;
  delete process.env.COMMONS_EVIDENCE_PACK_ENABLED;
  delete process.env.DJIMITFLO_COMMIT_SHA;
});
afterEach(() => { db.close(); process.env = { ...env }; fs.rmSync(root, { recursive: true, force: true }); });

/** A blocked run of a grounded proposal, its maker's recorded checks (at `sha`) and a failure_cause judgment. */
function seedRun(opts: { sha?: string | null; grounding?: Record<string, string> | null; refs?: string[] } = {}) {
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json) VALUES ('si-1', 'test', 'Zombie sweep', 'sweepZombies leaves runs', 'r', 'gap_analysis', 'regressed', ?, ?)")
    .run(JSON.stringify(opts.refs ?? []), opts.grounding === null ? null : JSON.stringify(opts.grounding ?? { target: TARGET, acceptanceTest: TEST }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g-1', 'Fix zombie sweep', 'low', 'failed', 'si-1')").run();
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r1', 'g-1', 'test-gap', 'closed', 'blocked', ?, ?, ?)")
    .run(JSON.stringify([{ name: 'tests_lint_typecheck', status: 'fail', evidence: 'exit 1' }]), now(), now());
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('m-1', 'r1', 'maker', 'opencode', 'failed', ?)")
    .run(JSON.stringify({ deterministic_checks: [{ name: 'test', status: 'fail', exit_status: 1 }, { name: 'lint', status: 'pass', exit_status: 0 }],
      ...(opts.sha === null ? {} : { evidence_read_set: { base: opts.sha ?? base, files: {} } }) }));
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'failure_cause', 'loop_run', 'r1', 'h', 'shadow', 'yes', 'cause=test_failure conf=0.90', ?)").run(now());
}

function round() {
  const comms = new AgentCommunicationService(db);
  comms.heartbeat('agent-a', 'codex', 'm', 'runtime_token'); comms.heartbeat('agent-b', 'opencode', 'm', 'runtime_token');
  process.env.COMMONS_AGENDA_FROM_FAILURES = 'true';
  return { comms, result: comms.socialize(0) };
}
const reply = (input: Record<string, unknown>) => ({ uncertainty: 'u', falsifiable_next_step: 'run it', creative_alternative: 'c', stop_condition: 's', runtime: 'opencode', model_id: 'm', ...input }) as never;

describe('COMMONS_INVESTIGATION_MODE', () => {
  it('is off by default, parses shadow/on, and is a registered non-acting flag', () => {
    expect(investigationMode({})).toBe('off');
    expect(investigationMode({ COMMONS_INVESTIGATION_MODE: 'yes' })).toBe('off');
    expect(investigationMode({ COMMONS_INVESTIGATION_MODE: 'shadow' })).toBe('shadow');
    expect(investigationMode({ COMMONS_INVESTIGATION_MODE: 'on' })).toBe('on');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'COMMONS_INVESTIGATION_MODE', acting: false });
  });

  it('off: no judgment rows, no extra params, the sweep writes nothing, the falsifier sees no investigation replies', () => {
    seedRun();
    const { result } = round();
    expect(result.messages[0].payload.params.investigation).toBeUndefined();
    expect(judgments('commons_investigation_evidence')).toEqual([]);
    expect(sweepInvestigationOutcomes(db, Date.now(), {})).toEqual({ mode: 'off', posted: 0, recorded: 0 });
    expect(listSubmissions(db, Date.now(), { COMMONS_FALSIFIER_AGENTS: '*' })).toEqual([]);
  });
});

describe('AC-04 evidence delivery', () => {
  it('builds revision, path, symbol, bounded redacted excerpt, test, recorded run result and one uncertainty', () => {
    seedRun();
    const ev = buildInvestigationEvidence(db, { topicRef: 'run:r1', topic: 'sweepZombies leaves blocked runs' }, root)!;
    expect(ev.repo).toEqual({ slug: null, revision: base });
    expect(ev.path).toBe(TARGET);
    expect(ev.symbol).toBe('sweepZombies');
    expect(ev.code!.text).toContain('export function sweepZombies');
    expect(ev.code!.text).not.toContain(SECRET); // secret-scrubbed like the panel excerpt
    expect(ev.code!.text.length).toBeLessThanOrEqual(1_200);
    expect(ev.test).toMatchObject({ path: TEST });
    expect(ev.test!.text).toContain('sweepZombies(1)');
    expect(ev.recorded_result).toMatchObject({ run_id: 'r1', run_status: 'blocked', revision: base,
      checks: [{ name: 'test', status: 'fail', exit_status: 1 }, { name: 'lint', status: 'pass', exit_status: 0 }], failed_gates: ['tests_lint_typecheck'] });
    expect(ev.stale).toEqual({ value: false, reason: 'recorded at the current revision' });
    // mechanical grounding (a declared target) is kept apart from executed evidence (the recorded checks)
    expect(ev.grounding.mechanical).toMatchObject({ method: 'proposal_grounding' });
    expect(ev.grounding.executed).toEqual({ run_id: 'r1', checks_executed: 2, checks_failed: 1 });
    expect(typeof ev.uncertainty).toBe('string');
    expect(ev.uncertainty.length).toBeGreaterThan(10);
    expect(ev.unavailable).toEqual({});
    // server-resolved refs, each with provenance
    expect(ev.refs.map((r) => r.ref)).toEqual([`source:${TARGET}@${base.slice(0, 12)}`, `test_source:${TEST}@${base.slice(0, 12)}`, 'loop_run:r1']);
    expect(ev.refs.every((r) => r.provenance.length > 0)).toBe(true);
  });

  it('flags a stale recorded result when the path changed after the recorded revision', () => {
    seedRun();
    write(TARGET, fs.readFileSync(path.join(root, TARGET), 'utf8').replace('Math.min', 'Math.max'));
    git('commit', '-qam', 'change'); // HEAD moved and the target changed since the run's base
    const ev = buildInvestigationEvidence(db, { topicRef: 'run:r1', topic: 'sweepZombies' }, root)!;
    expect(ev.repo.revision).not.toBe(base);
    expect(ev.stale.value).toBe(true);
    expect(ev.stale.reason).toContain(TARGET);
    expect(ev.uncertainty).toContain(base.slice(0, 12)); // the stale recording is the one concrete uncertainty
  });

  it('missing sources are explicit unavailable reasons, never zero or empty values', () => {
    seedRun({ sha: null, grounding: null });
    db.prepare('DELETE FROM worker_leases').run();
    db.prepare("UPDATE loop_runs SET gates_json = '[]'").run();
    const ev = buildInvestigationEvidence(db, { topicRef: 'run:r1', topic: 'x' }, root)!;
    expect(ev.path).toBeNull(); expect(ev.symbol).toBeNull(); expect(ev.code).toBeNull(); expect(ev.test).toBeNull(); expect(ev.recorded_result).toBeNull();
    expect(Object.keys(ev.unavailable).sort()).toEqual(['code', 'path', 'recorded_result', 'symbol', 'test']);
    for (const reason of Object.values(ev.unavailable)) expect(reason.length).toBeGreaterThan(5);
    expect(ev.grounding).toEqual({ mechanical: null, executed: null });
    expect(ev.stale.value).toBeNull();

    const missingRun = buildInvestigationEvidence(db, { topicRef: 'run:nope', topic: 'x' }, root)!;
    expect(missingRun.unavailable.path).toContain('nope');
    expect(buildInvestigationEvidence(db, { topicRef: 'ecosystem:curiosity-seed-1', topic: 'x' }, root)).toBeNull(); // not an investigation topic
  });

  it('a proposal for an unregistered repo is never read from this checkout', () => {
    seedRun({ refs: ['repo:other/repo'] });
    const ev = buildInvestigationEvidence(db, { topicRef: 'run:r1', topic: 'sweepZombies' }, root)!;
    expect(ev.code).toBeNull();
    expect(ev.unavailable.code).toContain('other/repo');
  });

  it('a code-search path is mechanical grounding only, and a sensitive path is unavailable', () => {
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status) VALUES ('p-1', 'feature', 'Close zombies', 'sweepZombies should close stale runs', 'r', 'reflection', 'needs_grounding')").run();
    const ev = buildInvestigationEvidence(db, { topicRef: 'proposal:p-1', topic: 'Ground sweepZombies' }, root)!;
    expect(ev.path).toBe(TARGET);
    expect(ev.grounding.mechanical).toMatchObject({ method: 'code_search' });
    expect(ev.grounding.executed).toBeNull();
    expect(ev.unavailable.recorded_result).toBeTruthy();
    expect(ev.uncertainty).toMatch(/not .*executed|no executed|keyword/i);
    db.prepare("UPDATE self_improvements SET grounding_json = ? WHERE id = 'p-1'").run(JSON.stringify({ target: 'config/secrets.ts', acceptanceTest: TEST }));
    expect(buildInvestigationEvidence(db, { topicRef: 'proposal:p-1', topic: 'x' }, root)!.unavailable.code).toBeTruthy();
  });

  it('shadow records what would be attached and delivers nothing', () => {
    seedRun();
    process.env.COMMONS_INVESTIGATION_MODE = 'shadow';
    const { comms, result } = round();
    expect(result.messages[0].payload.params.investigation).toBeUndefined();
    expect(result.messages[0].payload.evidence).toEqual(['run:r1']);
    const [row] = judgments('commons_investigation_evidence');
    expect(row).toMatchObject({ subject_type: 'social_thread', subject_id: result.correlation_id, mode: 'shadow', decision: 'would_attach' });
    expect(JSON.parse(row.answers_json).evidence.path).toBe(TARGET);
    const [delivered] = comms.receiveSocial(result.participants[1], 1);
    expect(delivered.payload.params.investigation_brief).toBeUndefined();
  });

  it('on attaches the evidence, makes resolved refs citable, and delivers a bounded brief to the runtime', () => {
    seedRun();
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { comms, result } = round();
    const q = result.messages[0];
    expect(q.payload.params.investigation).toMatchObject({ path: TARGET, symbol: 'sweepZombies' });
    expect(q.payload.evidence).toEqual(['run:r1', `source:${TARGET}@${base.slice(0, 12)}`, `test_source:${TEST}@${base.slice(0, 12)}`, 'loop_run:r1']);
    expect(judgments('commons_investigation_evidence')[0]).toMatchObject({ mode: 'on', decision: 'attached' });
    const [delivered] = comms.receiveSocial(q.to, 1);
    const brief = delivered.payload.params.investigation_brief as string;
    expect(brief).toContain(TARGET); expect(brief).toContain('sweepZombies'); expect(brief).toContain('Uncertainty:');
    expect(brief).toContain('mechanical'); expect(brief).toContain('executed');
    expect(brief).not.toContain(SECRET);
    expect(brief.length).toBeLessThanOrEqual(3_000);
    // the whitelist still holds: only refs on the question are kept
    const sent = comms.respondSocial(q.to, delivered.id, reply({ answer: 'a', evidence_refs: [`source:${TARGET}@${base.slice(0, 12)}`, 'source:invented.ts@abc'], delivery_lease_token: delivered.deliveryLeaseToken }));
    expect(sent.message.payload.evidence).toContain(`source:${TARGET}@${base.slice(0, 12)}`);
    expect(sent.message.payload.evidence).not.toContain('source:invented.ts@abc');
  });
});

describe('AC-06 artefact path', () => {
  it('parses the four artefact kinds; sourced kinds must cite a ref on the question', () => {
    const refs = ['loop_run:r1'];
    expect(parseInvestigationArtefact(undefined, refs)).toBeNull();
    expect(parseInvestigationArtefact({ kind: 'repro', command: 'npx vitest run x' }, refs)).toEqual({ kind: 'repro', command: 'npx vitest run x' });
    expect(parseInvestigationArtefact({ kind: 'retrieval_example', query: 'which run failed', source_ref: 'loop_run:r1', label: 'relevant' }, refs))
      .toEqual({ kind: 'retrieval_example', query: 'which run failed', source_ref: 'loop_run:r1', label: 'relevant' });
    expect(parseInvestigationArtefact({ kind: 'correction', claim: 'tests pass', correction: 'the test check exited 1', source_ref: 'loop_run:r1' }, refs))
      .toMatchObject({ kind: 'correction' });
    expect(() => parseInvestigationArtefact({ kind: 'correction', claim: 'a', correction: 'b', source_ref: 'loop_run:other' }, refs)).toThrow('INVESTIGATION_ARTEFACT_SOURCE_NOT_ALLOWED');
    expect(() => parseInvestigationArtefact({ kind: 'retrieval_example', query: 'q', source_ref: 'loop_run:r1', label: 'maybe' }, refs)).toThrow('INVESTIGATION_ARTEFACT_LABEL_INVALID');
    expect(() => parseInvestigationArtefact({ kind: 'shell', command: 'rm -rf /' }, refs)).toThrow();
  });

  it('on: an eligible reply with an artefact is recorded as an artefact, plain text stays unverified, an invalid artefact is unverified with its reason', () => {
    seedRun();
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { comms, result } = round();
    const [q1, q2] = result.messages;
    const d1 = comms.receiveSocial(q1.to, 1)[0];
    const withArtefact = comms.respondSocial(q1.to, d1.id, reply({ answer: 'the test check failed', delivery_lease_token: d1.deliveryLeaseToken,
      artefact: { kind: 'correction', claim: 'tests pass', correction: 'test exited 1', source_ref: 'loop_run:r1' } }));
    expect(withArtefact.message.payload.params).toMatchObject({ evidence_status: 'artefact', artefact: { kind: 'correction', source_ref: 'loop_run:r1' }, artefact_origin: 'investigation' });
    expect(withArtefact.message.payload.evidence).toContain('artefact:correction');
    const d2 = comms.receiveSocial(q2.to, 1)[0];
    const plain = comms.respondSocial(q2.to, d2.id, reply({ answer: 'probably fine', delivery_lease_token: d2.deliveryLeaseToken,
      artefact: { kind: 'correction', claim: 'a', correction: 'b', source_ref: 'loop_run:invented' } }));
    expect(plain.message.payload.params).toMatchObject({ evidence_status: 'unverified', artefact: null, artefact_rejected: 'INVESTIGATION_ARTEFACT_SOURCE_NOT_ALLOWED' });
    expect(judgments('commons_investigation_artefact').map((j) => [j.mode, j.decision])).toEqual([['on', 'artefact'], ['on', 'unverified']]);
    // the Commons detail view already shows evidence_status / artefact
    const view = comms.listSocialCommons(5).threads[0].messages.find((m) => m.id === withArtefact.message.id)!;
    expect(view).toMatchObject({ evidence_status: 'artefact', artefact: { kind: 'correction' } });
  });

  it('shadow: the reply is stored exactly as off would, the would-be classification is a judgment row', () => {
    seedRun();
    process.env.COMMONS_INVESTIGATION_MODE = 'shadow';
    const { comms, result } = round();
    const d = comms.receiveSocial(result.messages[0].to, 1)[0];
    const sent = comms.respondSocial(result.messages[0].to, d.id, reply({ answer: 'repro attached', delivery_lease_token: d.deliveryLeaseToken, artefact: { kind: 'repro', command: 'npx vitest run queue-hygiene' } }));
    expect(sent.message.payload.params.evidence_status).toBeUndefined();
    expect(sent.message.payload.params.artefact).toBeUndefined();
    expect(judgments('commons_investigation_artefact')).toMatchObject([{ subject_id: sent.message.id, mode: 'shadow', decision: 'artefact' }]);
  });

  it('a non-investigation thread is untouched in on mode', () => {
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { comms, result } = round(); // no run: curiosity seed topic
    expect(result.messages[0].payload.params.investigation).toBeUndefined();
    const d = comms.receiveSocial(result.messages[0].to, 1)[0];
    const sent = comms.respondSocial(result.messages[0].to, d.id, reply({ answer: 'x', delivery_lease_token: d.deliveryLeaseToken, artefact: { kind: 'repro', command: 'ls' } }));
    expect(sent.message.payload.params.evidence_status).toBeUndefined();
    expect(judgments('commons_investigation_artefact')).toEqual([]);
  });

  it('a test artefact in an investigation thread reaches the falsifier queue, still behind its own agent allowlist', () => {
    seedRun();
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { comms, result } = round();
    const q = result.messages[0];
    const d = comms.receiveSocial(q.to, 1)[0];
    const content = "import { expect, it } from 'vitest';\nimport { sweepZombies } from '../services/queue-hygiene';\nit('red', () => { expect(sweepZombies(0)).toBe(1); });\n";
    comms.respondSocial(q.to, d.id, reply({ answer: 'failing test', delivery_lease_token: d.deliveryLeaseToken,
      artefact: { kind: 'test', test_file: 'packages/server/src/__tests__/zombie-red.test.ts', command: 'npx vitest run', content } }));
    const on = { COMMONS_INVESTIGATION_MODE: 'on' } as NodeJS.ProcessEnv;
    expect(listSubmissions(db, Date.now(), on)).toEqual([]); // COMMONS_FALSIFIER_AGENTS unset admits none
    expect(listSubmissions(db, Date.now(), { ...on, COMMONS_FALSIFIER_AGENTS: q.to })).toMatchObject([{ agent: q.to, test_file: 'packages/server/src/__tests__/zombie-red.test.ts' }]);
    expect(listSubmissions(db, Date.now(), { COMMONS_FALSIFIER_AGENTS: q.to })).toEqual([]); // investigation off: not a submission
  });

  it('runtimes can send the artefact: the resident reply parser keeps it and the agent card documents it in on mode only', () => {
    const r = extractReply(JSON.stringify({ answer: 'a', uncertainty: 'u', falsifiable_next_step: 'f', creative_alternative: 'c', stop_condition: 's', artefact: { kind: 'repro', command: 'x' } }));
    expect((r as unknown as { artefact: unknown }).artefact).toEqual({ kind: 'repro', command: 'x' });
    const card = () => new AgentCommonsOpenDoorService(db, new AgentLureService(db, new AgentCommunicationService(db))).agentCard('https://c.example') as { runtime: { reply_schema: Record<string, unknown> } };
    expect(card().runtime.reply_schema.artefact).toBeUndefined();
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    expect(String(card().runtime.reply_schema.artefact)).toContain('retrieval_example');
  });
});

describe('AC-07 close the loop', () => {
  /** A finished round whose learning created a Commons-originated proposal; returns its thread and proposal id. */
  function originate() {
    seedRun();
    const { comms, result } = round();
    const d = comms.receiveSocial(result.messages[0].to, 1)[0];
    comms.respondSocial(result.messages[0].to, d.id, reply({ answer: 'the sweep skips blocked runs', delivery_lease_token: d.deliveryLeaseToken }));
    const peer = comms.receiveSocial(result.messages[0].from, 4).find((m) => m.payload.action === 'social.response')!;
    const learning = comms.respondSocial(result.messages[0].from, peer.id, reply({ answer: 'agreed', ecosystem_component: 'Djimitflo', proposed_improvement: 'Make sweepZombies close blocked runs', delivery_lease_token: peer.deliveryLeaseToken }));
    return { threadId: result.correlation_id!, improvementId: learning.message.payload.params.improvement_id as string };
  }
  function progress(improvementId: string) {
    db.prepare("INSERT INTO specialist_panels (id, topic, question, status, risk_class, consensus_json) VALUES ('panel-1', 't', 'q', 'goal_created', 'low', ?)")
      .run(JSON.stringify({ decision: 'goal', consensus_level: 'strong', support_count: 3, oppose_count: 0, needs_evidence_count: 1, submitted_reviews: 4, required_reviews: 4 }));
    db.prepare("UPDATE self_improvements SET panel_id = 'panel-1', status = 'verified' WHERE id = ?").run(improvementId);
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g-2', 'Close blocked zombies', 'low', 'completed', ?)").run(improvementId);
    const created = new Date(Date.now() - 20 * 86_400_000).toISOString();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES ('r2', 'g-2', 'test-gap', 'closed', 'completed', '[]', ?, ?, ?)")
      .run(JSON.stringify({ pr_url: 'https://github.com/djimit/djimitflo/pull/1', pr_outcome: { state: 'merged', merged_at: created, checked_at: now(), settled_at: now(), survived: true, retained: 1 } }), created, created);
  }

  it('shadow records each would-be update once and posts nothing', () => {
    process.env.COMMONS_INVESTIGATION_MODE = 'shadow';
    const { threadId, improvementId } = originate();
    progress(improvementId);
    const before = thread(threadId).length;
    const first = sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'shadow' });
    expect(first.posted).toBe(0);
    expect(first.recorded).toBe(5);
    expect(thread(threadId).length).toBe(before);
    const kinds = judgments('commons_investigation_outcome').map((j) => JSON.parse(j.answers_json).kind).sort();
    expect(kinds).toEqual(['goal', 'panel_decision', 'run_outcome', 'survival', 'verification']);
    expect(sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'shadow' }).recorded).toBe(0); // idempotent
  });

  it('on posts one structured update per milestone into the original thread, from records only, idempotent', () => {
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { threadId, improvementId } = originate();
    progress(improvementId);
    const r = sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'on' });
    expect(r.posted).toBe(5);
    const posts = thread(threadId).filter((m) => m.from === INVESTIGATION_OUTCOME_AUTHOR);
    expect(posts).toHaveLength(r.posted);
    expect(posts.every((p) => p.to === 'commons' && p.status === 'read' && p.payload.epistemic_role === 'outcome' && p.payload.evidence.includes(`improvement:${improvementId}`))).toBe(true);
    const byKind = Object.fromEntries(posts.map((p) => [p.payload.params.commons_outcome_kind, p.payload.params.outcome]));
    expect(byKind.panel_decision).toMatchObject({ improvement_id: improvementId, record: { panel_id: 'panel-1', decision: 'goal', support_count: 3 } });
    expect(byKind.goal).toMatchObject({ record: { goal_id: 'g-2' } });
    expect(byKind.run_outcome).toMatchObject({ record: { run_id: 'r2', status: 'completed', failure_class: null } });
    expect(byKind.verification).toMatchObject({ record: { status: 'verified' } });
    expect(byKind.survival).toMatchObject({ record: { run_id: 'r2', state: 'SETTLED_SURVIVED', survived: true } });
    expect(sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'on' }).posted).toBe(0); // second sweep: nothing new
    // a metadata touch without a new decision is not a new effect
    db.prepare("UPDATE specialist_panels SET consensus_json = json_set(consensus_json, '$.support_count', 4) WHERE id = 'panel-1'").run();
    expect(sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'on' }).posted).toBe(0);
  });

  it('a technical run failure is labelled technical, not a rejected hypothesis', () => {
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const { threadId, improvementId } = originate();
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g-3', 'o', 'low', 'failed', ?)").run(improvementId);
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r3', 'g-3', 'test-gap', 'closed', 'failed', ?, ?, ?)")
      .run(JSON.stringify([{ name: 'worktree', status: 'fail', evidence: 'WORKTREE_CREATE_FAILED: cannot lock ref' }]), now(), now());
    sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'on' });
    const run = thread(threadId).find((m) => m.payload.params?.commons_outcome_kind === 'run_outcome')!;
    expect(run.payload.params.outcome.record).toMatchObject({ run_id: 'r3', status: 'failed', failure_class: 'technical' });
    expect(run.payload.context).toContain('technical');
  });

  it('a grounding thread on an existing parked proposal is not Commons-originated', () => {
    process.env.COMMONS_INVESTIGATION_MODE = 'on';
    const comms = new AgentCommunicationService(db);
    const q = comms.send({ from: 'agent-a', to: 'agent-b', type: 'question', action: 'social.question', threadId: 'social:g', epistemicRole: 'question', evidence: ['proposal:parked'], params: { topic_ref: 'proposal:parked' } });
    comms.send({ from: 'agent-b', to: 'agent-a', type: 'knowledge', action: 'social.learning', threadId: 'social:g', replyTo: q.id, epistemicRole: 'outcome', evidence: ['proposal:parked'], params: { topic_ref: 'proposal:parked', improvement_id: 'parked' } });
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status) VALUES ('parked', 'f', 't', 'd', 'r', 'reflection', 'verified')").run();
    expect(sweepInvestigationOutcomes(db, Date.now(), { COMMONS_INVESTIGATION_MODE: 'on' })).toEqual({ mode: 'on', posted: 0, recorded: 0 });
  });
});
