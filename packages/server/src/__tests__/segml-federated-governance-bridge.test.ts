import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlFederatedGovernanceBridge } from '../services/segml-federated-governance-bridge';
import { createHash, createHmac } from 'crypto';

describe('SegmlFederatedGovernanceBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFederatedGovernanceBridge;
  const secretHash = createHash('sha256').update('federation-test-secret-32-characters').digest('hex');

  function receive(peerId: string, patterns: Parameters<SegmlFederatedGovernanceBridge['receivePeerPatterns']>[1]) {
    db.prepare('INSERT OR IGNORE INTO federation_peers (id, url, shared_secret_hash) VALUES (?, ?, ?)').run(peerId, 'http://peer.test', secretHash);
    const body = JSON.stringify({ peerId, patterns });
    const signature = createHmac('sha256', Buffer.from(secretHash, 'hex')).update(body).digest('hex');
    return bridge.receivePeerPatterns(peerId, patterns, signature, body);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlFederatedGovernanceBridge(db);
  });

  it('extracts local patterns', () => {
    const patterns = bridge.extractLocalPatterns();
    expect(patterns).toBeDefined();
  });

  it('receives and validates peer patterns', () => {
    const result = receive('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 5, trendDirection: 'stable', confidence: 0.7 },
      { category: 'hallucination', avgScore: 4.0, agentCount: 3, trendDirection: 'improving', confidence: 0.8 },
    ]);
    expect(result.patternsReceived).toBe(2);
    expect(result.patternsValidated + result.patternsRejected).toBe(2);
  });

  it('rejects patterns with too few agents', () => {
    const result = receive('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 1, trendDirection: 'stable', confidence: 0.7 },
    ]);
    expect(result.patternsRejected).toBe(1);
  });

  it('rejects an unknown peer before writing patterns', () => {
    expect(() => bridge.receivePeerPatterns('unknown', [
      { category: 'injection', avgScore: 2, agentCount: 3, trendDirection: 'stable', confidence: 0.7 },
    ], 'invalid')).toThrow('FEDERATION_UNKNOWN_PEER');
    expect((db.prepare('SELECT COUNT(*) AS count FROM segml_federated_patterns').get() as { count: number }).count).toBe(0);
  });

  it('gets federated governance summary', () => {
    const summary = bridge.getSummary();
    expect(summary.localPatterns).toBe(0);
    expect(summary.federatedPatterns).toBe(0);
    expect(summary.peersSynced).toBe(0);
  });

  it('gets sync history', () => {
    receive('peer-1', [
      { category: 'injection', avgScore: 2.0, agentCount: 5, trendDirection: 'stable', confidence: 0.7 },
    ]);
    const history = bridge.getSyncHistory();
    expect(history.length).toBe(1);
    expect(history[0].peerId).toBe('peer-1');
  });

  it('enforces max federated patterns cap', () => {
    // Insert many patterns
    for (let i = 0; i < 50; i++) {
      receive(`peer-${i}`, [
        { category: `cat-${i}`, avgScore: 2.0, agentCount: 3, trendDirection: 'stable', confidence: 0.5 },
      ]);
    }
    const summary = bridge.getSummary();
    expect(summary.federatedPatterns).toBeLessThanOrEqual(1000);
  });
});
