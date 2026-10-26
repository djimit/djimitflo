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
const row = (taskId: string) => db.prepare("SELECT skill_id, success, skill_content_hash, evidence_refs_json FROM skill_outcomes WHERE domain = 'fleet' AND task_id = ?")
  .get(taskId) as { skill_id: string; success: number; skill_content_hash: string | null; evidence_refs_json: string };

describe('agent.outcome skill identity (server)', () => {
  it('stores skill_sha in skill_content_hash and the name as a skill:<name> evidence ref', () => {
    const id = store({ skill: 'blog-publisher', skill_sha: SHA, ref: 'hermes-cron:98dc7aec4543:x' });
    expect(scoreAgentOutcomes(db, {})).toBe(1);
    const r = row(id);
    expect(r).toMatchObject({ skill_id: 'agent:hermes-eve-v:cron:eve-dagrapport', success: 1, skill_content_hash: SHA });
    expect(JSON.parse(r.evidence_refs_json)).toEqual(['hermes-cron:98dc7aec4543:x', 'skill:blog-publisher']);
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

  it('both selfchecks pass', () => {
    expect(execFileSync('python3', [EMITTER, '--selfcheck']).toString()).toContain('selfcheck ok');
    expect(execFileSync('python3', [HERMES, '--selfcheck']).toString()).toContain('selfcheck ok');
  });
});

const SKILL_VECTOR = 'CtEQsJJJDMtJV--q2gRaCWzhUsMXHz5LyyJQFE8TBqA';
