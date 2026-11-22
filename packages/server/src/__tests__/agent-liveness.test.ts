import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  agentLiveness,
  runningHostComponent,
  livenessEvidence,
  agentsWithLiveness,
  agentCounters30d,
  type RegistryNode,
  type FleetHost,
} from '../services/agent-liveness';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const reg = (name: string, status: string, syncedAt = '2026-09-27T11:30:00Z'): [string, RegistryNode] => [name, { name, raw_json: JSON.stringify({ name, status }), synced_at: syncedAt }];
const none = new Map<string, RegistryNode>();

it('prod 2026-09-27: a 74-day-old heartbeat is stale, recent activity or an ONLINE registry node is live, never seen is unknown', () => {
  expect(agentLiveness({ id: 'hermes-macmini', last_heartbeat_at: '2026-07-15T00:00:00Z' }, none, NOW)).toMatchObject({ liveness: 'stale', last_seen_at: '2026-07-15T00:00:00Z' });
  expect(agentLiveness({ id: 'commons-scout', last_active_at: '2026-09-27T11:59:00Z' }, none, NOW)).toMatchObject({ liveness: 'live', source: 'activity' });
  expect(agentLiveness({ id: 'ghost' }, none, NOW)).toEqual({ liveness: 'unknown', last_seen_at: null, source: null, liveness_signal: null });
  const registry = new Map([reg('openclaw-workstation', 'ONLINE'), reg('paperclip-control', 'OFFLINE'), reg('old-node', 'ONLINE', '2026-09-26T00:00:00Z')]);
  expect(agentLiveness({ id: 'openclaw-workstation', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW)).toMatchObject({ liveness: 'live', source: 'registry' });
  expect(agentLiveness({ id: 'paperclip-control', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale');
  expect(agentLiveness({ id: 'old-node', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale'); // registry sync too old
});

// --- runningHostComponent ---

it('runningHostComponent: returns null when agent_type is missing or normalizes to empty', () => {
  expect(runningHostComponent({ id: 'a' }, [], NOW)).toBeNull();
  expect(runningHostComponent({ id: 'a', agent_type: '' }, [], NOW)).toBeNull();
  expect(runningHostComponent({ id: 'a', agent_type: '   ' }, [], NOW)).toBeNull();
});

it('runningHostComponent: matches a component on a recently-seen host', () => {
  const hosts: FleetHost[] = [{ host: 'workstation-1', last_seen: '2026-09-27T11:30:00Z', components: ['user:hermes-gateway', 'docker:other'] }];
  expect(runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW)).toMatchObject({ host: 'workstation-1', component: 'user:hermes-gateway' });
});

it('runningHostComponent: skips a host that checked in more than an hour ago', () => {
  const hosts: FleetHost[] = [{ host: 'workstation-1', last_seen: '2026-09-27T10:59:00Z', components: ['user:hermes-gateway'] }];
  expect(runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW)).toBeNull();
});

it('runningHostComponent: hint from id suffix pins the host', () => {
  const hosts: FleetHost[] = [
    { host: 'macmini', last_seen: '2026-09-27T11:55:00Z', components: ['user:hermes-gateway'] },
    { host: 'workstation', last_seen: '2026-09-27T11:55:00Z', components: ['user:hermes-gateway'] },
  ];
  expect(runningHostComponent({ id: 'hermes-macmini', agent_type: 'hermes' }, hosts, NOW)).toMatchObject({ host: 'macmini' });
});

it('runningHostComponent: picks the shortest matching component', () => {
  const hosts: FleetHost[] = [{
    host: 'workstation',
    last_seen: '2026-09-27T11:55:00Z',
    components: ['docker:openclaw-sbx-workspace-abc123', 'user:openclaw-gateway'],
  }];
  expect(runningHostComponent({ id: 'openclaw', agent_type: 'openclaw' }, hosts, NOW)).toMatchObject({ component: 'user:openclaw-gateway' });
});

it('runningHostComponent: normalizes mixed-case agent_type and component names', () => {
  const hosts: FleetHost[] = [{ host: 'Workstation-1', last_seen: '2026-09-27T11:55:00Z', components: ['user:Hermes-Gateway'] }];
  expect(runningHostComponent({ id: 'Hermes', agent_type: 'Hermes' }, hosts, NOW)).toMatchObject({ component: 'user:Hermes-Gateway' });
});

it('runningHostComponent: returns null when no component matches the type', () => {
  const hosts: FleetHost[] = [{ host: 'workstation', last_seen: '2026-09-27T11:55:00Z', components: ['user:other-gateway'] }];
  expect(runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW)).toBeNull();
});

// --- agentLiveness: signal text and time thresholds ---

it('agentLiveness: live signal text reports minutes, hours and days correctly', () => {
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T11:55:00Z' }, none, NOW).liveness_signal).toBe('heartbeat 5 min ago');
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T09:00:00Z' }, none, NOW).liveness_signal).toBe('heartbeat 3 h ago');
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-07-15T00:00:00Z' }, none, NOW).liveness_signal).toBe('last heartbeat 75 d ago');
});

it('agentLiveness: a heartbeat exactly 60 minutes ago reads as hours not minutes', () => {
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T11:00:00Z' }, none, NOW).liveness_signal).toBe('heartbeat 1 h ago');
});

it('agentLiveness: a heartbeat exactly 48 hours ago reads as days not hours', () => {
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-25T12:00:00Z' }, none, NOW).liveness_signal).toBe('last heartbeat 2 d ago');
});

it('agentLiveness: a future timestamp is clamped to 0 min', () => {
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T12:05:00Z' }, none, NOW).liveness_signal).toBe('heartbeat 0 min ago');
});

it('agentLiveness: parses sqlite datetime strings with a space separator as UTC', () => {
  const r = agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27 11:59:00' }, none, NOW);
  expect(r.liveness).toBe('live');
  expect(r.liveness_signal).toBe('heartbeat 1 min ago');
});

// --- agentLiveness: best signal selection ---

it('agentLiveness: picks the latest signal among heartbeat, activity, outcome and task', () => {
  const ev = { registry: none, outcomes: new Map([['a', '2026-09-27T11:58:00Z']]), tasks: new Map([['a', '2026-09-27T11:59:00Z']]) };
  const r = agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T11:00:00Z', last_active_at: '2026-09-27T11:30:00Z' }, ev, NOW);
  expect(r.source).toBe('task');
  expect(r.last_seen_at).toBe('2026-09-27T11:59:00Z');
});

it('agentLiveness: keeps the first signal when two signals share the same timestamp', () => {
  const ev = { registry: none, outcomes: new Map([['a', '2026-09-27T11:30:00Z']]) };
  const r = agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-27T11:30:00Z' }, ev, NOW);
  expect(r.source).toBe('heartbeat');
});

it('agentLiveness: an invalid timestamp signal is skipped', () => {
  const r = agentLiveness({ id: 'a', last_heartbeat_at: 'not-a-date', last_active_at: '2026-09-27T11:59:00Z' }, none, NOW);
  expect(r.source).toBe('activity');
  expect(r.liveness).toBe('live');
});

it('agentLiveness: a signal exactly 24 hours old is still live', () => {
  expect(agentLiveness({ id: 'a', last_heartbeat_at: '2026-09-26T12:00:00Z' }, none, NOW).liveness).toBe('live');
});

// --- agentLiveness: host_component and registry paths ---

it('agentLiveness: a running host component makes an agent live even with a stale heartbeat', () => {
  const ev: { registry: Map<string, RegistryNode>; hosts: FleetHost[] } = { registry: none, hosts: [{ host: 'macmini', last_seen: '2026-09-27T11:55:00Z', components: ['user:hermes-gateway'] }] };
  const r = agentLiveness({ id: 'hermes-macmini', agent_type: 'hermes', last_heartbeat_at: '2026-07-15T00:00:00Z' }, ev, NOW);
  expect(r.liveness).toBe('live');
  expect(r.source).toBe('host_component');
  expect(r.liveness_signal).toContain('host component running');
});

it('agentLiveness: a registry node synced exactly 1 hour ago is still live', () => {
  const registry = new Map([reg('node-1', 'ONLINE', '2026-09-27T11:00:00Z')]);
  expect(agentLiveness({ id: 'node-1', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('live');
});

it('agentLiveness: a registry node synced just over 1 hour ago is stale', () => {
  const registry = new Map([reg('node-1', 'ONLINE', '2026-09-27T10:59:00Z')]);
  expect(agentLiveness({ id: 'node-1', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale');
});

it('agentLiveness: registry lookup falls back to agent name when id does not match', () => {
  const registry = new Map([reg('agent-display-name', 'ONLINE')]);
  const r = agentLiveness({ id: 'internal-id', name: 'agent-display-name', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW);
  expect(r.liveness).toBe('live');
  expect(r.source).toBe('registry');
});

it('agentLiveness: registry node with unreadable raw_json is not live', () => {
  const registry = new Map([['node-1', { name: 'node-1', raw_json: 'not-json', synced_at: '2026-09-27T11:55:00Z' }]]);
  expect(agentLiveness({ id: 'node-1', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale');
});

it('agentLiveness: registry node with non-ONLINE status is not live via registry', () => {
  const registry = new Map([reg('node-1', 'OFFLINE', '2026-09-27T11:55:00Z')]);
  expect(agentLiveness({ id: 'node-1', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale');
});

// --- livenessEvidence / agentsWithLiveness / agentCounters30d (DB) ---

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registry_agents (name TEXT PRIMARY KEY, raw_json TEXT NOT NULL DEFAULT '{}', synced_at TEXT NOT NULL);
    CREATE TABLE skill_outcomes (id TEXT PRIMARY KEY, agent_id TEXT, created_at TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, agent_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE fleet_hosts (host TEXT PRIMARY KEY, last_seen TEXT NOT NULL, info_json TEXT NOT NULL DEFAULT '{}');
  `);
  return db;
}

it('livenessEvidence: reads registry, outcomes, tasks and hosts from the DB', () => {
  const db = makeDb();
  db.prepare('INSERT INTO registry_agents (name, raw_json, synced_at) VALUES (?, ?, ?)').run('reg-agent', JSON.stringify({ status: 'ONLINE' }), '2026-09-27T11:55:00Z');
  db.prepare('INSERT INTO skill_outcomes (id, agent_id, created_at, success) VALUES (?, ?, ?, ?)').run('o1', 'agent-x', '2026-09-27T11:00:00Z', 1);
  db.prepare('INSERT INTO tasks (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t1', 'agent-x', 'completed', '2026-09-27T10:00:00Z', '2026-09-27T11:30:00Z');
  db.prepare('INSERT INTO fleet_hosts (host, last_seen, info_json) VALUES (?, ?, ?)').run('host-1', '2026-09-27T11:50:00Z', JSON.stringify({ components: ['user:hermes-gateway'] }));

  const ev = livenessEvidence(db);
  expect(ev.registry.get('reg-agent')?.raw_json).toContain('ONLINE');
  expect(ev.outcomes?.get('agent-x')).toBe('2026-09-27T11:00:00Z');
  expect(ev.tasks?.get('agent-x')).toBe('2026-09-27T11:30:00Z');
  expect(ev.hosts?.[0].components).toEqual(['user:hermes-gateway']);
  db.close();
});

it('livenessEvidence: bad JSON in fleet_hosts info_json yields empty components', () => {
  const db = makeDb();
  db.prepare('INSERT INTO fleet_hosts (host, last_seen, info_json) VALUES (?, ?, ?)').run('host-1', '2026-09-27T11:50:00Z', 'not-json');
  expect(livenessEvidence(db).hosts?.[0].components).toEqual([]);
  db.close();
});

it('livenessEvidence: non-array components in info_json yield empty components', () => {
  const db = makeDb();
  db.prepare('INSERT INTO fleet_hosts (host, last_seen, info_json) VALUES (?, ?, ?)').run('host-1', '2026-09-27T11:50:00Z', JSON.stringify({ components: 'not-an-array' }));
  expect(livenessEvidence(db).hosts?.[0].components).toEqual([]);
  db.close();
});

it('livenessEvidence: filters out non-string components', () => {
  const db = makeDb();
  db.prepare('INSERT INTO fleet_hosts (host, last_seen, info_json) VALUES (?, ?, ?)').run('host-1', '2026-09-27T11:50:00Z', JSON.stringify({ components: ['user:hermes-gateway', 42, null, 'launchd:ai.hermes.gateway'] }));
  expect(livenessEvidence(db).hosts?.[0].components).toEqual(['user:hermes-gateway', 'launchd:ai.hermes.gateway']);
  db.close();
});

it('livenessEvidence: missing tables contribute nothing (fail-soft)', () => {
  const db = new Database(':memory:');
  const ev = livenessEvidence(db);
  expect(ev.registry.size).toBe(0);
  expect(ev.outcomes?.size ?? 0).toBe(0);
  expect(ev.tasks?.size ?? 0).toBe(0);
  expect(ev.hosts?.length ?? 0).toBe(0);
  db.close();
});

it('agentsWithLiveness: combines evidence and liveness for each agent', () => {
  const db = makeDb();
  db.prepare('INSERT INTO skill_outcomes (id, agent_id, created_at, success) VALUES (?, ?, ?, ?)').run('o1', 'live-agent', '2026-09-27T11:59:00Z', 1);
  const agents = [
    { id: 'live-agent', last_heartbeat_at: '2026-07-15T00:00:00Z' },
    { id: 'ghost-agent' },
  ];
  const results = agentsWithLiveness(db, agents, NOW);
  expect(results[0].liveness).toBe('live');
  expect(results[0].source).toBe('outcome');
  expect(results[1].liveness).toBe('unknown');
  db.close();
});

it('agentCounters30d: counts tasks and outcomes in the 30-day window', () => {
  const db = makeDb();
  const within = new Date(NOW - 10 * 86_400_000).toISOString();
  const outside = new Date(NOW - 40 * 86_400_000).toISOString();
  db.prepare('INSERT INTO tasks (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t1', 'a1', 'completed', within, within);
  db.prepare('INSERT INTO tasks (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t2', 'a1', 'failed', within, within);
  db.prepare('INSERT INTO tasks (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t3', 'a1', 'running', within, within);
  db.prepare('INSERT INTO tasks (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t4', 'a1', 'completed', outside, outside);
  db.prepare('INSERT INTO skill_outcomes (id, agent_id, created_at, success) VALUES (?, ?, ?, ?)').run('o1', 'a1', within, 1);
  db.prepare('INSERT INTO skill_outcomes (id, agent_id, created_at, success) VALUES (?, ?, ?, ?)').run('o2', 'a1', within, 0);
  db.prepare('INSERT INTO skill_outcomes (id, agent_id, created_at, success) VALUES (?, ?, ?, ?)').run('o3', 'a1', outside, 1);

  const c = agentCounters30d(db, NOW).get('a1');
  expect(c).toMatchObject({ window_days: 30, tasks: 3, completed: 1, failed: 1, outcomes: 2, outcomes_ok: 1 });
  db.close();
});

it('agentCounters30d: an agent with no rows is absent', () => {
  const db = makeDb();
  expect(agentCounters30d(db, NOW).size).toBe(0);
  db.close();
});
