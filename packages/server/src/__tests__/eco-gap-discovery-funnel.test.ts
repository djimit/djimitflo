import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { interestProfile, gapTerms, GAP_TRIAL_SLOTS } from '../services/interest-feedback';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
const NOW = Date.parse('2026-10-10T18:00:00Z');
const DAY = 86_400_000;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  new SkillEvolutionEngine(db as never); // creates skill_outcomes
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
});
afterEach(() => db.close());

/** n scout discoveries matched on `hits`, `yes` of them judged relevant (the yield baseline needs ≥ 20 on the static list). */
function scouted(prefix: string, hits: string, n: number, yes: number) {
  for (let i = 0; i < n; i++) {
    const ref = `arxiv:${prefix}.${i}`;
    db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', 'djimitflo-scout', ?, ?)")
      .run(`e-${ref}`, new Date(NOW - 2 * DAY).toISOString(), JSON.stringify({ ref, note: `scout match: ${hits}` }));
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'discovery_relevance', 'discovery_rejected', ?, 'h', 'shadow', ?, NULL, ?)")
      .run(`j-${ref}`, ref, i < yes ? 'yes' : 'uncertain', new Date(NOW - DAY).toISOString());
  }
}
function candidates(...titles: string[]) {
  titles.forEach((t, i) => {
    db.prepare("INSERT INTO expert_identities (id, canonical_name, kind, provenance_json) VALUES (?, ?, 'paper', '{}')").run(`expert:c${i}`, t);
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'discovery_relevance', 'expert_unit', ?, 'h', 'shadow', 'yes', NULL, ?)")
      .run(`jc${i}`, `expert:c${i}`, new Date(NOW - DAY).toISOString());
  });
}
/** n failed production maker outcomes with one recurring signature (gate + error class) */
function failures(n: number, gate: string, reason: string) {
  for (let i = 0; i < n; i++) db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap:opencode', 0, 'loop', ?, ?, ?)")
    .run(`o-${gate}-${i}`, `run-${gate}-${i}`, JSON.stringify([`gate:${gate}:fail`, `evolve:reason:${reason}`]), new Date(NOW - (i + 1) * DAY).toISOString());
}

it('ECO 3: a recurring failure signature becomes a gap trial term even when both ordinary trial slots are taken', () => {
  scouted('s', 'mutation', 40, 8);
  candidates('Lattice sieves tableau', 'Lattice sieves tableau again'); // fills the 2 ordinary trial slots
  failures(3, 'snapshot-drift', 'snapshot serializer mismatch 42 at /tmp/x');
  const p = interestProfile(db as never, NOW);
  expect(GAP_TRIAL_SLOTS).toBe(1);
  expect(p.yields.filter((y) => y.trial && !y.gap).map((y) => y.term)).toEqual(['lattice', 'sieves']);
  const gap = p.yields.find((y) => y.gap);
  expect(gap).toMatchObject({ term: 'snapshot', trial: true, n: 0, gap: 'test-gap:opencode|snapshot-drift|snapshot serializer mismatch <n> at <path>' });
  expect(p.terms).toContain('snapshot');
  expect(p.rule.gap_kill_rule).toMatch(/0\.181.*n >= 20.*14 days/);
});

it('ECO 3: gap terms come from the signature parts only, recurring (≥ 2) and filtered (no runtime names, ids, failure vocabulary)', () => {
  failures(1, 'lint', 'eslint parser crashed'); // once: not recurring
  failures(2, 'type-check', 'opencode exceeded budget 1000000'); // only stopwords / runtime names / numbers → no term
  failures(4, 'flake-detector', 'nondeterministic ordering of fixtures');
  const terms = gapTerms(db as never, new Date(NOW - 30 * DAY).toISOString());
  expect(terms.map((t) => t.term)).toEqual(['nondeterministic']);
  expect(terms[0].occurrences).toBe(4);
});

it('ECO 3: no gap trial without a measured baseline (same rule as every trial)', () => {
  failures(3, 'snapshot-drift', 'snapshot serializer mismatch');
  expect(interestProfile(db as never, NOW).yields.some((y) => y.gap)).toBe(false);
});

it('ECO 4: the Commons funnel shows where each validly grounded proposal stopped', () => {
  const svc = new AgentCommunicationService(db);
  const at = new Date(NOW - 3 * DAY).toISOString();
  const prop = (id: string, status: string, panel: string | null = null) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', 'reflection', ?, 0.5, ?, ?, ?)`).run(id, id, status, panel, at, at);
  const panel = (id: string, decision: string) => db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, consensus_json) VALUES (?, 't', 'q', 'consensus_ready', 'low', ?)`)
    .run(id, JSON.stringify({ decision }));
  const ground = (parent: string, kid: string | null) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'commons_grounding', 'self_improvement', ?, 'h', 'enforce', 'yes', 'r', ?, ?)`).run(`g-${parent}`, parent, JSON.stringify(kid ? { refinement_id: kid } : {}), at);
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f']) prop(p, 'archived');
  ground('a', null); // APPLY off: no refinement
  prop('kb', 'needs_more_evidence', 'pb'); panel('pb', 'backlog'); ground('b', 'kb');
  prop('kf', 'proposed'); ground('c', 'kf');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('pf', 'panel_failed', 'self_improvement', 'kf', 'h', 'enforce', 'infra', 'r', ?)`).run(at);
  prop('kr', 'blocked', 'pr'); panel('pr', 'blocked'); ground('d', 'kr');
  prop('kg', 'scheduled'); ground('e', 'kg');
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', 'kg', ?, ?)`).run(at, at);
  prop('kv', 'verified'); ground('f', 'kv');
  // a 'no' grounding is not validly grounded and stays out
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES ('g-no', 'commons_grounding', 'self_improvement', 'z', 'h', 'enforce', 'no', 'r', '{}', ?)`).run(at);
  expect(svc.commonsStats()!.grounding_stops).toEqual({ no_refinement: 1, pending_panel: 0, panel_failed: 1, panel_backlog: 1, rejected: 1, goal: 1, maker: 0, outcome: 1 });
});
