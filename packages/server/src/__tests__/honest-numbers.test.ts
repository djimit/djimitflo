import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { clopperPearson, cohenKappa, commonsChildren, commonsYield, oracleAgreement } from '../services/honest-numbers';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

let db: Database.Database;
afterEach(() => db?.close());
const fresh = () => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); return db; };

const T = '2026-10-01T10:00:00Z';
function seedRun(id: string, status: string) {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', ?, '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(id, status, T, T);
}
function seedLease(id: string, runId: string, role: string, makerId: string | null) {
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'opencode', 'completed', ?, ?, ?)")
    .run(id, runId, role, JSON.stringify(makerId ? { maker_lease_id: makerId } : {}), T, T);
}
function opinion(id: string, leaseId: string, reason: string, at = T) {
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'checker_second_opinion', 'worker_lease', ?, 'h', 'shadow', 'yes', ?, ?)")
    .run(id, leaseId, reason, at);
}

it('RX-9: Cohen kappa on a hand-built table', () => {
  // 2x2: 20 agree-yes, 15 agree-no, 5 + 10 disagree → po = .7, pe = (25*30 + 25*20)/50² = .5 → kappa = .4
  expect(cohenKappa([[20, 5], [10, 15]])).toBeCloseTo(0.4, 6);
  expect(cohenKappa([[0, 0], [0, 0]])).toBeNull();
});

it('RX-9: one row per maker (checker + security checker collapse), insufficient_evidence and pre-#334 rows excluded', () => {
  fresh();
  seedRun('r1', 'completed'); seedRun('r2', 'failed');
  seedLease('m1', 'r1', 'maker', null); seedLease('c1', 'r1', 'checker', 'm1'); seedLease('s1', 'r1', 'security_checker', 'm1');
  seedLease('m2', 'r2', 'maker', null); seedLease('c2', 'r2', 'checker', 'm2'); seedLease('c3', 'r2', 'checker', 'm2');
  opinion('j1', 'c1', 'jev=accepted conf=0.90 checker=accepted agree');
  opinion('j2', 's1', 'jev=accepted conf=0.90 checker=accepted agree', '2026-10-01T10:00:01Z'); // same maker → collapses
  opinion('j3', 'c2', 'jev=rejected conf=0.40 checker=needs_revision disagree');
  opinion('j4', 'c3', 'jev=accepted conf=0.80 checker=insufficient_evidence disagree'); // excluded
  opinion('j5', 'c3', 'jev=accepted conf=0.80 checker=accepted agree', '2026-09-20T00:00:00Z'); // before 2026-09-23T18:30Z
  const o = oracleAgreement(db);
  expect(o.n).toBe(2);
  expect(o.confusion.accepted.accepted).toBe(1); expect(o.confusion.rejected.needs_revision).toBe(1);
  expect(o.agreement).toEqual({ all: 0.5, conf_ge_06: 1, conf_lt_06: 0 });
  expect(o.accuracy).toEqual({ n: 2, jev: 1, checker: 1 }); // accepted→completed, rejected/needs_revision→failed
  expect(o.enforce_eligible).toBe(false); // n < 100
});

it('RX-8: Clopper-Pearson for 0/n and k/n', () => {
  const [lo0, hi0] = clopperPearson(0, 9);
  expect(lo0).toBe(0); expect(hi0).toBeCloseTo(0.3363, 3); // two-sided 95 %
  const [lo, hi] = clopperPearson(3, 39);
  expect(lo).toBeGreaterThan(0.015); expect(hi).toBeLessThan(0.22);
});

function seedProposal(id: string, source: string, status: string) {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', ?, ?, ?, ?)`).run(id, source, status, T, T);
}
function grounding(id: string, parent: string, decision: string, refinement: string | null, at: string) {
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, 'commons_grounding', 'self_improvement', ?, 'm', 'enforce', ?, 'r', ?, ?)")
    .run(id, parent, decision, JSON.stringify({ refinement_id: refinement }), at);
}

it('RX-8: children are the attempted refinements; a hygiene-archived parent is not a Commons failure; counts equal hand SQL', () => {
  fresh();
  seedProposal('p1', 'reflection', 'archived'); seedProposal('p2', 'reflection', 'needs_grounding'); seedProposal('p3', 'reflection', 'archived');
  seedProposal('k1', 'refinement', 'verified'); seedProposal('k2', 'refinement', 'needs_more_evidence');
  grounding('g1', 'p1', 'yes', 'k1', '2026-09-28T00:00:00Z');
  grounding('g2', 'p2', 'yes', 'k2', '2026-10-02T00:00:00Z');
  grounding('g3', 'p3', 'no', null, '2026-10-02T00:00:00Z');
  const c = commonsChildren(db);
  expect(c).toEqual({ children_attempted: 2, children_verified: 1, parents_archived_after_refinement: 1,
    children_by_period: { before_2026_09_29: { attempted: 1, verified: 1 }, from_2026_09_29: { attempted: 1, verified: 0 } } });
  const hand = (db.prepare("SELECT COUNT(DISTINCT json_extract(answers_json, '$.refinement_id')) AS n FROM judgments WHERE judgment = 'commons_grounding' AND decision = 'yes' AND json_extract(answers_json, '$.refinement_id') IS NOT NULL").get() as { n: number }).n;
  expect(c.children_attempted).toBe(hand);
  const y = commonsYield(db);
  expect(y).toMatchObject({ k: 1, n: 2, verdict: 'unmeasured' }); // N < 30
});

it('RX-9/RX-8: the evidence endpoint carries oracle and commons sections and never throws on an empty schema', () => {
  db = new Database(':memory:');
  const e = buildEvolutionEvidence(db, {}, Date.parse('2026-10-05T20:00:00Z'));
  expect(e.oracle).toMatchObject({ n: 0, enforce_eligible: false });
  expect(e.commons).toMatchObject({ n: 0, verdict: 'unmeasured' });
});
