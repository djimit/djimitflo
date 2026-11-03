import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rankNeedsYou, type InboxRequeue, type InboxLabel } from '../services/decisions-inbox';

const NOW = new Date('2026-10-13T00:00:00Z').getTime();
const D30_AGO = new Date(NOW - 30 * 86_400_000).toISOString();

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE self_improvements (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, updated_at TEXT,
    evidence_refs_json TEXT DEFAULT '[]', source TEXT DEFAULT '', created_at TEXT
  )`);
  return db;
}

function insertSettledRequeues(db: InstanceType<typeof Database>, count: number, verified: number) {
  for (let i = 1; i <= count; i++) {
    const status = i <= verified ? 'verified' : 'regressed';
    db.prepare(`INSERT INTO self_improvements (id, title, status, updated_at, evidence_refs_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(`rq-${i}`, `R${i}`, status, new Date(NOW - i * 86_400_000).toISOString(), JSON.stringify([`requeue-of:o${i}`]));
  }
}

describe('rankNeedsYou — Phase 3 shadow ranking', () => {
  it('returns an empty array when all inputs are empty', () => {
    const db = makeDb();
    expect(rankNeedsYou(db, [], [], [], NOW, { labelled: null, wrong: null })).toEqual([]);
    db.close();
  });

  it('scores requeue items with the measured verification rate (≥ MIN_N settled)', () => {
    const db = makeDb();
    insertSettledRequeues(db, 5, 3); // 3/5 = 0.6
    const rq: InboxRequeue[] = [{ id: 'r1', title: 'T', status: 'regressed', updated_at: D30_AGO, requeued_as: null, queue_class: 'operator' }];
    const out = rankNeedsYou(db, rq, [], [], NOW, { labelled: null, wrong: null });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('requeue');
    expect(out[0].expected_gain).toBe(0.6);
    expect(out[0].score).toBe(0.6); // 0.6 * 1 / 1
    db.close();
  });

  it('marks requeue INSUFFICIENT_EVIDENCE when fewer than 5 settled requeues exist', () => {
    const db = makeDb();
    insertSettledRequeues(db, 2, 2);
    const rq: InboxRequeue[] = [{ id: 'r1', title: 'T', status: 'regressed', updated_at: D30_AGO, requeued_as: null, queue_class: 'operator' }];
    const out = rankNeedsYou(db, rq, [], [], NOW, { labelled: null, wrong: null });
    expect(out[0].expected_gain).toBeNull();
    expect(out[0].score).toBeNull();
    expect(out[0].evidence[0]).toContain('INSUFFICIENT_EVIDENCE');
    db.close();
  });

  it('computes label gain as 1/(30−labelled) before the D5 gate', () => {
    const db = makeDb();
    const labels: InboxLabel[] = [{ id: 'l1', title: 'L', status: 'x', reason: '', verdict_at: D30_AGO, label: null }];
    const out = rankNeedsYou(db, [], labels, [], NOW, { labelled: 20, wrong: 1 });
    expect(out[0].kind).toBe('label');
    expect(out[0].expected_gain).toBe(0.1); // 1/10
    expect(out[0].score).toBe(0.1);
    db.close();
  });

  it('computes label gain as wrong/labelled after the D5 gate (≥ 30 labels)', () => {
    const db = makeDb();
    const labels: InboxLabel[] = [{ id: 'l1', title: 'L', status: 'x', reason: '', verdict_at: D30_AGO, label: null }];
    const out = rankNeedsYou(db, [], labels, [], NOW, { labelled: 40, wrong: 2 });
    expect(out[0].expected_gain).toBe(0.05); // 2/40
    expect(out[0].score).toBe(0.05);
    db.close();
  });

  it('returns null gain when d5 counts are unavailable', () => {
    const db = makeDb();
    const labels: InboxLabel[] = [{ id: 'l1', title: 'L', status: 'x', reason: '', verdict_at: D30_AGO, label: null }];
    const out = rankNeedsYou(db, [], labels, [], NOW, { labelled: null, wrong: null });
    expect(out[0].expected_gain).toBeNull();
    expect(out[0].evidence[0]).toContain('INSUFFICIENT_EVIDENCE');
    db.close();
  });

  it('always marks memory_review items as INSUFFICIENT_EVIDENCE with null score', () => {
    const db = makeDb();
    const mem = [{ id: 'm1', title: 'M', content: '', memory_type: 'rule', status: 'review_required', created_at: D30_AGO }];
    const out = rankNeedsYou(db, [], [], mem, NOW, { labelled: null, wrong: null });
    expect(out[0].kind).toBe('memory_review');
    expect(out[0].expected_gain).toBeNull();
    expect(out[0].score).toBeNull();
    db.close();
  });

  it('sorts measured items by score descending before INSUFFICIENT_EVIDENCE items', () => {
    const db = makeDb();
    insertSettledRequeues(db, 5, 5); // rate = 1.0
    const rq: InboxRequeue[] = [{ id: 'r1', title: 'High', status: 'regressed', updated_at: D30_AGO, requeued_as: null, queue_class: 'operator' }];
    const mem = [{ id: 'm1', title: 'Low', content: '', memory_type: 'rule', status: 'candidate', created_at: D30_AGO }];
    const out = rankNeedsYou(db, rq, [], mem, NOW, { labelled: null, wrong: null });
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('requeue');   // score 1.0 first
    expect(out[0].score).toBe(1);
    expect(out[1].kind).toBe('memory_review'); // null score last
    db.close();
  });

  it('applies per-kind reversibility and operator_minutes assumptions', () => {
    const db = makeDb();
    const labels: InboxLabel[] = [{ id: 'l1', title: 'L', status: 'x', reason: '', verdict_at: D30_AGO, label: null }];
    const out = rankNeedsYou(db, [], labels, [], NOW, { labelled: 29, wrong: 0 });
    expect(out[0].reversibility).toBe(1);       // label assumption
    expect(out[0].operator_minutes).toBe(1);
    expect(out[0].evidence[1]).toContain('assumed');
    db.close();
  });
});
