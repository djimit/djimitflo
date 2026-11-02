import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { provenanceSummary, provenanceDag, PROVENANCE_QUESTIONS } from '../services/provenance-dag';

let db: Database.Database;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  db.pragma('foreign_keys = OFF');
});
afterEach(() => db.close());

const proposal = (id: string, opts: { status?: string; refs?: string[]; source?: string; at?: string; approvedBy?: string; refinedFrom?: string } = {}) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, approved_by, refined_from_id, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `same title`, opts.source ?? 'reflection', opts.status ?? 'proposed', JSON.stringify(opts.refs ?? []), opts.approvedBy ?? null, opts.refinedFrom ?? null, opts.at ?? iso(24 * 10), opts.at ?? iso(24 * 10));
const goal = (pid: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`)
  .run(`g-${pid}`, pid, iso(24 * 9), iso(24 * 9));
const run = (id: string, pid: string, meta: Record<string, unknown> = {}, status = 'completed') =>
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', ?, ?, '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, status, `g-${pid}`, JSON.stringify(meta), iso(24 * 8), iso(24 * 8));
const survivedPr = (n: number) => ({ pr_url: `https://github.com/o/r/pull/${n}`, pr_outcome: { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true, checked_at: iso(24) } });

function fixture() {
  db.prepare(`INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES ('ev1', 'discovery.paper', 'scout', ?, ?)`).run(iso(24 * 12), JSON.stringify({ ref: 'arxiv:2601.1' }));
  db.prepare(`INSERT INTO expert_identities (id, canonical_name, provenance_json, kind, created_at, updated_at) VALUES ('u1', 'Paper', ?, 'paper', ?, ?)`)
    .run(JSON.stringify({ source: 'stored-evidence', ref: 'arxiv:2601.1' }), iso(24 * 11), iso(24 * 11));
  proposal('p1', { status: 'verified', refs: ['expert_unit:u1'], source: 'gap_analysis' });
  proposal('p2', { status: 'needs_more_evidence', refs: ['expert_unit:u1'], source: 'gap_analysis' });
  proposal('p4', { status: 'verified', refs: ['knowledge-gap:testing'], source: 'gap_analysis' });
  goal('p1'); run('r1b', 'p1', survivedPr(11));
  goal('p4'); run('r4', 'p4', survivedPr(14));
}

describe('provenanceSummary', () => {
  it('omits the edge list and edges_truncated, keeping the rest of the DAG result', () => {
    fixture();
    const s = provenanceSummary(db, NOW);
    expect(s).not.toHaveProperty('edges');
    expect(s).not.toHaveProperty('edges_truncated');
    expect(s).toMatchObject({
      at: new Date(NOW).toISOString(),
      window_days: null,
      proposals: 3,
      edge_counts: expect.any(Object),
      edges_total: expect.any(Number),
      answers: expect.any(Array),
      not_linked: expect.any(Object),
      capability: { status: 'not_measured' },
      errors: expect.any(Array),
    });
  });

  it('edges_total still reflects the full edge count even though the edge list is dropped', () => {
    fixture();
    const full = provenanceDag(db, NOW);
    const s = provenanceSummary(db, NOW);
    expect(s.edges_total).toBe(full.edges_total);
    expect(s.edges_total).toBeGreaterThan(0);
  });

  it('edge_counts matches the full DAG edge_counts', () => {
    fixture();
    const full = provenanceDag(db, NOW);
    const s = provenanceSummary(db, NOW);
    expect(s.edge_counts).toEqual(full.edge_counts);
  });

  it('answers are identical to provenanceDag answers and cover all questions', () => {
    fixture();
    const full = provenanceDag(db, NOW);
    const s = provenanceSummary(db, NOW);
    expect(s.answers.map((a) => a.question)).toEqual([...PROVENANCE_QUESTIONS]);
    expect(s.answers).toEqual(full.answers);
  });

  it('on an empty database answers UNKNOWN where there is nothing to count', () => {
    const s = provenanceSummary(db, NOW);
    const ans = (q: string) => s.answers.find((a) => a.question === q)!;
    expect(ans('survived_from_discovery').status).toBe('UNKNOWN');
    expect(ans('first_broken_edge').status).toBe('UNKNOWN');
    expect(ans('compute_per_stage').status).toBe('UNKNOWN');
    expect(s.edges_total).toBe(0);
    expect(s.proposals).toBe(0);
    expect(s.capability).toMatchObject({ status: 'not_measured' });
  });

  it('is read-only: no row is written', () => {
    fixture();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM self_improvements").get() as { n: number }).n;
    const before = count();
    provenanceSummary(db, NOW);
    expect(count()).toBe(before);
  });
});