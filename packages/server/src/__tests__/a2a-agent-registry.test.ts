import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { A2AAgentRegistry } from '../services/a2a-agent-registry';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let registry: A2AAgentRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  registry = new A2AAgentRegistry(db);
});

afterEach(() => { db?.close(); });

describe('G125: A2AAgentRegistry', () => {
  it('registers agent', () => {
    const agent = registry.registerAgent({
      name: 'Test Agent', endpoint: 'http://localhost:3000',
      capabilities: ['read', 'write'], memoryScope: ['episodes'], trustLevel: 0.8, status: 'active',
    });
    expect(agent.id).toBeDefined();
    expect(agent.name).toBe('Test Agent');
  });

  it('gets active agents', () => {
    registry.registerAgent({ name: 'A1', endpoint: 'http://a1', capabilities: ['read'], memoryScope: [], trustLevel: 0.9, status: 'active' });
    registry.registerAgent({ name: 'A2', endpoint: 'http://a2', capabilities: ['write'], memoryScope: [], trustLevel: 0.5, status: 'inactive' });
    const active = registry.getActiveAgents();
    expect(active.length).toBe(1);
  });

  it('finds agents by capability', () => {
    registry.registerAgent({ name: 'A3', endpoint: 'http://a3', capabilities: ['search', 'read'], memoryScope: [], trustLevel: 0.8, status: 'active' });
    const agents = registry.findAgentsByCapability('search');
    expect(agents.length).toBe(1);
  });

  it('creates handoff', () => {
    const handoff = registry.createHandoff('agent-1', 'agent-2', { task: 'research' }, ['mem-1']);
    expect(handoff.id).toBeDefined();
    expect(handoff.status).toBe('pending');
  });

  it('updates handoff status', () => {
    const handoff = registry.createHandoff('agent-1', 'agent-2', {}, []);
    registry.updateHandoffStatus(handoff.id, 'accepted');
    const pending = registry.getPendingHandoffs('agent-2');
    expect(pending.length).toBe(0);
  });

  it('gets pending handoffs', () => {
    registry.createHandoff('agent-1', 'agent-2', {}, []);
    registry.createHandoff('agent-3', 'agent-2', {}, []);
    const pending = registry.getPendingHandoffs('agent-2');
    expect(pending.length).toBe(2);
  });

  it('updates agent status', () => {
    const agent = registry.registerAgent({ name: 'A4', endpoint: 'http://a4', capabilities: [], memoryScope: [], trustLevel: 0.5, status: 'active' });
    registry.updateAgentStatus(agent.id, 'unreachable');
    const active = registry.getActiveAgents();
    expect(active.find(a => a.id === agent.id)).toBeUndefined();
  });
});
