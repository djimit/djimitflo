import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FleetMeshService } from '../services/fleet-mesh-service';

describe('FleetMeshService', () => {
  let db: Database.Database;
  let service: FleetMeshService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new FleetMeshService(db);
  });

  afterEach(() => {
    service.stopHeartbeat();
  });

  it('registers a fleet node', () => {
    const node = service.registerNode({
      name: 'workstation',
      endpoint: 'http://192.168.1.28:3001',
      capabilities: ['codex', 'opencode', 'claude'],
      maxAgents: 10,
    });

    expect(node.id).toBeDefined();
    expect(node.name).toBe('workstation');
    expect(node.status).toBe('online');
    expect(node.capabilities).toContain('codex');
  });

  it('updates existing node on re-registration', () => {
    service.registerNode({ name: 'workstation', endpoint: 'http://192.168.1.28:3001' });
    const updated = service.registerNode({ name: 'workstation-v2', endpoint: 'http://192.168.1.28:3001' });

    expect(updated.name).toBe('workstation-v2');
  });

  it('lists all fleet nodes', () => {
    service.registerNode({ name: 'node-a', endpoint: 'http://node-a:3001' });
    service.registerNode({ name: 'node-b', endpoint: 'http://node-b:3001' });

    const nodes = service.listNodes();
    expect(nodes.length).toBe(2);
  });

  it('finds best node based on capacity', () => {
    service.registerNode({ name: 'node-a', endpoint: 'http://node-a:3001', maxAgents: 10 });
    service.registerNode({ name: 'node-b', endpoint: 'http://node-b:3001', maxAgents: 5 });

    const best = service.findBestNode();
    expect(best).toBeDefined();
  });

  it('finds best node matching required capabilities', () => {
    service.registerNode({ name: 'node-a', endpoint: 'http://node-a:3001', capabilities: ['codex'] });
    service.registerNode({ name: 'node-b', endpoint: 'http://node-b:3001', capabilities: ['claude', 'codex'] });

    const best = service.findBestNode(['claude']);
    expect(best?.name).toBe('node-b');
  });

  it('creates handoff request', () => {
    const handoff = service.requestHandoff({
      fromNode: 'node-a',
      toNode: 'node-b',
      agentId: 'agent-1',
      leaseId: 'lease-1',
    });

    expect(handoff.id).toBeDefined();
    expect(handoff.status).toBe('pending');
  });

  it('accepts and completes handoff', () => {
    const handoff = service.requestHandoff({
      fromNode: 'node-a', toNode: 'node-b', agentId: 'agent-1', leaseId: 'lease-1',
    });

    service.acceptHandoff(handoff.id);
    service.completeHandoff(handoff.id);
    // No throw = success
  });

  it('distributes work to best node', () => {
    service.registerNode({ name: 'node-a', endpoint: 'http://node-a:3001', maxAgents: 10 });

    const distribution = service.distributeWork({ loopRunId: 'loop-1' });
    expect(distribution).toBeDefined();
    expect(distribution?.status).toBe('assigned');
  });

  it('syncs capability from another node', () => {
    const sync = service.syncCapability({
      sourceNode: 'node-a',
      capabilityId: 'cap-1',
      capabilityType: 'skill',
      score: 4.5,
    });

    expect(sync.id).toBeDefined();
    expect(sync.score).toBe(4.5);
  });

  it('provides fleet status', () => {
    service.registerNode({ name: 'node-a', endpoint: 'http://node-a:3001', maxAgents: 10 });

    const status = service.getStatus();
    expect(status.totalNodes).toBe(1);
    expect(status.onlineNodes).toBe(1);
  });

  it('starts and stops heartbeat', () => {
    expect(() => {
      service.startHeartbeat(1000);
      service.stopHeartbeat();
    }).not.toThrow();
  });
});
