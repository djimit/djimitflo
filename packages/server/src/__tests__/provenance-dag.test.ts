import { afterEach, beforeEach, expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { provenanceDag, PROVENANCE_QUESTIONS } from '../services/provenance-dag';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

// E3: many-to-many provenance DAG with edge evidence — read-only, UNKNOWN is never inferred.
let db: Database.Database;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const SAME_MINUTE = '2026-10-01T09:30:10.000Z';
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
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
const lease = (id: string, runId: string, tokens: number) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
  VALUES (?, ?, 'maker', 'codex', 'completed', ?, ?, ?)`).run(id, runId, JSON.stringify({ runtime_usage: { total_tokens: tokens } }), iso(24 * 8), iso(24 * 8));
const survivedPr = (n: number) => ({ pr_url: `https://github.com/o/r/pull/${n}`, pr_outcome: { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true, checked_at: iso(24) } });

function fixture() {
  // one discovery → one unit → two proposals (many-to-many: p1 also cites a claim)
  db.prepare(`INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES ('ev1', 'discovery.paper', 'scout', ?, ?)`).run(iso(24 * 12), JSON.stringify({ ref: 'arxiv:2601.1' }));
  db.prepare(`INSERT INTO expert_identities (id, canonical_name, provenance_json, kind, created_at, updated_at) VALUES ('u1', 'Paper', ?, 'paper', ?, ?)`)
    .run(JSON.stringify({ source: 'stored-evidence', ref: 'arxiv:2601.1' }), iso(24 * 11), iso(24 * 11));
  proposal('p1', { status: 'verified', refs: ['expert_unit:u1', 'expert_claim:c9'], source: 'gap_analysis', at: SAME_MINUTE });
  proposal('p2', { status: 'needs_more_evidence', refs: ['expert_unit:u1'], source: 'gap_analysis' });
  // requeue copy of p2 by a human operator — a distinct proposal linked by an explicit edge, never merged
  proposal('p3', { status: 'verified', refs: ['expert_unit:u1', 'requeue-of:p2', 'requeue-by:dennis', 'requeue-reason:retry'], source: 'gap_analysis', approvedBy: 'dennis' });
  proposal('p4', { status: 'verified', refs: ['knowledge-gap:testing'], source: 'gap_analysis' });
  // no recorded upstream source; p5/p6 are a recorded near-duplicate pair (shadow judgment), still two proposals
  proposal('p5', { status: 'needs_grounding' });
  proposal('p6', { status: 'needs_grounding' });
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('nd1', 'proposal_near_duplicate', 'self_improvement', 'p6', 'h', 'shadow', 'yes', 'similar_to=p5 cosine=0.950', ?)`).run(iso(24 * 9));
  // created in the same minute as p1 with the same title — and no link: no edge may appear
  proposal('p7', { status: 'regressed', at: SAME_MINUTE });
  // refinement of p5 (column refined_from_id + evidence ref)
  proposal('p8', { status: 'proposed', refs: ['refinement-of:p5'], source: 'refinement', refinedFrom: 'p5' });

  goal('p1'); run('r1a', 'p1', {}, 'failed'); run('r1b', 'p1', survivedPr(11)); lease('l1a', 'r1a', 100); lease('l1b', 'r1b', 200);
  goal('p3'); run('r3', 'p3', survivedPr(13)); lease('l3', 'r3', 50);
  goal('p4'); run('r4', 'p4', survivedPr(14));
  goal('p7'); run('r7', 'p7', {}, 'failed');
}

const answer = (d: ReturnType<typeof provenanceDag>, q: string) => d.answers.find((a) => a.question === q)!;

it('edges are many-to-many and each carries edge_type, source, target, created_at, evidence_ref and origin', () => {
  fixture();
  const d = provenanceDag(db, NOW);
  for (const e of d.edges) {
    expect(e).toMatchObject({ edge_type: expect.any(String), source: { kind: expect.any(String), id: expect.any(String) }, target: { kind: expect.any(String), id: expect.any(String) },
      evidence_ref: expect.any(String), origin: expect.any(String) });
    expect(typeof e.created_at === 'string' || e.created_at === null).toBe(true);
  }
  // one discovery unit → three proposals (p1, p2 and the requeue copy p3 that carries the ref)
  const cites = d.edges.filter((e) => e.edge_type === 'cites_knowledge' && e.source.id === 'u1').map((e) => e.target.id).sort();
  expect(cites).toEqual(['p1', 'p2', 'p3']);
  // p1 cites two knowledge sources
  expect(d.edges.filter((e) => e.edge_type === 'cites_knowledge' && e.target.id === 'p1')).toHaveLength(2);
  // discovery → unit, read from the unit's provenance
  expect(d.edges.find((e) => e.edge_type === 'discovered_as')).toMatchObject({ source: { kind: 'discovery', id: 'arxiv:2601.1' }, target: { kind: 'expert_unit', id: 'u1' } });
  // one proposal → two experiments
  expect(d.edges.filter((e) => e.edge_type === 'experimented_as' && e.source.id === 'p1').map((e) => e.target.id).sort()).toEqual(['r1a', 'r1b']);
  expect(d.edges.find((e) => e.edge_type === 'opened_pr' && e.source.id === 'r1b')).toMatchObject({ target: { kind: 'pr', id: 'https://github.com/o/r/pull/11' } });
  expect(d.edges.find((e) => e.edge_type === 'survived_14d' && e.target.id === 'r1b')).toBeTruthy();
});

it('requeue copies, refinements and near-duplicates stay distinct proposals linked by explicit edges', () => {
  fixture();
  const d = provenanceDag(db, NOW);
  expect(d.edges.find((e) => e.edge_type === 'requeue_of')).toMatchObject({ source: { kind: 'proposal', id: 'p2' }, target: { kind: 'proposal', id: 'p3' }, evidence_ref: expect.stringMatching(/requeue-of:p2/) });
  expect(d.edges.find((e) => e.edge_type === 'requeued_by')).toMatchObject({ source: { kind: 'operator', id: 'dennis' }, target: { id: 'p3' } });
  // refined_from_id and refinement-of: the same link recorded twice → one edge
  expect(d.edges.filter((e) => e.edge_type === 'refinement_of')).toHaveLength(1);
  expect(d.edges.find((e) => e.edge_type === 'near_duplicate_of')).toMatchObject({ source: { id: 'p5' }, target: { id: 'p6' }, evidence_ref: 'judgments#nd1' });
  expect(d.proposals).toBe(8);
});

it('UNKNOWN is never inferred: same minute + same title without a recorded link gives no edge', () => {
  fixture();
  const d = provenanceDag(db, NOW);
  const touching = (id: string) => d.edges.filter((e) => (e.source.kind === 'proposal' && e.source.id === id) || (e.target.kind === 'proposal' && e.target.id === id));
  expect(touching('p7').every((e) => e.edge_type === 'experimented_as')).toBe(true);
  expect(d.edges.some((e) => [e.source.id, e.target.id].includes('p1') && [e.source.id, e.target.id].includes('p7'))).toBe(false);
  const none = answer(d, 'no_known_source');
  expect(none.status).toBe('ok');
  // p5, p6, p7 and the refinement p8 (its parent p5 has no source either)
  expect(none.value).toMatchObject({ count: 4, by_writer: { reflection: 3, refinement: 1 } });
  expect(d.not_linked.proposals_without_source).toBe(4);
});

it('answers all 13 questions with a value or UNKNOWN and a reason; capability is not_measured', () => {
  fixture();
  const d = provenanceDag(db, NOW);
  expect(d.answers.map((a) => a.question)).toEqual([...PROVENANCE_QUESTIONS]);
  for (const a of d.answers) {
    expect(['ok', 'UNKNOWN']).toContain(a.status);
    if (a.status === 'UNKNOWN') expect(a.reason).toBeTruthy();
  }
  expect(answer(d, 'sources_by_kind').value).toMatchObject({ discovery: { sources: 2, proposals: 3 }, knowledge_gap: { sources: 1, proposals: 1 }, operator: { sources: 1, proposals: 1 } });
  expect(answer(d, 'reached_experiment').value).toMatchObject({ count: 4, of: 8 });
  expect(answer(d, 'reached_change').value).toMatchObject({ count: 3 });
  expect(answer(d, 'survived_14d').value).toMatchObject({ count: 3 });
  expect(answer(d, 'survived_from_discovery').value).toMatchObject({ count: 2 });
  expect(answer(d, 'survived_from_knowledge_gap').value).toMatchObject({ count: 1 });
  expect(answer(d, 'survived_from_operator').value).toMatchObject({ count: 1 });
  const conv = answer(d, 'conversion_per_stage').value as Array<{ stage: string; count: number | null; conversion: number | null }>;
  expect(conv.map((s) => [s.stage, s.count, s.conversion])).toEqual([['proposal', 8, null], ['experiment', 4, 0.5], ['change', 3, 0.75], ['survived_14d', 3, 1], ['capability', null, null]]);
  const age = answer(d, 'median_age_per_stage').value as Record<string, number | null>;
  expect(age.proposal).toBeGreaterThan(0);
  const tokens = answer(d, 'compute_per_stage').value as Record<string, number | null>;
  expect(tokens.experiment).toBe(350);
  expect(tokens.survived_14d).toBe(250);
  const ops = answer(d, 'operator_decisions_per_stage').value as Record<string, number | null>;
  expect(ops.proposal).toBe(1); // the human requeue (approved_by = dennis)
  expect(ops.change).toBeNull(); // who merged is not recorded — never assumed
  expect(answer(d, 'first_broken_edge').value).toMatchObject({ from: 'proposal', to: 'experiment', lost: 4 });
  expect(d.capability).toMatchObject({ status: 'not_measured' });
});

it('an empty database answers UNKNOWN where there is nothing to count, never 0 for a missing link', () => {
  const d = provenanceDag(db, NOW);
  expect(answer(d, 'survived_from_discovery').status).toBe('UNKNOWN');
  expect(answer(d, 'first_broken_edge').status).toBe('UNKNOWN');
  expect(answer(d, 'compute_per_stage').status).toBe('UNKNOWN');
  expect(d.edges).toEqual([]);
});

it('is read-only: no row is written', () => {
  fixture();
  const count = () => (db.prepare("SELECT SUM(n) AS n FROM (SELECT COUNT(*) AS n FROM self_improvements UNION ALL SELECT COUNT(*) FROM judgments UNION ALL SELECT COUNT(*) FROM loop_runs)").get() as { n: number }).n;
  const before = count(); provenanceDag(db, NOW); expect(count()).toBe(before);
});

it('evolution-evidence carries the DAG summary as the provenance section (no edge list)', () => {
  fixture();
  const e = buildEvolutionEvidence(db, {}, NOW, 30);
  expect(e.provenance).toMatchObject({ answers: expect.any(Array), edge_counts: expect.any(Object), capability: { status: 'not_measured' } });
  expect((e.provenance as Record<string, unknown>).edges).toBeUndefined();
});

it('GET /api/health/provenance-dag requires read:evidence and returns the answers', async () => {
  const tdb = createTestDb();
  const authService = new AuthService(tdb);
  const auth = createAuthMiddleware(authService);
  const viewer = authService.generateToken(authService.createUser('dag-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(tdb, auth));
  expect((await request(app).get('/api/health/provenance-dag')).status).toBe(401);
  const res = await request(app).get('/api/health/provenance-dag').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200);
  expect(res.body.answers).toHaveLength(PROVENANCE_QUESTIONS.length);
  expect(res.body.capability.status).toBe('not_measured');
});
