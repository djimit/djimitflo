import { expect, it } from 'vitest';
import { agentLiveness, type RegistryNode } from '../services/agent-liveness';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const reg = (name: string, status: string, syncedAt = '2026-09-27T11:30:00Z'): [string, RegistryNode] => [name, { name, raw_json: JSON.stringify({ name, status }), synced_at: syncedAt }];

it('prod 2026-09-27: a 74-day-old heartbeat is stale, recent activity or an ONLINE registry node is live, never seen is unknown', () => {
  const none = new Map<string, RegistryNode>();
  expect(agentLiveness({ id: 'hermes-macmini', last_heartbeat_at: '2026-07-15T00:00:00Z' }, none, NOW)).toMatchObject({ liveness: 'stale', last_seen_at: '2026-07-15T00:00:00Z' });
  expect(agentLiveness({ id: 'commons-scout', last_active_at: '2026-09-27T11:59:00Z' }, none, NOW)).toMatchObject({ liveness: 'live', source: 'activity' });
  expect(agentLiveness({ id: 'ghost' }, none, NOW)).toEqual({ liveness: 'unknown', last_seen_at: null, source: null });
  const registry = new Map([reg('openclaw-workstation', 'ONLINE'), reg('paperclip-control', 'OFFLINE'), reg('old-node', 'ONLINE', '2026-09-26T00:00:00Z')]);
  expect(agentLiveness({ id: 'openclaw-workstation', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW)).toMatchObject({ liveness: 'live', source: 'registry' });
  expect(agentLiveness({ id: 'paperclip-control', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale');
  expect(agentLiveness({ id: 'old-node', last_heartbeat_at: '2026-07-15T00:00:00Z' }, registry, NOW).liveness).toBe('stale'); // registry sync too old
});
