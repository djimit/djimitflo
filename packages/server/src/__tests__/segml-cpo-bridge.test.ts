import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlCpoBridge } from '../services/segml-cpo-bridge';

describe('SegmlCpoBridge', () => {
  let db: Database.Database;
  let bridge: SegmlCpoBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlCpoBridge(db);
  });

  it('runs SEGML learning phase for an agent', async () => {
    const result = await bridge.runSegmlLearningPhase('agent-1');
    expect(result.agentId).toBe('agent-1');
    expect(result.status).toBe('failed'); // No eval data in empty DB
  });

  it('runs fleet SEGML phase for multiple agents', async () => {
    const results = await bridge.runFleetSegmlPhase(['agent-1', 'agent-2']);
    expect(results.length).toBe(2);
  });

  it('aggregates fleet blind spots across agents', async () => {
    const results = await bridge.runFleetSegmlPhase(['a1', 'a2', 'a3']);
    // All fail (no data), so no blind spots to aggregate
    expect(results.every(r => r.status === 'failed')).toBe(true);
  });

  it('reports monitored agent count', () => {
    const status = bridge.getStatus();
    expect(status.monitoredAgents).toBe(0);
  });
});
