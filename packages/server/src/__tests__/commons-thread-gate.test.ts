import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService, type AgentMessage } from '../services/agent-communication-service';
import { threadGated } from '../services/agent-social-autopilot-service';

let db: Database.Database;
const ON = { COMMONS_THREAD_GATE_ENABLED: 'true' };
const msg = { id: 'q', payload: { thread_id: 't1' } } as unknown as AgentMessage;
let n = 0;
const reply = (thread: string, decision: string) => {
  const id = `r${++n}`;
  db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, type, payload_json) VALUES (?, 'a', 'b', 'social', ?)").run(id, JSON.stringify({ thread_id: thread, action: 'social.response' }));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'commons_contribution', 'agent_message', ?, 'h', 'shadow', ?, '', ?)`).run(`j${n}`, id, decision, new Date(Date.parse('2026-09-28T00:00:00Z') + n * 1000).toISOString());
};
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); new AgentCommunicationService(db); n = 0; });
afterEach(() => db.close());

it('gates a thread whose last two judged replies added nothing', () => {
  reply('t1', 'yes'); reply('t1', 'no'); reply('t1', 'no');
  expect(threadGated(db, msg, ON)).toBe(true);
  expect(threadGated(db, msg, {})).toBe(false); // off by default
});

it('keeps a thread open while one of the last two replies was useful or uncertain, or with too few verdicts', () => {
  reply('t1', 'no'); expect(threadGated(db, msg, ON)).toBe(false);
  reply('t1', 'uncertain'); expect(threadGated(db, msg, ON)).toBe(false);
  reply('t1', 'no'); reply('t1', 'yes'); expect(threadGated(db, msg, ON)).toBe(false);
  reply('t2', 'no'); reply('t2', 'no'); expect(threadGated(db, msg, ON)).toBe(false); // other thread
});
