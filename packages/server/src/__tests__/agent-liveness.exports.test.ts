import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { runningHostComponent, livenessEvidence, agentsWithLiveness } from '../services/agent-liveness';
import { createTestDb } from './helpers/test-db';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('agent-liveness exports (runningHostComponent, livenessEvidence, agentsWithLiveness)', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'liveness-exports-'));
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('runningHostComponent', () => {
    it('returns null when the agent has no agent_type', () => {
      expect(runningHostComponent({ id: 'a1' }, [], NOW)).toBeNull();
    });

    it('matches a component named after the agent type on a recently-seen host', () => {
      const hosts = [{ host: 'hermes-workstation', last_seen: iso(-5 * 60_000), components: ['user:hermes-gateway', 'launchd:ai.hermes.gateway'] }];
      const got = runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW);
      expect(got).not.toBeNull();
      expect(got?.host).toBe('hermes-workstation');
      expect(got?.component).toBe('user:hermes-gateway');
    });

    it('picks the shortest matching component (the gateway, not the sandbox hash)', () => {
      const hosts = [{
        host: 'host-1', last_seen: iso(-60_000),
        components: ['docker:openclaw-sbx-workspace-abc123def', 'user:openclaw-gateway'],
      }];
      const got = runningHostComponent({ id: 'openclaw', agent_type: 'openclaw' }, hosts, NOW);
      expect(got?.component).toBe('user:openclaw-gateway');
    });

    it('skips hosts whose last_seen is older than an hour', () => {
      const hosts = [{ host: 'stale-host', last_seen: iso(-2 * 3_600_000), components: ['user:hermes-gateway'] }];
      expect(runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW)).toBeNull();
    });

    it('pins the host by the id suffix after the agent_type', () => {
      const hosts = [
        { host: 'macmini-a', last_seen: iso(-60_000), components: ['user:hermes-gateway'] },
        { host: 'macmini-b', last_seen: iso(-60_000), components: ['user:hermes-gateway'] },
      ];
      const got = runningHostComponent({ id: 'hermes-macmini-b', agent_type: 'hermes' }, hosts, NOW);
      expect(got?.host).toBe('macmini-b');
    });

    it('returns null when no host has a matching component', () => {
      const hosts = [{ host: 'host-1', last_seen: iso(-60_000), components: ['user:other-gateway'] }];
      expect(runningHostComponent({ id: 'hermes', agent_type: 'hermes' }, hosts, NOW)).toBeNull();
    });
  });

  describe('livenessEvidence', () => {
    it('returns fail-soft empty evidence when the registry/outcome/task/fleet tables are absent', () => {
      const ev = livenessEvidence(db);
      expect(ev.registry.size).toBe(0);
      expect(ev.outcomes?.size ?? 0).toBe(0);
      expect(ev.tasks?.size ?? 0).toBe(0);
      expect(ev.hosts?.length ?? 0).toBe(0);
    });

    it('reads registry_agents, skill_outcomes, tasks and fleet_hosts when present', () => {
      // The test-db schema lacks these tables; create them ad hoc.
      db.exec(`
        CREATE TABLE registry_agents (name TEXT PRIMARY KEY, raw_json TEXT NOT NULL, synced_at TEXT NOT NULL);
        CREATE TABLE fleet_hosts (host TEXT PRIMARY KEY, last_seen TEXT NOT NULL, info_json TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO registry_agents (name, raw_json, synced_at) VALUES ('hermes-1', ?, ?)").run(
        JSON.stringify({ status: 'ONLINE' }), iso(-30 * 60_000),
      );
      db.prepare("INSERT INTO agents (id, name, status) VALUES ('hermes-1', 'hermes', 'active')").run();
      db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, agent_id, created_at) VALUES ('o1', 's1', 1, 'hermes-1', ?)").run(iso(-3 * 3_600_000));
      db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, updated_at) VALUES ('t1', 't', 'd', 'completed', 'low', 'low', 'local', 'hermes-1', ?)").run(iso(-2 * 3_600_000));
      db.prepare("INSERT INTO fleet_hosts (host, last_seen, info_json) VALUES ('hermes-ws', ?, ?)").run(
        iso(-5 * 60_000), JSON.stringify({ components: ['user:hermes-gateway'] }),
      );

      const ev = livenessEvidence(db);
      expect(ev.registry.get('hermes-1')?.raw_json).toContain('ONLINE');
      expect(ev.outcomes?.get('hermes-1')).toBe(iso(-3 * 3_600_000));
      expect(ev.tasks?.get('hermes-1')).toBe(iso(-2 * 3_600_000));
      expect(ev.hosts?.find((h) => h.host === 'hermes-ws')?.components).toContain('user:hermes-gateway');
    });
  });

  describe('agentsWithLiveness', () => {
    it('decorates each agent row with its liveness result, preserving the original agent fields', () => {
      const agents = [
        { id: 'live-1', name: 'Live', agent_type: null, last_heartbeat_at: iso(-30 * 60_000), last_active_at: null },
        { id: 'unknown-1', name: 'Unknown', agent_type: null, last_heartbeat_at: null, last_active_at: null },
      ];
      const out = agentsWithLiveness(db, agents, NOW);
      expect(out).toHaveLength(2);
      const live = out.find((a) => a.id === 'live-1');
      expect(live?.liveness).toBe('live');
      expect(live?.source).toBe('heartbeat');
      expect(live?.name).toBe('Live');
      expect(live?.liveness_signal).toContain('heartbeat');
      const unknown = out.find((a) => a.id === 'unknown-1');
      expect(unknown?.liveness).toBe('unknown');
      expect(unknown?.last_seen_at).toBeNull();
      expect(unknown?.source).toBeNull();
      expect(unknown?.liveness_signal).toBeNull();
    });

    it('marks an agent whose only heartbeat is older than a day as stale', () => {
      const agents = [{ id: 'stale-1', name: 'Stale', agent_type: null, last_heartbeat_at: iso(-2 * 86_400_000), last_active_at: null }];
      const out = agentsWithLiveness(db, agents, NOW);
      expect(out[0].liveness).toBe('stale');
      expect(out[0].source).toBe('heartbeat');
      expect(out[0].liveness_signal).toContain('heartbeat');
    });

    it('returns an empty array for no agents', () => {
      expect(agentsWithLiveness(db, [], NOW)).toEqual([]);
    });

    it('prefers the most recent signal across heartbeat, activity, outcome and task', () => {
      const agents = [{ id: 'a-1', name: 'A', agent_type: null, last_heartbeat_at: iso(-10 * 3_600_000), last_active_at: iso(-1 * 3_600_000) }];
      const out = agentsWithLiveness(db, agents, NOW);
      expect(out[0].source).toBe('activity');
      expect(out[0].liveness).toBe('live');
    });
  });
});
