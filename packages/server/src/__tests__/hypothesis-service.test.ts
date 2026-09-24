import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { HypothesisService } from '../services/hypothesis-service';

describe('HypothesisService', () => {
  let db: Database.Database;
  let service: HypothesisService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE swarm_hypotheses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    service = new HypothesisService(db);
  });

  afterEach(() => { db?.close(); });

  describe('createHypothesis', () => {
    it('inserts a hypothesis with state "proposed" and returns the record', () => {
      const hyp = service.createHypothesis({
        title: 'Rate limiting improves fairness',
        description: 'Token bucket allocation reduces tail latency under load.',
      });

      expect(hyp.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(hyp.title).toBe('Rate limiting improves fairness');
      expect(hyp.description).toBe('Token bucket allocation reduces tail latency under load.');
      expect(hyp.state).toBe('proposed');
      expect(hyp.evidence_refs).toEqual([]);
      expect(hyp.created_at).toBe(hyp.updated_at);
    });

    it('persists evidence_refs when provided', () => {
      const hyp = service.createHypothesis({
        title: 'Evidence-backed hypothesis',
        description: 'Pre-loaded evidence plan.',
        evidence_refs: ['bench:token_bucket', 'bench:sliding_window'],
      });

      expect(hyp.evidence_refs).toEqual(['bench:token_bucket', 'bench:sliding_window']);
    });

    it('defaults evidence_refs to empty array when omitted', () => {
      const hyp = service.createHypothesis({ title: 't', description: 'd' });
      expect(hyp.evidence_refs).toEqual([]);
    });
  });

  describe('getHypothesis', () => {
    it('returns null for an unknown id', () => {
      expect(service.getHypothesis('does-not-exist')).toBeNull();
    });

    it('round-trips a created hypothesis', () => {
      const created = service.createHypothesis({ title: 'rt', description: 'rd' });
      const fetched = service.getHypothesis(created.id);
      expect(fetched).toEqual(created);
    });
  });

  describe('listHypotheses', () => {
    it('returns hypotheses ordered by created_at DESC', () => {
      const a = service.createHypothesis({ title: 'a', description: 'd' });
      const b = service.createHypothesis({ title: 'b', description: 'd' });

      const list = service.listHypotheses();
      expect(list).toHaveLength(2);
      expect(list.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
      const timestamps = list.map((h) => h.created_at);
      expect([...timestamps].sort().reverse()).toEqual(timestamps);
    });

    it('respects the limit argument', () => {
      service.createHypothesis({ title: 'a', description: 'd' });
      service.createHypothesis({ title: 'b', description: 'd' });
      service.createHypothesis({ title: 'c', description: 'd' });

      expect(service.listHypotheses(2)).toHaveLength(2);
    });

    it('returns empty array when no hypotheses exist', () => {
      expect(service.listHypotheses()).toEqual([]);
    });
  });

  describe('transitionHypothesis', () => {
    it('throws HYPOTHESIS_NOT_FOUND for unknown id', () => {
      expect(() => service.transitionHypothesis('missing', 'supported'))
        .toThrow('HYPOTHESIS_NOT_FOUND');
    });

    it('throws HYPOTHESIS_STATE_INVALID for an unknown state', () => {
      const hyp = service.createHypothesis({ title: 't', description: 'd' });
      expect(() => service.transitionHypothesis(hyp.id, 'frozen'))
        .toThrow('HYPOTHESIS_STATE_INVALID: frozen');
    });

    it('updates state and evidence_refs and returns the record', () => {
      const hyp = service.createHypothesis({
        title: 't',
        description: 'd',
        evidence_refs: ['e1'],
      });

      const updated = service.transitionHypothesis(hyp.id, 'supported', ['e1', 'e2']);
      expect(updated.state).toBe('supported');
      expect(updated.evidence_refs).toEqual(['e1', 'e2']);
      expect(updated.id).toBe(hyp.id);
    });

    it('preserves existing evidence_refs when none are supplied', () => {
      const hyp = service.createHypothesis({
        title: 't',
        description: 'd',
        evidence_refs: ['e1'],
      });

      const updated = service.transitionHypothesis(hyp.id, 'contradicted');
      expect(updated.evidence_refs).toEqual(['e1']);
      expect(updated.state).toBe('contradicted');
    });

    it('accepts all valid state transitions', () => {
      const hyp = service.createHypothesis({ title: 't', description: 'd' });
      for (const state of ['supported', 'contradicted', 'resolved', 'rejected', 'proposed']) {
        const updated = service.transitionHypothesis(hyp.id, state);
        expect(updated.state).toBe(state);
      }
    });
  });
});