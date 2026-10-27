import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { scoreAgentOutcomes } from '../services/external-event-ingest-service';
import { registerFleetHostKey, signFleetEventHmac, verifyFleetEvent } from '../services/fleet-event-signatures';
import { learningLedger, skillSelectionReading } from '../services/learning-ledger';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

/**
 * Intervention 1 (skill inventory 2026-10-26): fleet `agent.outcome` carries the skill that ran (`skill`) and the sha256 of
 * its installed SKILL.md (`skill_sha`); skill_selection reads n / successes / Wilson CI per named skill.
 */
const MASTER = 'test-master-secret';
const SCRIPTS = path.resolve(__dirname, '../../../../scripts');
const EMITTER = path.join(SCRIPTS, 'emit-agent-outcome.py');
const HERMES = path.join(SCRIPTS, 'hermes-cron-outcomes.py');
const SHA = 'a'.repeat(64);
let db: Database.Database;
let seq = 0;

beforeEach(() => { db = new Database(':memory:'); runPreSchemaMigrations(db); db.exec(schema); runMigrations(db); seq = 0; });
afterEach(() => db.close());

const store = (over: Record<string, unknown> = {}) => {
  seq += 1;
  const e = { event_id: `agent-outcome:${seq}`, event_type: 'agent.outcome', source: 'hermes-eve-v', agent: 'hermes-eve-v', task_kind: 'cron:eve-dagrapport',
    success: true, occurred_at: '2026-10-26T18:02:36Z', ...over };
  db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'agent.outcome', 'hermes-eve-v', ?, ?)")
    .run(e.event_id, e.occurred_at, JSON.stringify(e));
  return e.event_id as string;
};
const row = (taskId: string) => db.prepare("SELECT skill_id, success, tokens_used, skill_content_hash, evidence_refs_json FROM skill_outcomes WHERE domain = 'fleet' AND task_id = ?")
  .get(taskId) as { skill_id: string; success: number; tokens_used: number | null; skill_content_hash: string | null; evidence_refs_json: string };
const SHA_B = 'b'.repeat(64);

