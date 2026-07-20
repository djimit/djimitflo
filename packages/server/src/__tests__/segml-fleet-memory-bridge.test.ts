import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlFleetMemoryBridge } from '../services/segml-fleet-memory-bridge';

describe('SegmlFleetMemoryBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFleetMemoryBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlFleetMemoryBridge(db);
  });

  it('stores governance patterns', () => {
    bridge.storePattern({
      content: 'Injection vulnerability detected',
      category: 'injection',
      sourceAgent: 'agent-1',
      scope: 'fleet_wide',
      confidence: 0.8,
    });
    const status = bridge.getStatus();
    expect(status.totalMemories).toBe(1);
    expect(status.fleetWideMemories).toBe(1);
  });

  it('retrieves relevant patterns with Thompson Sampling', () => {
    bridge.storePattern({ content: 'Pattern A', category: 'injection', sourceAgent: 'agent-1' });
    bridge.storePattern({ content: 'Pattern B', category: 'hallucination', sourceAgent: 'agent-2' });
    const results = bridge.retrieveRelevant('', undefined, 10);
    expect(results.length).toBe(2);
  });

  it('records feedback for Thompson Sampling update', () => {
    bridge.storePattern({ content: 'Pattern A', category: 'injection', sourceAgent: 'agent-1' });
    const results = bridge.retrieveRelevant('', undefined, 1);
    bridge.recordFeedback(results[0].id, 0.9);
    // Should not throw
  });

  it('detects fleet-wide patterns', () => {
    bridge.storePattern({ content: 'Pattern A', category: 'injection', sourceAgent: 'agent-1', scope: 'fleet_wide' });
    bridge.storePattern({ content: 'Pattern B', category: 'injection', sourceAgent: 'agent-2', scope: 'fleet_wide' });
    bridge.storePattern({ content: 'Pattern C', category: 'injection', sourceAgent: 'agent-3', scope: 'fleet_wide' });
    const patterns = bridge.detectFleetPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].category).toBe('injection');
    expect(patterns[0].affectedAgents.length).toBe(3);
  });

  it('distinguishes agent-specific from fleet-wide', () => {
    bridge.storePattern({ content: 'Specific', category: 'injection', sourceAgent: 'agent-1', scope: 'agent_specific' });
    bridge.storePattern({ content: 'Fleet', category: 'injection', sourceAgent: 'agent-1', scope: 'fleet_wide' });
    const status = bridge.getStatus();
    expect(status.fleetWideMemories).toBe(1);
    expect(status.agentSpecificMemories).toBe(1);
  });
});
