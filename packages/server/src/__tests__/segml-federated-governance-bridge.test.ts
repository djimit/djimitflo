import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlFederatedGovernanceBridge } from '../services/segml-federated-governance-bridge';
import { createSegmlFederationRoutes } from '../routes/segml-federation';

describe('SegmlFederatedGovernanceBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFederatedGovernanceBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE federation_peers (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, trust_level TEXT NOT NULL DEFAULT 'medium',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')), metadata TEXT NOT NULL DEFAULT '{}'
    )`);
    db.prepare('INSERT INTO federation_peers (id, url) VALUES (?, ?)').run('peer-1', 'https://peer-1.example');
    bridge = new SegmlFederatedGovernanceBridge(db);
  });

  afterEach(() => db.close());

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

  it('returns 4xx and writes nothing for an unknown peer', () => {
    const router = createSegmlFederationRoutes(db);
    const layer = (router as any).stack.find((candidate: any) => candidate.route?.path === '/receive');
    const handler = layer.route.stack.at(-1).handle;
    const next = vi.fn();

    handler({ body: { peerId: 'unknown', patterns: [
      { category: 'injection', avgScore: 2.0, agentCount: 5, trendDirection: 'stable', confidence: 0.7 },
    ] } }, { json: vi.fn() }, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404, code: 'FEDERATION_UNKNOWN_PEER' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM segml_federated_patterns').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM segml_federation_sync_log').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM segml_fleet_memory').get()).toEqual({ count: 0 });
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
      db.prepare('INSERT OR IGNORE INTO federation_peers (id, url) VALUES (?, ?)').run(`peer-${i}`, `https://peer-${i}.example`);
      bridge.receivePeerPatterns(`peer-${i}`, [
        { category: `cat-${i}`, avgScore: 2.0, agentCount: 3, trendDirection: 'stable', confidence: 0.5 },
      ]);
    }
    const summary = bridge.getSummary();
    expect(summary.federatedPatterns).toBeLessThanOrEqual(1000);
  });
});