describe('agent.outcome skill identity (server)', () => {
  it('stores skill_sha in skill_content_hash and the name as a skill:<name> evidence ref', () => {
    const id = store({ skill: 'blog-publisher', skill_sha: SHA, ref: 'hermes-cron:98dc7aec4543:x' });
    expect(scoreAgentOutcomes(db, {})).toBe(1);
    const r = row(id);
    expect(r).toMatchObject({ skill_id: 'agent:hermes-eve-v:cron:eve-dagrapport', success: 1, skill_content_hash: SHA });
    expect(JSON.parse(r.evidence_refs_json)).toEqual(['hermes-cron:98dc7aec4543:x', 'skill:blog-publisher', `skill-sha:blog-publisher@${SHA}`]);
  });

  it('absent tokens are stored NULL (unknown), never 0; reported tokens are kept', () => {
    const absent = store();
    const known = store({ tokens: '1200' }); // the bus hands numbers back as strings
    const zero = store({ tokens: 0 });
    expect(scoreAgentOutcomes(db, {})).toBe(3);
    expect(row(absent).tokens_used).toBeNull();
    expect(row(known).tokens_used).toBe(1200);
    expect(row(zero).tokens_used).toBe(0);
  });

  it('explicit null, blank or "null" tokens are unknown (NULL, no efficiency credit); only a genuine 0 is stored as 0', () => {
    const cases: Array<[string, Record<string, unknown>, number | null]> = [
      ['omitted', {}, null], ['null', { tokens: null, duration_ms: null }, null], ['empty', { tokens: '', duration_ms: '' }, null],
      ['blank', { tokens: '  ' }, null], ['null-string', { tokens: 'null' }, null], ['zero', { tokens: 0 }, 0], ['zero-string', { tokens: '0' }, 0],
    ];
    const ids = cases.map(([kind, over]) => store({ task_kind: `cron:${kind}`, ...over }));
    expect(scoreAgentOutcomes(db, {})).toBe(cases.length);
    const engine = new SkillEvolutionEngine(db);
    cases.forEach(([kind, , want], i) => {
      expect(row(ids[i]).tokens_used, kind).toBe(want);
      expect(engine.measuredTraits(`agent:hermes-eve-v:cron:${kind}`).efficiency, kind).toBe(want === null ? null : 1);
    });
  });

  it('a multi-skill run is ONE outcome: each declared skill once as skill:<name>, each hash as skill-sha:<name>@<sha>', () => {
    const id = store({ ref: 'hermes-cron:j1:e1', skills: JSON.stringify([{ name: 'eve-daily-content-intelligence', sha: SHA }, { name: 'blog-publisher' },
      { name: 'eve-daily-content-intelligence', sha: SHA }, { name: '../etc', sha: SHA }, { name: 'djimit-newsletter', sha: 'XYZ' }]) });
    expect(scoreAgentOutcomes(db, {})).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM skill_outcomes WHERE domain = 'fleet'").get()).toEqual({ c: 1 });
    const r = row(id);
    expect(r.skill_content_hash).toBeNull(); // one column cannot hold several hashes: the refs carry them
    expect(JSON.parse(r.evidence_refs_json)).toEqual(['hermes-cron:j1:e1', 'skill:eve-daily-content-intelligence', 'skill:blog-publisher',
      'skill:djimit-newsletter', `skill-sha:eve-daily-content-intelligence@${SHA}`]);
  });

  it('skills: more than 8 entries are refused whole; the single skill field still counts and dedupes with skills', () => {
    const many = store({ skills: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}` })) });
    const both = store({ skill: 'blog-publisher', skill_sha: SHA, skills: [{ name: 'blog-publisher', sha: SHA }, { name: 'other' }] });
    const conflict = store({ skills: [{ name: 'blog-publisher', sha: SHA }, { name: 'blog-publisher', sha: SHA_B }] });
    expect(scoreAgentOutcomes(db, {})).toBe(3);
    expect(JSON.parse(row(many).evidence_refs_json)).toEqual([]);
    expect(JSON.parse(row(both).evidence_refs_json)).toEqual(['skill:blog-publisher', 'skill:other', `skill-sha:blog-publisher@${SHA}`]);
    expect(row(both).skill_content_hash).toBeNull();
    // two different hashes for one skill in one run: ambiguous, so no hash (never a guess)
    expect(JSON.parse(row(conflict).evidence_refs_json)).toEqual(['skill:blog-publisher']);
    expect(row(conflict).skill_content_hash).toBeNull();
  });

  it('absent, malformed or unattributable values stay NULL and the outcome still scores', () => {
    const absent = store();
    const badName = store({ skill: '../etc/passwd', skill_sha: SHA });
    const longName = store({ skill: 'x'.repeat(65) });
    const badSha = store({ skill: 'blog-publisher', skill_sha: 'A'.repeat(64) });
    const shortSha = store({ skill: 'blog-publisher', skill_sha: 'abc' });
    const shaOnly = store({ skill_sha: SHA }); // a hash with no skill name identifies nothing
    expect(scoreAgentOutcomes(db, {})).toBe(6);
    for (const id of [absent, badName, longName, shaOnly]) {
      expect(row(id).skill_content_hash, id).toBeNull();
      expect(JSON.parse(row(id).evidence_refs_json), id).toEqual([]);
    }
    for (const id of [badSha, shortSha]) {
      expect(row(id).skill_content_hash, id).toBeNull();
      expect(JSON.parse(row(id).evidence_refs_json), id).toEqual(['skill:blog-publisher']);
    }
  });

  it('skill and skill_sha are covered by the fleet signature (tampering breaks it; events without them are unchanged)', () => {
    const key = registerFleetHostKey(db, 'eve-v', { master: MASTER });
    const e: Record<string, unknown> = { event_id: 'agent-outcome:sk-1', event_type: 'agent.outcome', agent: 'hermes-eve-v', task_kind: 'cron:x', success: true,
      occurred_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), host: key.host, key_id: key.key_id, sig_alg: 'hmac-sha256', skill: 'blog-publisher', skill_sha: SHA };
    e.sig = signFleetEventHmac(key.secret!, e);
    expect(verifyFleetEvent(db, { ...e, skill_sha: 'b'.repeat(64) }, { master: MASTER }).verdict).toBe('bad_signature');
    expect(verifyFleetEvent(db, { ...e, skill: 'other-skill' }, { master: MASTER }).verdict).toBe('bad_signature');
    expect(verifyFleetEvent(db, e, { master: MASTER }).verdict).toBe('verified');
  });

  it('skills is covered by the signature in its canonical form (array or the bus\'s JSON string verify alike; tampering breaks it)', () => {
    const key = registerFleetHostKey(db, 'eve-v', { master: MASTER });
    const skills = [{ name: 'blog-publisher', sha: SHA }, { name: 'eve-daily-content-intelligence' }];
    const e: Record<string, unknown> = { event_id: 'agent-outcome:sk-2', event_type: 'agent.outcome', agent: 'hermes-eve-v', task_kind: 'cron:x', success: true,
      occurred_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), host: key.host, key_id: key.key_id, sig_alg: 'hmac-sha256', skills };
    e.sig = signFleetEventHmac(key.secret!, e);
    expect(verifyFleetEvent(db, { ...e, skills: [skills[0]] }, { master: MASTER }).verdict).toBe('bad_signature');
    expect(verifyFleetEvent(db, { ...e, skills: [skills[0], { name: 'eve-daily-content-intelligence', sha: SHA }] }, { master: MASTER }).verdict).toBe('bad_signature');
    // the Redis bus hands list fields back as JSON strings (with its own spacing): same canonical value, same signature
    expect(verifyFleetEvent(db, { ...e, skills: JSON.stringify(skills, null, 1) }, { master: MASTER }).verdict).toBe('verified');
  });

  it('matches the fixed multi-skill vector in emit-agent-outcome.py --selfcheck', () => {
    const e = { event_id: 'agent-outcome:fixture-3', agent: 'hermes', task_kind: 'briefing', success: true, occurred_at: '2026-10-20T08:00:00Z',
      host: 'macmini', key_id: '0123456789abcdef', skills: [{ name: 'blog-publisher', sha: SHA }, { name: 'eve-daily-content-intelligence' }] };
    expect(signFleetEventHmac('fixture-secret', e)).toBe(SKILLS_VECTOR);
  });

  it('matches the fixed skill vector in emit-agent-outcome.py --selfcheck', () => {
    const e = { event_id: 'agent-outcome:fixture-2', agent: 'hermes', task_kind: 'briefing', success: true, occurred_at: '2026-10-20T08:00:00Z',
      host: 'macmini', key_id: '0123456789abcdef', skill: 'blog-publisher', skill_sha: SHA };
    expect(signFleetEventHmac('fixture-secret', e)).toBe(SKILL_VECTOR);
  });
});

describe('learning ledger: skill_selection per named skill', () => {
  const add = (skill: string, n: number, k: number) => {
    for (let i = 0; i < n; i++) store({ skill, skill_sha: SHA, success: i < k });
  };
  const skillRow = () => learningLedger(db, [], null).mechanisms.find((m) => m.mechanism === 'skill_selection')!;

  it('no named-skill rows → NOT_MEASURED (fleet outcomes without a skill do not count)', () => {
    store(); scoreAgentOutcomes(db, {});
    expect(skillSelectionReading(db)).toEqual([]);
    expect(skillRow()).toMatchObject({ status: 'NOT_MEASURED', estimate: null, ci: null, skills: [] });
  });

  it('< 30 outcomes → INSUFFICIENT with n and successes, rate and CI null (never 0)', () => {
    add('blog-publisher', 5, 0); scoreAgentOutcomes(db, {});
    const r = skillRow();
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.skills).toEqual([{ skill: 'blog-publisher', n: 5, successes: 0, rate: null, ci: null, status: 'INSUFFICIENT', hashes: 1, unhashed: 0 }]);
  });

  it('≥ 30 outcomes for a skill → its rate and Wilson 95 % CI; mechanism RUNNING, never closed (no effect estimate)', () => {
    add('eve-daily-content-intelligence', 30, 27); add('djimit-newsletter', 2, 1); store({ skill: 'djimit-newsletter' }); scoreAgentOutcomes(db, {});
    const r = skillRow();
    expect(r).toMatchObject({ status: 'RUNNING', closed: false, estimate: null, ci: null });
    const eve = r.skills!.find((s) => s.skill === 'eve-daily-content-intelligence')!;
    expect(eve).toMatchObject({ n: 30, successes: 27, rate: 0.9, status: 'RUNNING' });
    expect(eve.ci![0]).toBeCloseTo(0.7438, 3); expect(eve.ci![1]).toBeCloseTo(0.9654, 3);
    expect(r.skills!.find((s) => s.skill === 'djimit-newsletter')).toMatchObject({ n: 3, successes: 2, rate: null, ci: null, status: 'INSUFFICIENT', hashes: 1, unhashed: 1 });
  });

  it('a duplicate skill ref in one outcome (ref itself is skill:<name>) changes neither n, k, the CI nor the hash counts', () => {
    for (let i = 0; i < 30; i++) store({ skill: 'eve-daily-content-intelligence', skill_sha: SHA, success: i < 27, ...(i % 2 ? { ref: 'skill:eve-daily-content-intelligence' } : {}) });
    store({ skill: 'blog-publisher', ref: 'skill:blog-publisher' });
    scoreAgentOutcomes(db, {});
    const skills = skillSelectionReading(db)!;
    const eve = skills.find((s) => s.skill === 'eve-daily-content-intelligence')!;
    expect(eve).toMatchObject({ n: 30, successes: 27, rate: 0.9, hashes: 1, unhashed: 0 });
    expect(eve.ci![0]).toBeCloseTo(0.7438, 3); expect(eve.ci![1]).toBeCloseTo(0.9654, 3);
    expect(skills.find((s) => s.skill === 'blog-publisher')).toMatchObject({ n: 1, successes: 1, hashes: 0, unhashed: 1 });
  });

  it('a duplicate ref in a row stored before the write-side dedupe is still counted once', () => {
    new SkillEvolutionEngine(db).recordOutcome('agent:a:cron:x', { success: true, tokensUsed: null, durationMs: 0, domain: 'fleet',
      evidenceRefs: ['skill:blog-publisher', 'skill:blog-publisher'], skillContentHash: SHA });
    expect(skillSelectionReading(db)).toEqual([{ skill: 'blog-publisher', n: 1, successes: 1, rate: null, ci: null, status: 'INSUFFICIENT', hashes: 1, unhashed: 0 }]);
  });

  it('a two-skill run counts once for the agent and n = 1 for each skill, with its own hash', () => {
    store({ task_kind: 'cron:content-intelligence-briefing', skills: [{ name: 'eve-daily-content-intelligence', sha: SHA }, { name: 'blog-publisher', sha: SHA_B }] });
    store({ task_kind: 'cron:content-intelligence-briefing', success: false, skills: [{ name: 'blog-publisher', sha: SHA }] });
    scoreAgentOutcomes(db, {});
    expect(db.prepare("SELECT COUNT(*) AS c FROM skill_outcomes WHERE skill_id = 'agent:hermes-eve-v:cron:content-intelligence-briefing'").get()).toEqual({ c: 2 });
    expect(skillSelectionReading(db)).toEqual([
      { skill: 'blog-publisher', n: 2, successes: 1, rate: null, ci: null, status: 'INSUFFICIENT', hashes: 2, unhashed: 0 },
      { skill: 'eve-daily-content-intelligence', n: 1, successes: 1, rate: null, ci: null, status: 'INSUFFICIENT', hashes: 1, unhashed: 0 },
    ]);
  });

  it('unreadable outcome tables → null reading, the ledger stays NOT_MEASURED', () => {
    const empty = new Database(':memory:');
    expect(skillSelectionReading(empty)).toBeNull();
    expect(learningLedger(empty, [], null).mechanisms.find((m) => m.mechanism === 'skill_selection')?.status).toBe('NOT_MEASURED');
    empty.close();
  });
});

const python = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!python)('Python emitter and Hermes cron poller', () => {
  it('emit-agent-outcome.py --skill --skill-file hashes the SKILL.md minus trailing newlines; the signed event verifies', () => {
    const key = registerFleetHostKey(db, 'eve-v', { master: MASTER });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-id-'));
    const keyFile = path.join(dir, 'fleet-event.key');
    fs.writeFileSync(keyFile, `${key.host} ${key.key_id} ${key.secret}\n`, { mode: 0o600 });
    const skillFile = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: blog-publisher\n---\nPublish.\n\n');
    const run = (file: string) => JSON.parse(execFileSync('python3', [EMITTER, '--agent', 'hermes-eve-v', '--task-kind', 'cron:x', '--success', 'false',
      '--skill', 'blog-publisher', '--skill-file', file, '--dry-run'], { env: { ...process.env, DJIMIT_FLEET_EVENT_KEY_FILE: keyFile } }).toString()) as Record<string, unknown>;
    const event = run(skillFile);
    const missing = run(path.join(dir, 'nope', 'SKILL.md'));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(event.skill).toBe('blog-publisher');
    expect(event.skill_sha).toBe(createHash('sha256').update('---\nname: blog-publisher\n---\nPublish.').digest('hex'));
    expect(verifyFleetEvent(db, event, { master: MASTER }).verdict).toBe('verified');
    // unreadable file: the name is still sent, the hash is not invented
    expect(missing.skill).toBe('blog-publisher');
    expect(missing).not.toHaveProperty('skill_sha');
    expect(verifyFleetEvent(db, missing, { master: MASTER }).verdict).toBe('verified');
  });

  it('hermes-cron-outcomes.py: a two-skill run is one signed outcome; agent n = runs, each skill n = 1', () => {
    const key = registerFleetHostKey(db, 'eve-v', { master: MASTER });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-'));
    const keyFile = path.join(dir, 'fleet-event.key');
    fs.writeFileSync(keyFile, `${key.host} ${key.key_id} ${key.secret}\n`, { mode: 0o600 });
    const home = path.join(dir, 'hermes');
    fs.mkdirSync(path.join(home, 'cron'), { recursive: true });
    const old = Date.now() / 1000 - 3600; // the skill files predate the run
    for (const s of ['eve-daily-content-intelligence', 'blog-publisher']) {
      fs.mkdirSync(path.join(home, 'skills', 'x', s), { recursive: true });
      fs.writeFileSync(path.join(home, 'skills', 'x', s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
      fs.utimesSync(path.join(home, 'skills', 'x', s, 'SKILL.md'), old, old);
    }
    fs.writeFileSync(path.join(home, 'cron', 'jobs.json'), JSON.stringify({ jobs: [
      { id: 'j1', name: 'content-intelligence-briefing', skills: ['eve-daily-content-intelligence', 'blog-publisher'] }] }));
    const iso = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const exec = new Database(path.join(home, 'cron', 'executions.db'));
    exec.exec('CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT)');
    exec.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?)').run('e1', 'j1', 'completed', iso(600), iso(600), iso(500));
    exec.close();
    const lines = execFileSync('python3', [HERMES, '--agent', 'hermes-eve-v', '--hermes-home', home, '--state', path.join(dir, 's.json'), '--dry-run'],
      { env: { ...process.env, DJIMIT_FLEET_EVENT_KEY_FILE: keyFile } }).toString().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.rmSync(dir, { recursive: true, force: true });
    const events = lines.filter((e) => e.event_type === 'agent.outcome');
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.event_id).toBe('agent-outcome:hermes-cron:hermes-eve-v:e1');
    expect(e.ref).toBe('hermes-cron:j1:e1');
    const skills = e.skills as Array<{ name: string; sha?: string }>;
    expect(skills.map((s) => s.name)).toEqual(['eve-daily-content-intelligence', 'blog-publisher']);
    expect(skills.every((s) => /^[a-f0-9]{64}$/.test(s.sha ?? ''))).toBe(true);
    expect(verifyFleetEvent(db, e, { master: MASTER }).verdict).toBe('verified');
    store(e);
    expect(scoreAgentOutcomes(db, {})).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM skill_outcomes WHERE skill_id = 'agent:hermes-eve-v:cron:content-intelligence-briefing'").get()).toEqual({ c: 1 });
    expect(skillSelectionReading(db)!.map((s) => [s.skill, s.n, s.hashes])).toEqual([['blog-publisher', 1, 1], ['eve-daily-content-intelligence', 1, 1]]);
  });

  it('both selfchecks pass', () => {
    expect(execFileSync('python3', [EMITTER, '--selfcheck']).toString()).toContain('selfcheck ok');
    expect(execFileSync('python3', [HERMES, '--selfcheck']).toString()).toContain('selfcheck ok');
  });
});

const SKILL_VECTOR = 'CtEQsJJJDMtJV--q2gRaCWzhUsMXHz5LyyJQFE8TBqA';
const SKILLS_VECTOR = 'G4hXPhCDQD9pt5y6H8n1OHGuHlXzXZPHJd6h2TQTRek';
