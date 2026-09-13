import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentSocialAutopilotService, autopilotConfigFromEnv, extractReply, RESIDENTS } from '../services/agent-social-autopilot-service';
import { createTestDb } from './helpers/test-db';

const reply = (peer: string) => JSON.stringify({
  answer: `Answer for ${peer}.`, uncertainty: 'Unknown effect size.', falsifiable_next_step: 'Run a control.',
  creative_alternative: 'Blind the evaluator.', stop_condition: 'Identical outcomes.', evidence_refs: ['ecosystem:cross-agent-learning'],
});

describe('agent commons autopilot', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  let prompts: string[];

  const service = (cooldown = 0) => new AgentSocialAutopilotService(db, {
    runtime: 'ollama', model: 'test-model', ollamaUrl: 'http://ollama.invalid', agents: 'residents',
    intervalMs: 60_000, roundCooldownMs: cooldown, maxRepliesPerTick: 4, seedResidents: true,
  }, { comms, chat: async (_system, prompt) => { prompts.push(prompt); return { content: `Sure! ${reply(prompt.slice(0, 20))}`, run_id: 'run-1', usage: { eval_count: 5 } }; } });

  beforeEach(() => {
    db = createTestDb();
    comms = new AgentCommunicationService(db);
    prompts = [];
  });

  afterEach(() => db.close());

  it('reads config from env with safe defaults', () => {
    expect(autopilotConfigFromEnv({}).runtime).toBe('off');
    const config = autopilotConfigFromEnv({ SOCIAL_AUTOPILOT_RUNTIME: 'ollama', OLLAMA_URL: 'http://host:11434/', SOCIAL_AUTOPILOT_INTERVAL_MS: '5' });
    expect(config).toMatchObject({ runtime: 'ollama', model: 'qwen2.5:3b', ollamaUrl: 'http://host:11434', intervalMs: 15_000, agents: 'residents' });
  });

  it('extracts the last valid JSON object from a chatty reply and rejects incomplete ones', () => {
    expect(extractReply(`Here you go:\n${reply('x')}\nHope this helps.`).answer).toBe('Answer for x.');
    expect(() => extractReply('{"answer": "only this"}')).toThrow('AUTOPILOT_REPLY_INVALID');
  });

  it('seeds residents once, then drives question -> response -> learning and opens a new round when idle', async () => {
    const autopilot = service(0);
    expect(autopilot.seedResidents()).toEqual(RESIDENTS.map((resident) => resident.id));
    expect(autopilot.seedResidents()).toEqual([]);
    expect(autopilot.eligibleAgents().map((agent) => agent.id)).toEqual([...RESIDENTS.map((resident) => resident.id)].sort());

    const first = await autopilot.tick();
    expect(first).toMatchObject({ heartbeats: 4, replies: 0, failures: 0, round_started: true });

    // Answering is order-dependent within a tick (a peer may see the question and the reply in one pass),
    // so assert the converged conversation rather than per-tick counts.
    let replies = 0;
    let last = first;
    for (let round = 0; round < 4; round += 1) {
      last = await autopilot.tick();
      expect(last.failures).toBe(0);
      replies += last.replies;
      if (last.replies === 0) break;
      expect(last.round_started).toBe(false);
    }
    expect(replies).toBe(4);
    expect(prompts[0]).toContain('Do not call tools');
    // The idle tick after convergence opens the next round.
    expect(last).toMatchObject({ replies: 0, round_started: true });
    const actions = db.prepare("SELECT json_extract(payload_json, '$.action') AS action FROM agent_messages ORDER BY timestamp ASC").all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(['social.question', 'social.question', 'social.response', 'social.response', 'social.learning', 'social.learning', 'social.question', 'social.question']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM reflection_candidates').get() as { n: number }).n).toBe(2);
    const commons = comms.listSocialCommons();
    expect(commons.threads).toHaveLength(2);
    expect(commons.agents.every((agent) => agent.present && agent.runtime === 'ollama')).toBe(true);
  });

  it('respects the round cooldown and keeps going when the model fails', async () => {
    const quiet = service(6 * 3600_000);
    quiet.seedResidents();
    expect((await quiet.tick()).round_started).toBe(true);
    const broken = new AgentSocialAutopilotService(db, {
      runtime: 'ollama', model: 'm', ollamaUrl: 'http://ollama.invalid', agents: 'commons-scout,commons-muse,commons-archivist,commons-oracle',
      intervalMs: 60_000, roundCooldownMs: 6 * 3600_000, maxRepliesPerTick: 4, seedResidents: false,
    }, { comms, chat: async () => { throw new Error('model down'); } });
    const tick = await broken.tick();
    expect(tick.replies).toBe(0);
    expect(tick.failures).toBe(2);
    expect(tick.round_started).toBe(false);
    // Failed replies leave the questions unanswered (lease expires later); nothing was fabricated.
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.response'").get() as { n: number }).n).toBe(0);
  });
});
