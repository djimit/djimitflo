import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { operatorCockpit } from '../services/operator-cockpit';
import { decisionsInbox } from '../services/decisions-inbox';
import { ensureLaneTables } from '../services/dependency-lane';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { buildDigest } from '../services/operator-push';

// Human-only needs-you (operator 26-10): the headline counts decisions; labelling is optional; system work is shown apart.
let db: Database.Database;
const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ENV = { OUTCOME_ATTRIBUTION_ENABLED: 'true', DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename,
  SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED: 'true', DEPENDENCY_LANE_MODE: 'shadow' } as NodeJS.ProcessEnv;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

function seedAll() {
  db.exec('CREATE TABLE IF NOT EXISTS social_join_requests (id TEXT, status TEXT)'); // created by the social service at runtime
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at) VALUES ('t1', 't', 'd', 'pending', 'low', 'low', 'local', ?, ?)").run(iso(1), iso(1));
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data) VALUES ('a1', 't1', 'pending', 'low', 'tool_call', 'm', '{}')`).run();
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('audit', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/7', auto_merge: { decision: 'audit_sample' } }), iso(5), iso(5));
  run.run('flag', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/8', auto_merge: { decision: 'ineligible' } }), iso(5), iso(5));
  const si = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '[]', ?, ?)`);
  si.run('pre', 'parked', 'needs_more_evidence', iso(5), iso(5)); si.run('prop', 'proposed one', 'proposed', iso(5), iso(5));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('pj', 'proposal_prescreen', 'self_improvement', 'pre', 'h', 'shadow', 'no', 'vague', ?)`).run(iso(4));
  const mem = new MemoryCandidateService(db);
  mem.create({ title: 'rule', content: 'Keep diffs small', memory_type: 'engineering_rule' });
  const dup = mem.create({ title: 'rule 2', content: 'Keep diffs tiny', memory_type: 'engineering_rule' }).id;
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('td', 'memory_template_duplicate', 'memory_candidate', ?, 'tpl:x', 'shadow', 'would_skip', 'r', ?)`).run(dup, iso(1));
  ensureLaneTables(db);
  const pr = db.prepare(`INSERT INTO dependency_lane_prs (pr_number, title, html_url, bump, pr_created_at, check_state, decision, reason, open, updated_at) VALUES (?, ?, NULL, ?, ?, 'success', ?, 'r', 1, ?)`);
  pr.run(1, 'bump a', 'major', iso(24), 'skip_major', iso(1)); pr.run(2, 'bump b', 'minor', iso(24), 'skip_not_npm', iso(1)); pr.run(3, 'bump c', 'patch', iso(24), 'would_merge', iso(1));
}

it('the headline total counts human decisions only; labels are optional labelling with their own count', () => {
  seedAll();
  const n = operatorCockpit(db, NOW, ENV).needs_you;
  expect(n).toMatchObject({ approvals: 1, open_prs: 2, audit_batch: 1, flagged_prs: 1, dependency_human: 2, dependency_tracked: true, memory_review: 1, labels: 1, proposals: 1 });
  // approvals 1 + audit batch 1 + flagged PR 1 + Dependabot left to the human 2 + memory review (not the template duplicate) 1
  expect(n.total).toBe(6);
  expect(n.optional_labelling).toMatchObject({ d5: 1, car: 0, e1: 0 });
  expect(n.system.proposals_auto_reviewed).toBe(true); // the panel reviews 'proposed' rows: system work, not in total
  expect(decisionsInbox(db, NOW, ENV).totals).toMatchObject({ memory: 2, memory_human: 1 });
});

it('without the auto-review panel, proposals are a human decision again; with the lane off Dependabot is not tracked (not a calm 0)', () => {
  seedAll();
  const n = operatorCockpit(db, NOW, { ...ENV, SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED: 'false', DEPENDENCY_LANE_MODE: 'off' }).needs_you;
  expect(n).toMatchObject({ dependency_human: null, dependency_tracked: false });
  expect(n.total).toBe(1 + 1 + 1 + 1 + 1); // approvals, audit, flagged, memory, proposal
});

it('a count that cannot be read makes the total unknown, never 0', () => {
  seedAll();
  db.exec('DROP TABLE memory_candidates');
  const n = operatorCockpit(db, NOW, ENV).needs_you;
  expect(n.memory_review).toBeNull();
  expect(n.total).toBeNull();
});

it('the digest says the same: human decisions in "Waiting for you", labelling apart', () => {
  seedAll();
  const d = buildDigest(db, NOW, ENV);
  expect(d.text).toContain('Waiting for you: 6');
  expect(d.text).toContain('- 2 Dependabot PRs the lane leaves to you');
  expect(d.text).toContain('- 1 PRs in the weekly audit batch');
  expect(d.text).toMatch(/Optional labelling \(not decisions\): D5 1, CAR 0, E1 0/);
});
