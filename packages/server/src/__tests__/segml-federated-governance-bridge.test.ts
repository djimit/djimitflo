import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlFederatedGovernanceBridge } from '../services/segml-federated-governance-bridge';

describe('SegmlFederatedGovernanceBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFederatedGovernanceBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlFederatedGovernanceBridge(db);
  });

  it('extracts local patterns', () => {
    const patterns = bridge.extractLocalPatterns();
    expect(patterns).toBeDefined();
  });

  it('receives and validates peer patterns', () => {
    const result = bridge.receivePeerPatterns('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 5, trendDirection: 'stable', confidence: 0.7 },
      { category: 'hallucination', avgScore: 4.0, agentCount: 3, trendDirection: 'improving', confidence: 0.8 },
    ]);
    expect(result.patternsReceived).toBe(2);
    expect(result.patternsValidated + result.patternsRejected).toBe(2);
  });

  it('rejects patterns with too few agents', () => {
    const result = bridge.receivePeerPatterns('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 1, trendDirection: 'stable', confidence: 0.7 },
    ]);
    expect(result.patternsRejected).toBe(1);
  });

  it('gets federated governance summary', () => {
    const summary = bridge.getSummary();
    expect(summary.localPatterns).toBe(0);
    expect(summary.federatedPatterns).toBe(0);
    expect(summary.peersSynced).toBe(0);
  });

  it('gets sync history', () => {
    bridge.receivePeerPatterns('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 5, trendDirection: 'stable', confidence: 0.7 },
    ]);
    const history = bridge.getSyncHistory();
    expect(history.length).toBe(1);
    expect(history[0].peerId).toBe('peer-1');
  });

  it('enforces max federated patterns cap', () => {
    // Insert many patterns
    for (let i = 0; i < 50; i++) {
      bridge.receivePeerPatterns(`peer-${i}`, [
        { category: `cat-${i}`, avgScore: 2.0, agentCount: 3, trendDirection: 'stable', confidence: 0.5 },
      ]);
    }
    const summary = bridge.getSummary();
    expect(summary.federatedPatterns).toBeLessThanOrEqual(1000);
  });
});
