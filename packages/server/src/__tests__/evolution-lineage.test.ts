import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { evolutionLineage, NEV_MIN_SETTLED } from '../services/evolution-lineage';
import { operatorCockpit } from '../services/operator-cockpit';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

// 'Restore Evolutionary Health': verified is not fitness — lineage to survival, a 4-way regression split, survival-adjusted NEV.
let db: Database.Database;
const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ON = { OUTCOME_ATTRIBUTION_ENABLED: 'true' } as NodeJS.ProcessEnv;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

const proposal = (id: string, status: string, createdH = 24 * 20) => db.prepare(`INSERT INTO self_improvements
  (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '[]', ?, ?)`)
  .run(id, `t ${id}`, status, iso(createdH), iso(createdH - 2));
const attribute = (id: string, decision: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'outcome_attribution', 'self_improvement', ?, 'h', 'annotation', ?, 't', ?)`).run(`a-${id}`, id, decision, iso(1));
/** a goal + run for proposal `id`; `pr` sets the run's PR settlement */
const run = (id: string, pr?: Record<string, unknown>) => {
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`)
    .run(`g-${id}`, id, iso(24 * 19), iso(24 * 19));
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`)
    .run(`r-${id}`, `g-${id}`, JSON.stringify(pr ? { pr_url: `https://github.com/o/r/pull/${id.replace(/\D/g, '') || 1}`, pr_outcome: pr } : {}), iso(24 * 19), iso(24 * 19));
};

it('a reviewer rejection is not counted as an evolutionary regression; mutation failures are', () => {
  proposal('m1', 'regressed'); run('m1'); attribute('m1', 'maker_failure');
  proposal('v1', 'regressed'); run('v1'); attribute('v1', 'reviewer_failure');
  proposal('v2', 'regressed'); run('v2'); attribute('v2', 'reviewer_failure');
  const e = evolutionLineage(db, NOW, ON);
  expect(e.regression_split).toMatchObject({ mutation_failure: 1, reviewer_rejection: 2, post_verification: 0 });
  expect(e.evolutionary_regressions).toBe(1);
});

it('a verified + merged change that did not survive 14 d is a post-verification regression (also on the cockpit guardrail)', () => {
  proposal('p7', 'verified'); run('p7', { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: false, retained: 0.1 });
  proposal('p8', 'verified'); run('p8', { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true, retained: 0.9 });
  const e = evolutionLineage(db, NOW, ON);
  expect(e.regression_split.post_verification).toBe(1);
  expect(e.evolutionary_regressions).toBe(1);
  const reg = operatorCockpit(db, NOW, ON).guardrails.find((g) => g.name === 'regressions')!;
  expect(reg.split?.post_verification).toBe(1);
  expect(reg.value).toBe(1); // maker failures (0) + post-verification (1)
});

it('funnel conversions follow the lineage and the largest loss is the bottleneck', () => {
  for (let i = 0; i < 10; i++) { proposal(`n${i}`, 'needs_more_evidence'); } // never experimented
  for (let i = 0; i < 10; i++) { proposal(`e${i}`, 'verified'); run(`e${i}`, i < 2 ? { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true } : { state: 'open', checked_at: iso(2) }); }
  const e = evolutionLineage(db, NOW, ON);
  const st = Object.fromEntries(e.stages.map((s) => [s.stage, s]));
  expect(st.proposal.count).toBe(20);
  expect(st.experiment).toMatchObject({ count: 10, conversion: 0.5 });
  expect(st.verified).toMatchObject({ count: 10, conversion: 1 });
  expect(st.merged).toMatchObject({ count: 2, conversion: 0.2 });
  expect(st.verified.top_failure).toMatch(/awaiting_human_merge \(8\)/);
  expect(st.survived_30d).toMatchObject({ count: null, measured: 'not_measured' });
  expect(st.reproduced.measured).toBe('not_measured');
  expect(st.discovery.conversion).toBeNull(); // not linked to proposals — never a made-up conversion
  expect(e.bottleneck).toMatchObject({ from: 'proposal', to: 'experiment', lost: 10 });
});

it('NEV is INSUFFICIENT_EVIDENCE below the settled minimum and never 0', () => {
  proposal('s1', 'verified'); run('s1', { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true });
  proposal('s2', 'verified'); run('s2', { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: true });
  const n = evolutionLineage(db, NOW, ON).nev;
  expect(n.settled).toBeLessThan(NEV_MIN_SETTLED);
  expect(n).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', value: null, per_m_cloud_tokens: null, per_operator_decision: null, survived: 2, settled: 2 });
  expect(n.per_kwh_status).toMatch(/INSUFFICIENT_EVIDENCE/);
});

it('NEV at enough settled lineages = survived − severity × post-verification regressions', () => {
  for (let i = 0; i < 12; i++) { proposal(`k${i}`, 'verified'); run(`k${i}`, { state: 'merged', merged_at: iso(24 * 16), settled_at: iso(24), survived: i < 9 }); }
  const n = evolutionLineage(db, NOW, ON).nev;
  expect(n).toMatchObject({ status: 'ok', survived: 9, settled: 12, value: 9 - 3 });
  expect(n.survival_ci![0]).toBeLessThan(0.75);
});

it('the cockpit and the evidence carry the lineage and the JC-001 rejection', () => {
  const c = operatorCockpit(db, NOW, ON);
  expect(c.evolution?.jev_semantic_routing).toBe('REJECTED by JC-001 (NE-001, PR #779)');
  expect(c.evolution?.throughput.label).toBe('throughput, not improvement');
  expect(buildEvolutionEvidence(db, ON, NOW).lineage.jev_semantic_routing).toMatch(/REJECTED by JC-001/);
});
