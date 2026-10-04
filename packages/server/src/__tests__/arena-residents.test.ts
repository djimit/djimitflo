import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentSocialAutopilotService, RESIDENTS } from '../services/agent-social-autopilot-service';
import { arenaGate, enqueueCommittee, EXTINCT_MIN_N } from '../services/committee-swarm';

afterEach(() => vi.unstubAllEnvs());
function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const comms = new AgentCommunicationService(db);
  const autopilot = new AgentSocialAutopilotService(db, { runtime: 'ollama', model: 'm', ollamaUrl: 'http://ollama.invalid', agents: 'residents', intervalMs: 60_000, roundCooldownMs: 3_600_000, maxRepliesPerTick: 1, seedResidents: true },
    { comms, chat: async (_s, prompt) => ({ content: prompt.includes('probability') ? 'Thinking… {"p": 0.25, "rationale": "lane is mostly unverified"}' : '{}', run_id: 'r', usage: {} }) });
  return { db, autopilot };
}
const prop = (db: Database.Database, id: string, status = 'proposed', at = new Date().toISOString()) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?)`).run(id, `t ${id}`, status, at, at);

it('AR-W5: residents answer open committee questions with their own model — a measurable call per resident', async () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const { db, autopilot } = setup();
  autopilot.seedResidents();
  prop(db, 'p1'); enqueueCommittee(db, { id: 'p1', title: 't', source: 'gap_analysis' });
  const tick = await autopilot.tick();
  expect(tick.forecasts).toBe(2); // at most 2 residents per tick
  const rows = db.prepare("SELECT judgment, answers_json FROM judgments WHERE judgment LIKE 'forecast:resident:%'").all() as Array<{ judgment: string; answers_json: string }>;
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[0].answers_json)).toMatchObject({ p: 0.25 });
  db.close();
});

it('AR-W5 gate: a resident that talks without measurable calls, or forecasts worse than the base rate on 30+, stops being scheduled', () => {
  vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true');
  const { db, autopilot } = setup();
  autopilot.seedResidents();
  const [talker, loser, fine] = RESIDENTS.map((r) => r.id);
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) { prop(db, `q${i}`); enqueueCommittee(db, { id: `q${i}`, title: 't', source: 'gap_analysis' }); }
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, status) VALUES (?, ?, 'broadcast', 'result', 'normal', '{}', ?, 'delivered')").run(`m${i}`, talker, now);
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  for (let i = 0; i < EXTINCT_MIN_N + 2; i++) {
    const verified = i % 4 === 0;
    prop(db, `r${i}`, verified ? 'verified' : 'needs_more_evidence', old);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, answers_json, created_at)
      VALUES (?, ?, 'self_improvement', ?, 'j', 'shadow', 'yes', ?, ?)`).run(`f${i}`, `forecast:resident:${loser}`, `r${i}`, JSON.stringify({ p: verified ? 0.05 : 0.95, as_of: old }), old);
  }
  expect(arenaGate(db, talker)).toMatchObject({ allowed: false });
  expect(arenaGate(db, loser)).toMatchObject({ allowed: false });
  expect(arenaGate(db, fine).allowed).toBe(true);
  expect(autopilot.eligibleAgents().map((a) => a.id)).toContain(talker); // gate off by default
  vi.stubEnv('ARENA_GATE_ENABLED', 'true');
  const eligible = autopilot.eligibleAgents().map((a) => a.id);
  expect(eligible).not.toContain(talker); expect(eligible).not.toContain(loser); expect(eligible).toContain(fine);
  db.close();
});
