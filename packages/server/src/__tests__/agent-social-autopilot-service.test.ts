import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentSocialAutopilotService, autopilotConfigFromEnv, extractReply, RESIDENTS, type ChatFn } from '../services/agent-social-autopilot-service';
import { createTestDb } from './helpers/test-db';

const reply = (peer: string) => JSON.stringify({
  answer: `Answer for ${peer}.`, uncertainty: 'Unknown effect size.', falsifiable_next_step: 'Run a control.',
  creative_alternative: 'Blind the evaluator.', stop_condition: 'Identical outcomes.', interest: 'Compare peer evidence quality', ecosystem_component: 'Djimitflo', proposed_improvement: 'Add peer evidence comparison', evidence_refs: ['ecosystem:cross-agent-learning'],
});

describe('agent commons autopilot', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  let prompts: string[];

  const service = (cooldown = 0, chat?: ChatFn, maxRepliesPerTick = 4) => new AgentSocialAutopilotService(db, {
    runtime: 'ollama', model: 'test-model', ollamaUrl: 'http://ollama.invalid', agents: 'residents',
    intervalMs: 60_000, roundCooldownMs: cooldown, maxRepliesPerTick, seedResidents: true,
  }, { comms, chat: chat || (async (_system, prompt) => { prompts.push(prompt); return { content: `Sure! ${reply(prompt.slice(0, 20))}`, run_id: 'run-1', usage: { eval_count: 5 } }; }) });

  beforeEach(() => {
    db = createTestDb();
    comms = new AgentCommunicationService(db);
    prompts = [];
  });

  afterEach(() => { vi.unstubAllGlobals(); db.close(); });

  it('reads config from env with safe defaults', () => {
    expect(autopilotConfigFromEnv({}).runtime).toBe('off');
    const config = autopilotConfigFromEnv({ SOCIAL_AUTOPILOT_RUNTIME: 'ollama', OLLAMA_URL: 'http://host:11434/', SOCIAL_AUTOPILOT_INTERVAL_MS: '5' });
    expect(config).toMatchObject({ runtime: 'ollama', model: 'qwen2.5:3b', ollamaUrl: 'http://host:11434', intervalMs: 15_000, agents: 'residents' });
    expect(autopilotConfigFromEnv({ SOCIAL_AUTOPILOT_MAX_REPLIES: '999' }).maxRepliesPerTick).toBe(16);
    expect(autopilotConfigFromEnv({ SOCIAL_AUTOPILOT_MAX_REPLIES: '2.5' }).maxRepliesPerTick).toBe(2);
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
    expect(prompts[0]).toContain('proposed_improvement');
    expect(db.prepare("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'proposed'").get()).toEqual({ n: 1 });
    // The idle tick after convergence opens the next round.
    expect(last).toMatchObject({ replies: 0, round_started: true });
    const actions = db.prepare("SELECT json_extract(payload_json, '$.action') AS action FROM agent_messages ORDER BY timestamp ASC").all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(['social.question', 'social.question', 'social.response', 'social.response', 'social.learning', 'social.learning', 'social.question', 'social.question']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM reflection_candidates').get() as { n: number }).n).toBe(2);
    const commons = comms.listSocialCommons();
    expect(commons.threads).toHaveLength(2);
    expect(commons.threads.some(thread => thread.topic === 'Compare peer evidence quality')).toBe(true);
    expect(commons.agents.every((agent) => agent.present && agent.runtime === 'ollama')).toBe(true);
  });

  it('bounds failed inference attempts and claims only the work it can attempt', async () => {
    const calls = vi.fn(async () => { throw new Error('provider failure'); });
    const autopilot = service(0, calls, 1);
    autopilot.seedResidents(); await autopilot.tick();
    expect(await autopilot.tick()).toMatchObject({ attempts: 1, failures: 1, replies: 0 });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE status = 'pending'").get()).toEqual({ n: 1 });
  });

  it('expires stale work and ignores unrelated agents when starting resident rounds', async () => {
    const autopilot = service(3600_000); autopilot.seedResidents();
    db.prepare("INSERT INTO agents (id,name,status) VALUES ('external-a','A','active'),('external-b','B','active')").run();
    comms.heartbeat('external-a', 'external', 'test-model'); comms.heartbeat('external-b', 'external', 'test-model');
    comms.socialize(0, 'operator', ['external-a', 'external-b']);
    const stale = comms.send({ from: 'external-a', to: RESIDENTS[0].id, type: 'question', action: 'social.question', threadId: 'expired', ttl: 1 });
    db.prepare('UPDATE agent_messages SET timestamp = ? WHERE id = ?').run(new Date(Date.now() - 10_000).toISOString(), stale.id);
    expect(await autopilot.tick()).toMatchObject({ attempts: 0, round_started: true });
    expect(db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(stale.id)).toEqual({ status: 'expired' });
    const residentThread = comms.listSocialCommons().threads.find(thread => thread.participants.every(id => id.startsWith('commons-')))!;
    expect(residentThread.participants).toHaveLength(2);
  });

  it('stop aborts its HTTP request and prevents a late model result being published', async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn((_url: string, _options: RequestInit) => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const autopilot = new AgentSocialAutopilotService(db, { ...autopilotConfigFromEnv({ SOCIAL_AUTOPILOT_RUNTIME: 'ollama' }), roundCooldownMs: 0 });
    autopilot.seedResidents(); await autopilot.tick();
    const ticking = autopilot.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal!;
    autopilot.stop();
    expect(signal.aborted).toBe(true);
    finish({ ok: true, json: async () => ({ message: { content: reply('late') } }) });
    expect(await ticking).toMatchObject({ attempts: 1, replies: 0, skipped: 'stopped' });
    expect(await autopilot.tick()).toMatchObject({ attempts: 0, skipped: 'stopped' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.response'").get()).toEqual({ n: 0 });
  });

  it('rechecks operator pause after model inference and skips off runtime', async () => {
    const autopilot = service(0, async () => {
      db.prepare("UPDATE agents SET status = 'paused'").run();
      return { content: reply('paused'), run_id: 'run', usage: {} };
    });
    autopilot.seedResidents(); await autopilot.tick();
    expect(await autopilot.tick()).toMatchObject({ attempts: 1, replies: 0, round_started: false });
    expect(await new AgentSocialAutopilotService(db, autopilotConfigFromEnv({})).tick()).toMatchObject({ heartbeats: 0, attempts: 0, skipped: 'off' });
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
