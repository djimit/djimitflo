import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { operatorCockpit } from '../services/operator-cockpit';
import { decisionsInbox } from '../services/decisions-inbox';

// Cockpit 3.0 P0: a failed measurement is never green, counts are not truncated by pagination, unattributed failures stay visible.
let db: Database.Database;
const NOW = Date.now();
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ON = { OUTCOME_ATTRIBUTION_ENABLED: 'true' } as NodeJS.ProcessEnv;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());
const proposal = (id: string, status: string, o: { title?: string; source?: string; created?: number } = {}) => db.prepare(`INSERT INTO self_improvements
  (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'test', ?, 'd', 'r', ?, ?, '[]', ?, ?)`)
  .run(id, o.title ?? `title ${id}`, o.source ?? 'gap_analysis', status, iso(o.created ?? 24), iso(1));
const attribute = (id: string, decision: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'outcome_attribution', 'self_improvement', ?, 'h', 'annotation', ?, 't', ?)`).run(`a-${id}`, id, decision, iso(1));
const prescreenNo = (id: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'shadow', 'no', 'vague', ?)`).run(`p-${id}`, id, iso(2));
const prRun = (id: string, outcome?: Record<string, unknown>) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${id}`, ...(outcome ? { pr_outcome: outcome } : {}) }), iso(30), iso(30));

it('a failed scorecard query is UNKNOWN, never a green guardrail', () => {
  db.exec('DROP TABLE self_improvements');
  const c = operatorCockpit(db, NOW);
  const reg = c.guardrails.find((g) => g.name === 'regressions')!;
  expect(reg).toMatchObject({ state: 'UNKNOWN', ok: false, value: null });
  expect(c.health).not.toBe('HEALTHY');
  expect(c.errors.some((e) => e.section === 'scorecard')).toBe(true);
  expect(c.needs_you.proposals).toBeNull(); // not 0
  expect(c.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
});

it('needs-you counts all 150 requeue candidates while the listed page stays at 50', () => {
  for (let i = 0; i < 150; i++) { proposal(`r${i}`, 'regressed'); attribute(`r${i}`, 'maker_failure'); }
  const inbox = decisionsInbox(db, NOW);
  expect(inbox.requeue.length).toBeLessThanOrEqual(50);
  expect(inbox.totals.requeue).toBe(150);
  expect(operatorCockpit(db, NOW, ON).needs_you.requeue).toBe(150);
});

it('an unattributed regression is unknown, not maker, and keeps the guardrail out of HEALTHY under attribution', () => {
  for (let i = 0; i < 10; i++) proposal(`v${i}`, 'verified');
  proposal('r1', 'regressed');
  const reg = operatorCockpit(db, NOW, ON).guardrails.find((g) => g.name === 'regressions')!;
  expect(reg.split).toEqual({ maker: 0, reviewer: 0, environment: 0, unknown: 1 });
  expect(reg.state).toBe('DEGRADED');
  expect(reg.ok).toBe(false);
});

it('counts each loop PR once and a proposal waiting in two sections once', () => {
  prRun('1'); prRun('2', { state: 'open' }); prRun('3', { state: 'merged' }); prRun('4', { state: 'merged', survived: true, settled_at: iso(1) });
  proposal('r1', 'regressed'); attribute('r1', 'maker_failure'); prescreenNo('r1');
  db.exec('CREATE TABLE IF NOT EXISTS social_join_requests (id TEXT, status TEXT)'); // created by the social service at runtime; missing = total unknown
  const n = operatorCockpit(db, NOW, ON).needs_you;
  expect(n.open_prs).toBe(2); // never-polled + open
  expect(n.draft_prs).toBe(1); // merged, still settling — not the never-polled PR again
  expect([n.requeue, n.labels, n.shared_subjects]).toEqual([1, 1, 1]);
  expect(n.total).toBe(2 + 1 + 1 - 1);
});

it('reflection inflow is NOT_APPLICABLE with reflection proposals capped at 0; the expired-approvals limit names its rule', () => {
  const c = operatorCockpit(db, NOW, { REFLECTION_PROPOSALS_MAX_PER_DAY: '0' } as NodeJS.ProcessEnv);
  expect(c.guardrails.find((g) => g.name === 'reflection inflow (24 h)')?.state).toBe('NOT_APPLICABLE');
  expect(c.guardrails.find((g) => g.name === 'approvals expired (7 d)')?.limit).toBe('<= decided/5 (7 d)');
});

it('requeue candidates are classed; only operator rows count as needs-you, every row stays listed', () => {
  proposal('op', 'infra_failed');
  proposal('rev', 'regressed'); attribute('rev', 'reviewer_failure');
  proposal('unk', 'regressed');
  proposal('refl', 'regressed', { source: 'reflection' }); attribute('refl', 'maker_failure');
  proposal('old', 'regressed', { title: 'same target', created: 48 }); attribute('old', 'maker_failure');
  proposal('new', 'verified', { title: 'same target', created: 12 });
  const inbox = decisionsInbox(db, NOW, { REFLECTION_PROPOSALS_MAX_PER_DAY: '0' } as NodeJS.ProcessEnv);
  expect(Object.fromEntries(inbox.requeue.map((r) => [r.id, r.queue_class]))).toEqual({
    op: 'operator', rev: 'budgeted_requeue', unk: 'attribution_unknown', refl: 'not_actionable', old: 'not_actionable' });
  expect(inbox.totals.requeue_classes).toEqual({ operator: 1, budgeted_requeue: 1, attribution_unknown: 1, not_actionable: 2 });
  const n = operatorCockpit(db, NOW, { ...ON, REFLECTION_PROPOSALS_MAX_PER_DAY: '0' }).needs_you;
  expect(n.requeue).toBe(1);
  expect(n.system_requeue).toEqual({ budgeted_requeue: 1, attribution_unknown: 1, not_actionable: 2 });
});

it('separates window spend per verified change from the verified changes\' own lease tokens', () => {
  proposal('v1', 'verified');
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g1', 'o', 'low', 'completed', 'v1')`).run();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, goal_id, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run1', 'test-gap', 'g1', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(iso(3), iso(3));
  const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?)");
  lease.run('own', 'run1', JSON.stringify({ runtime_usage: { total_tokens: 1_000_000 } }), iso(3));
  lease.run('other', 'elsewhere', JSON.stringify({ runtime_usage: { total_tokens: 3_000_000 } }), iso(3));
  const s = operatorCockpit(db, NOW).scorecard;
  expect(s.spend_per_verified_change_7d).toBe(4_000_000);
  expect(s.tokens_per_verified_change_7d).toBe(4_000_000);
  expect(s.direct_tokens_per_verified_change_7d).toBe(1_000_000);
});
