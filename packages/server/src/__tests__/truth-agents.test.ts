import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { createAgentRoutes } from '../routes/agents';
import { SwarmStatusService } from '../services/swarm-status-service';
import { runtimeHealth } from '../services/runtime-health';

/**
 * Dashboard truth audit 2026-11-12 (/agents, /swarm, /swarm-resources, Fleet Cockpit, runtime health), on prod shapes:
 * 8 imported fleet agents with a heartbeat frozen at 2026-07-14, factory workers whose stored counters are 0, hosts that
 * check in every minute with their running components, failed leases that spent tokens, a gym-only runtime.
 */
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 3_600_000;
const FROZEN = '2026-07-14T14:30:01+00:00';

function seed() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db);
  const agent = db.prepare(`INSERT INTO agents (id, name, description, status, capabilities, metadata, agent_type, last_heartbeat_at, last_active_at, total_tasks, completed_tasks, failed_tasks)
    VALUES (?, ?, 'd', 'active', '[]', ?, ?, ?, ?, ?, ?, ?)`);
  agent.run('hermes-workstation', 'Hermes Workstation', '{}', 'hermes', FROZEN, null, 847, 800, 47);
  agent.run('hermes-macmini', 'Hermes MacMini', '{}', 'hermes', FROZEN, null, 234, 210, 24);
  agent.run('overwatch', 'Overwatch', '{}', 'overwatch', FROZEN, null, 10000, 9995, 5);
  agent.run('openclaw-macbook', 'OpenClaw MacBook', '{}', 'openclaw', FROZEN, null, 1247, 1134, 113);
  agent.run('opencode-maker', 'opencode-maker', '{}', null, null, null, 0, 0, 0);
  agent.run('commons-scout', 'Scout (security)', JSON.stringify({ commons_resident: true, social_runtime: { enabled: true } }), null, null, iso(30 * 24 * H), 0, 0, 0);
  db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, domain, agent_id, created_at) VALUES (?, 'agent:hermes-workstation:dream-scout', ?, 'fleet', 'hermes-workstation', ?)`)
    .run('o1', 1, iso(5 * H));
  db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, domain, agent_id, created_at) VALUES (?, 'agent:hermes-workstation:dream-scout', ?, 'fleet', 'hermes-workstation', ?)`)
    .run('o2', 0, iso(50 * H));
  const task = db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, created_at, updated_at)
    VALUES (?, 't', 'd', ?, 'low', 'low', 'local', 'opencode-maker', ?, ?)`);
  task.run('t1', 'completed', iso(3 * H), iso(3 * H)); task.run('t2', 'completed', iso(40 * H), iso(40 * H));
  task.run('t3', 'failed', iso(60 * H), iso(60 * H)); task.run('t-old', 'completed', iso(40 * 24 * H), iso(40 * 24 * H)); // outside 30 d
  const host = db.prepare('INSERT INTO fleet_hosts (host, last_seen, agent_version, info_json) VALUES (?, ?, \'3\', ?)');
  host.run('workstation', iso(60_000), JSON.stringify({ components: ['user:hermes-gateway', 'user:overwatch', 'user:scallopbot'] }));
  host.run('macmini', iso(60_000), JSON.stringify({ components: ['launchd:ai.hermes.gateway'] }));
  host.run('macbook', iso(60_000), JSON.stringify({ components: ['launchd:com.ollama.ollama'] }));
  return db;
}

const app = (db: Database.Database) => express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/agents', createAgentRoutes(db));

it('/agents liveness comes from evidence — outcome, task, running host component — and names its signal', async () => {
  const { body } = await request(app(seed())).get('/api/agents').expect(200);
  const by = Object.fromEntries(body.agents.map((a: { id: string }) => [a.id, a]));
  expect(by['hermes-workstation']).toMatchObject({ liveness: 'live', source: 'outcome', liveness_signal: 'outcome 5 h ago' });
  expect(by['opencode-maker']).toMatchObject({ liveness: 'live', source: 'task', liveness_signal: 'task 3 h ago' });
  expect(by['hermes-macmini']).toMatchObject({ liveness: 'live', source: 'host_component', liveness_signal: 'host component running: launchd:ai.hermes.gateway on macmini' });
  expect(by.overwatch).toMatchObject({ liveness: 'live', liveness_signal: 'host component running: user:overwatch on workstation' });
  // no openclaw component on the macbook: stale, with the last evidence named
  expect(by['openclaw-macbook']).toMatchObject({ liveness: 'stale', source: 'heartbeat', last_seen_at: FROZEN });
  expect(by['openclaw-macbook'].liveness_signal).toMatch(/^last heartbeat \d+ d ago$/);
});

it('/agents counters are 30-day aggregates of task rows and outcomes; the stored lifetime columns are untouched', async () => {
  const db = seed();
  const { body } = await request(app(db)).get('/api/agents').expect(200);
  const by = Object.fromEntries(body.agents.map((a: { id: string }) => [a.id, a]));
  expect(by['opencode-maker'].counters_30d).toEqual({ window_days: 30, tasks: 3, completed: 2, failed: 1, outcomes: 0, outcomes_ok: 0 });
  expect(by['hermes-workstation'].counters_30d).toMatchObject({ tasks: 0, outcomes: 2, outcomes_ok: 1 });
  expect(by.overwatch.counters_30d).toMatchObject({ tasks: 0, completed: 0, failed: 0 });
  expect(by.overwatch).toMatchObject({ total_tasks: 10000, completed_tasks: 9995, failed_tasks: 5 });
  expect(db.prepare("SELECT total_tasks FROM agents WHERE id = 'opencode-maker'").get()).toEqual({ total_tasks: 0 });
});

it('connection state applies only to Commons residents / social runtimes; others are named factory worker or fleet agent', async () => {
  const { body } = await request(app(seed())).get('/api/agents').expect(200);
  const by = Object.fromEntries(body.agents.map((a: { id: string }) => [a.id, a]));
  expect(by['opencode-maker']).toMatchObject({ agent_group: 'factory_worker', connection_state: null, connection_reason: 'factory worker — not a Commons participant' });
  expect(by['hermes-workstation']).toMatchObject({ agent_group: 'fleet_agent', connection_state: null, connection_reason: 'fleet agent — not a Commons participant' });
  expect(by['commons-scout']).toMatchObject({ agent_group: 'commons_resident', connection_state: 'lapsed' });
  for (const a of body.agents) expect(String(a.connection_reason)).not.toMatch(/runtime missing|token expired/);
});

it('one live-agent definition: swarm status counts exactly the agents /agents calls live', async () => {
  const db = seed();
  const { body } = await request(app(db)).get('/api/agents').expect(200);
  const live = body.agents.filter((a: { liveness: string }) => a.liveness === 'live').map((a: { id: string }) => a.id).sort();
  expect(live).toEqual(['hermes-macmini', 'hermes-workstation', 'opencode-maker', 'overwatch']);
  const status = new SwarmStatusService(db).getStatus();
  expect(status.live_agent_count).toBe(live.length);
  expect(status.stale_agents.map((a) => a.id).sort()).toEqual(['commons-scout', 'openclaw-macbook']);
});

it('Fleet Cockpit tokens 24 h include failed and cancelled leases (they spent tokens too)', () => {
  const db = seed();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES ('r1', 'test-gap', 'closed', 'failed', '[]', '{}', ?, ?)`).run(iso(H), iso(H));
  const lease = db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'r1', 'maker', 'opencode', ?, ?, ?, ?)`);
  lease.run('l1', 'failed', JSON.stringify({ runtime_usage: { total_tokens: 1_000_000 } }), iso(2 * H), iso(2 * H));
  lease.run('l2', 'failed', JSON.stringify({ runtime_usage: { total_tokens: 373_091 } }), iso(2 * H), iso(2 * H));
  lease.run('l3', 'cancelled', JSON.stringify({ runtime_usage: { total_tokens: 9 } }), iso(2 * H), iso(2 * H));
  lease.run('l4', 'failed', JSON.stringify({ runtime_usage: { total_tokens: 5 } }), iso(30 * H), iso(30 * H)); // outside 24 h
  const pools = (new SwarmStatusService(db) as any).fleetPools({ load_average: [0], total_memory_bytes: 1, free_memory_bytes: 1, cpu_threads: 8 }) as Array<{ runtime: string; tokens_used_24h: number; completed_24h: number }>;
  expect(pools.find((p) => p.runtime === 'opencode')).toMatchObject({ tokens_used_24h: 1_373_100, completed_24h: 0 });
});

it('runtime health shows 30-day gym attempts for a runtime that only runs in the gym', () => {
  const db = seed();
  const out = db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, domain, created_at) VALUES (?, ?, ?, 'gym', ?)`);
  for (let i = 0; i < 5; i++) out.run(`g${i}`, 'loop-maker:gym:atomic', i < 2 ? 1 : 0, iso(H));
  out.run('g-old', 'loop-maker:gym:atomic', 1, iso(40 * 24 * H));
  const atomic = runtimeHealth(db).find((r) => r.runtime === 'atomic');
  expect(atomic?.leases_30d.n).toBe(0);
  expect(atomic?.gym.attempts_30d).toEqual({ n: 5, ok: 2 });
});
