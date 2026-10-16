import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { fitnessStatus, knowledgeFitness, knowledgeItem } from '../services/knowledge-fitness';
import { knowledgeOverview } from '../services/knowledge-overview';

let db: Database.Database;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
});

/** A proposal with a panel, its goal and one run settled with `decision`; the panel's KB retrieval cites `pages`. */
let seq = 0;
const run = (decision: string | null, pages: string[], opts: { refs?: string[]; daysAgo?: number; survived?: 0 | 1 } = {}) => {
  const n = ++seq; const pid = `si-${n}`; const runId = `run-${n}`;
  const at = ago(opts.daysAgo ?? 1);
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, panel_id, created_at, updated_at)
    VALUES (?, 'feature', ?, 'd', 'r', 'reflection', 'approved', ?, ?, ?, ?)`).run(pid, `p${n}`, JSON.stringify(opts.refs ?? []), `panel-${n}`, at, at);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`).run(`g-${n}`, pid, at, at);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`).run(runId, `g-${n}`, JSON.stringify(opts.survived === undefined ? {} : { pr_outcome: { survived: opts.survived === 1 } }), at, at);
  if (pages.length) db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'kb_retrieval', 'specialist_panel', ?, 'h', 'shadow', 'yes', ?, ?)`).run(`kb-${n}`, `panel-${n}`, pages.map((p) => `${p}@0.33`).join(' '), ago(opts.daysAgo ?? 1));
  if (decision) db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'outcome_attribution', 'loop_run', ?, ?, 'annotation', ?, 'r', ?)`).run(`oa-${n}`, runId, decision, decision, ago((opts.daysAgo ?? 1) - 0.5));
  return runId;
};
const item = (f: ReturnType<typeof knowledgeFitness>, kind: string, id: string) => f.top.find((i) => i.kind === kind && i.id === id);

it('K1: a page cited in a verified maker-attributed run gets credit; a page in a reviewer_failure run does not', () => {
  run('verified', ['ops/runbook.md'], { survived: 1 });
  run('reviewer_failure', ['ops/other.md']);
  const f = knowledgeFitness(db, NOW);
  expect(item(f, 'kb_page', 'ops/runbook.md')).toMatchObject({ n_used: 1, n_verified: 1, n_regressed: 0, n_survived_14d: 1, status: 'insufficient' });
  expect(item(f, 'kb_page', 'ops/other.md')).toMatchObject({ n_used: 1, n_verified: 0, n_regressed: 0, wilson: null, decayed_verified_rate: null, n_survived_14d: null, status: 'insufficient' });
  expect(f.runs).toEqual({ in_window: 2, maker_attributable: 1, non_maker: 1, unattributed: 0 });
  expect(f.writes).toBe(0);
});

it('K1: n < 5 attributable uses is insufficient (never 0); at 5 the item is judged against the baseline', () => {
  for (let i = 0; i < 4; i++) run('verified', ['a.md']);
  let f = knowledgeFitness(db, NOW);
  expect(item(f, 'kb_page', 'a.md')).toMatchObject({ n_verified: 4, status: 'insufficient' });
  run('maker_failure', ['a.md']);
  for (let i = 0; i < 5; i++) run('maker_failure', ['b.md']);
  f = knowledgeFitness(db, NOW);
  expect(f.baseline).toEqual({ n: 10, verified_rate: 0.4 });
  expect(item(f, 'kb_page', 'a.md')).toMatchObject({ n_used: 5, n_verified: 4, n_regressed: 1, status: 'used_with_value' });
  expect(item(f, 'kb_page', 'a.md')!.wilson![0]).toBeGreaterThan(0.3);
  expect(item(f, 'kb_page', 'b.md')).toMatchObject({ n_regressed: 5, status: 'used_no_value' });
});

it('K1: unattributed and environment runs credit nobody; decay weights recent uses more; unused counts come from the inventory', () => {
  const page = db.prepare("INSERT INTO kb_pages (path, host, title, body, sha, vector, updated_at) VALUES (?, 'h', ?, 'b', 's', ?, ?)");
  page.run('never.md', 'Never used', Buffer.alloc(4), ago(1)); page.run('old.md', 'Old  page', Buffer.alloc(4), ago(1));
  run(null, ['old.md']); run('environment_failure', ['old.md']);
  run('verified', ['old.md'], { daysAgo: 60 }); run('maker_failure', ['old.md'], { daysAgo: 2 });
  const f = knowledgeFitness(db, NOW);
  const old = item(f, 'kb_page', 'old.md')!;
  expect(old).toMatchObject({ title: 'Old page', n_used: 4, n_verified: 1, n_regressed: 1 });
  expect(old.decayed_verified_rate).toBeLessThan(0.5);
  expect(f.runs.unattributed).toBe(1);
  expect(f.by_kind.find((k) => k.kind === 'kb_page')).toMatchObject({ inventory: 2, unused: 1, insufficient: 1 });
  expect(f.by_kind.find((k) => k.kind === 'discovery')).toMatchObject({ inventory: null, unused: null });
});

it('K1: proposal refs, memory reads, genome refs and credits are use edges; a unit credits its discovery', () => {
  db.prepare(`INSERT INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, kind, created_at)
    VALUES ('unit-1', 'GitHarness', '[]', 'CAPABILITY_INFERRED', 0, ?, 1, 'paper', ?)`).run(JSON.stringify({ ref: 'arxiv:2501.1' }), ago(5));
  const r1 = run('verified', [], { refs: ['expert_unit:unit-1', 'requeue-of:x', 'okf:wiki/a'] });
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
    VALUES ('rule-1', 'Run the tests', 'c', 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(ago(9), ago(9));
  db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)').run('a1', 'rule-1', `loop-maker:${r1}`, ago(1));
  const r2 = run('maker_failure', []);
  db.prepare(`INSERT INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at, knowledge_refs_json) VALUES ('gen-1', 'g', '[]', 'dream', 'active', ?, ?, ?)`)
    .run(ago(3), ago(3), JSON.stringify(['unit-1']));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l2', ?, 'maker', 'codex', 'completed', ?, ?, ?)`)
    .run(r2, JSON.stringify({ genome_id: 'gen-1' }), ago(1), ago(1));
  db.exec('CREATE TABLE IF NOT EXISTS outcome_credits (run_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, kind, ref))');
  db.prepare('INSERT INTO outcome_credits VALUES (?, ?, ?, ?)').run(r1, 'knowledge', 'kb:credited.md', ago(1));
  const f = knowledgeFitness(db, NOW);
  expect(item(f, 'expert_unit', 'unit-1')).toMatchObject({ title: 'GitHarness', n_used: 2, n_verified: 1, n_regressed: 1 });
  expect(item(f, 'discovery', 'arxiv:2501.1')).toMatchObject({ n_used: 2 });
  expect(item(f, 'memory_rule', 'rule-1')).toMatchObject({ title: 'Run the tests', n_verified: 1 });
  expect(item(f, 'knowledge', 'okf:wiki/a')).toMatchObject({ n_verified: 1 });
  expect(item(f, 'kb_page', 'credited.md')).toMatchObject({ n_verified: 1 });
});

it('K1: pure helpers and the knowledge overview section', () => {
  expect(knowledgeItem('kb:x.md')).toEqual({ kind: 'kb_page', id: 'x.md' });
  expect(knowledgeItem('claim:c1')).toEqual({ kind: 'expert_claim', id: 'c1' });
  expect(knowledgeItem('requeue-of:p')).toBeNull();
  expect(fitnessStatus(0, 0, 0, 0.5)).toBe('unused');
  expect(fitnessStatus(9, 2, 2, 0.5)).toBe('insufficient');
  expect(knowledgeOverview(db, NOW).fitness).toMatchObject({ min_n: 5, half_life_days: 30, top: [] });
  expect(knowledgeFitness(new Database(':memory:'), NOW)).toMatchObject({ top: [], baseline: { n: 0, verified_rate: null } });
});
