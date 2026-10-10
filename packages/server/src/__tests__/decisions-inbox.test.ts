import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { adjudicateAttribution, attributionAuditSample } from '../services/outcome-attribution';
import { decisionsInbox, dismissRequeue, labelPrescreen, openDecisionCounts, setTelegramIdentity } from '../services/decisions-inbox';
import { requeueImprovement } from '../services/improvement-requeue';

let db: Database.Database;
const NOW = Date.now();
const proposal = (id: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
  VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '["test-gap:x"]', ?, ?)`).run(id, `title ${id}`, status, new Date(NOW - 86_400_000).toISOString(), new Date(NOW - 3_600_000).toISOString());
const prescreen = (id: string, decision: string, at: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'shadow', ?, 'names no concrete file', ?)`).run(`${id}-${at}`, id, decision, at);
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

it('lists requeue candidates with their requeue link', () => {
  proposal('r1', 'regressed'); proposal('v1', 'verified');
  expect(decisionsInbox(db, NOW).requeue.map((r) => [r.id, r.requeued_as])).toEqual([['r1', null]]);
  const copy = requeueImprovement(db, 'r1', { actor: 'op', reason: 'deps fixed (#514)' }, { TEST_GAP_MAX_PER_DAY: '9' });
  expect(decisionsInbox(db, NOW).requeue.find((r) => r.id === 'r1')?.requeued_as).toBe(copy.id);
});

it('lists latest pre-screen rejections and computes the false-rejection rate from operator labels', () => {
  proposal('a', 'needs_more_evidence'); proposal('b', 'needs_more_evidence'); proposal('c', 'verified');
  prescreen('a', 'no', '2026-09-27T00:00:00Z'); prescreen('b', 'no', '2026-09-27T00:00:00Z');
  prescreen('c', 'no', '2026-09-26T00:00:00Z'); prescreen('c', 'yes', '2026-09-27T00:00:00Z'); // latest verdict is yes → not listed
  labelPrescreen(db, 'a', 'ok', 'op'); labelPrescreen(db, 'b', 'wrong', 'op');
  const p = decisionsInbox(db, NOW).prescreen;
  expect(p.items.map((i) => [i.id, i.label]).sort()).toEqual([['a', 'ok'], ['b', 'wrong']]);
  expect([p.labelled, p.wrong, p.false_rejection_pct]).toEqual([2, 1, 50]);
  expect(() => labelPrescreen(db, 'nope', 'ok', 'op')).toThrow('LABEL_NO_PRESCREEN_REJECTION');
});

it('manages the Telegram allowlist with validation and an audit trail', () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'op@x', 'h', 'approver')").run();
  expect(() => setTelegramIdentity(db, 'abc', 'u1', 'op')).toThrow('TELEGRAM_ID_INVALID');
  expect(() => setTelegramIdentity(db, '123', 'ghost', 'op')).toThrow('TELEGRAM_USER_NOT_FOUND');
  setTelegramIdentity(db, '123', 'u1', 'op');
  expect(decisionsInbox(db, NOW).telegram).toEqual([expect.objectContaining({ telegram_user_id: '123', user_id: 'u1', email: 'op@x', role: 'approver', added_by: 'op' })]);
  setTelegramIdentity(db, '123', null, 'op');
  expect(decisionsInbox(db, NOW).telegram).toEqual([]);
  expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all()).toEqual([{ reason: 'allowlist set -> u1 by op' }, { reason: 'allowlist removed by op' }]);
});

it('honest needs-you: no_change rows are listed but not counted; a dismissed candidate leaves the list with an audit row', () => {
  proposal('r1', 'regressed'); proposal('i1', 'infra_failed'); proposal('n1', 'no_change'); proposal('v1', 'verified');
  expect(openDecisionCounts(decisionsInbox(db, NOW)).requeue).toBe(2);
  expect(decisionsInbox(db, NOW).requeue.map((r) => r.id).sort()).toEqual(['i1', 'n1', 'r1']);
  dismissRequeue(db, 'i1', 'op', '  runner was down \n fixed  ');
  expect(decisionsInbox(db, NOW).requeue.map((r) => r.id).sort()).toEqual(['n1', 'r1']);
  expect(openDecisionCounts(decisionsInbox(db, NOW)).requeue).toBe(1);
  expect(db.prepare("SELECT state_hash, decision, reason FROM judgments WHERE judgment = 'requeue_dismiss' AND subject_id = 'i1'").get())
    .toEqual({ state_hash: 'infra_failed', decision: 'yes', reason: 'requeue candidate (infra_failed) dismissed by op: runner was down fixed' });
  expect(() => dismissRequeue(db, 'v1', 'op')).toThrow('DISMISS_NOT_A_REQUEUE_CANDIDATE');
  expect(() => dismissRequeue(db, 'nope', 'op')).toThrow('DISMISS_NOT_A_REQUEUE_CANDIDATE');
});

// ── §16 step 4: CAR audit sampler (weekly, seeded, stratified by computed class); operator labels only ─────────────────
const attributed = (run: string, cls: string, at: string, computed = true) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
  VALUES (?, 'outcome_attribution', ?, ?, ?, 'annotation', ?, ?, ?, ?)`).run(`oa-${run}`, computed ? 'loop_run' : 'self_improvement', run, cls, cls, `rule for ${cls}`,
  computed ? JSON.stringify({ computed: true, failed_gates: cls === 'verified' ? [] : ['checker_verdict'] }) : null, at);
const WED = Date.parse('2026-10-14T12:00:00Z'); // week of Monday 2026-10-12
function seedFrame() {
  const counts: Record<string, number> = { maker_failure: 12, reviewer_failure: 2, environment_failure: 6, verified: 10 };
  for (const [cls, n] of Object.entries(counts)) for (let i = 0; i < n; i++) attributed(`${cls}-${i}`, cls, '2026-10-09T10:00:00Z');
  attributed('s-annotated', 'reviewer_failure', '2026-10-08T17:29:00Z', false); // operator annotation: the reference, not the subject
  attributed('late-run', 'maker_failure', '2026-10-13T09:00:00Z'); // attributed after the week started: next week's frame
}

it('§16 step 4: the weekly CAR sample is seeded, stratified by computed class, frozen for the week and never writes', () => {
  seedFrame();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM judgments').get() as { n: number }).n;
  const s = attributionAuditSample(db, WED);
  expect(s.week_start).toBe('2026-10-12T00:00:00.000Z');
  expect(s.seed).toBe('car-audit:2026-10-12');
  expect(s.frame_n).toBe(30);
  expect(s.items).toHaveLength(10);
  // round-robin over classes: reviewer has only 2, so maker 3 / reviewer 2 / environment 3 / verified 2
  const per = s.items.reduce<Record<string, number>>((a, i) => ({ ...a, [i.computed]: (a[i.computed] ?? 0) + 1 }), {});
  expect(per).toEqual({ maker_failure: 3, reviewer_failure: 2, environment_failure: 3, verified: 2 });
  expect(s.items.some((i) => i.run_id === 'late-run' || i.run_id === 's-annotated')).toBe(false);
  expect(attributionAuditSample(db, WED + 2 * 86_400_000).items.map((i) => i.run_id)).toEqual(s.items.map((i) => i.run_id)); // same week, same sample
  expect(attributionAuditSample(db, WED + 7 * 86_400_000).seed).toBe('car-audit:2026-10-19');
  expect(decisionsInbox(db, WED).attribution_audit.items.map((i) => i.run_id)).toEqual(s.items.map((i) => i.run_id));
  expect((db.prepare('SELECT COUNT(*) AS n FROM judgments').get() as { n: number }).n).toBe(before); // reading never labels
  expect(s.items.every((i) => i.verdict === null)).toBe(true);
});

it('§16 step 4: an operator adjudication is an attribution_audit operator_label judgment; the sample stays fixed; next week skips audited runs', () => {
  seedFrame();
  const s = attributionAuditSample(db, WED);
  const [first, second] = s.items;
  adjudicateAttribution(db, first.run_id, 'correct', 'op-1', '  logs agree \n', WED);
  adjudicateAttribution(db, second.run_id, 'unclear', 'op-1', '', WED);
  adjudicateAttribution(db, second.run_id, 'wrong', 'op-2', 'checker was fine', WED + 60_000); // relabel: newest wins
  const row = db.prepare("SELECT subject_type, state_hash, mode, decision, reason, answers_json FROM judgments WHERE judgment = 'attribution_audit' AND subject_id = ?").get(first.run_id) as Record<string, string>;
  expect(row).toMatchObject({ subject_type: 'loop_run', state_hash: first.computed, mode: 'operator_label', decision: 'correct' });
  expect(row.reason).toBe(`attribution '${first.computed}' judged correct by op-1: logs agree`);
  expect(JSON.parse(row.answers_json)).toMatchObject({ actor: 'op-1', seed: 'car-audit:2026-10-12', computed_reason: `rule for ${first.computed}` });
  const after = attributionAuditSample(db, WED + 120_000);
  expect(after.items.map((i) => i.run_id)).toEqual(s.items.map((i) => i.run_id)); // labelling does not reshuffle the week
  expect(after.items[0]).toMatchObject({ verdict: 'correct', labelled_by: 'op-1' });
  expect(after.items[1]).toMatchObject({ verdict: 'wrong', labelled_by: 'op-2' });
  expect(after.audited).toEqual({ total: 2, correct: 1, wrong: 1, unclear: 0 });
  expect(() => adjudicateAttribution(db, 'late-run', 'correct', 'op-1', '', WED)).toThrow('ATTRIBUTION_AUDIT_NOT_SAMPLED');
  expect(() => adjudicateAttribution(db, first.run_id, 'maybe' as never, 'op-1', '', WED)).toThrow('ATTRIBUTION_AUDIT_VERDICT_INVALID');
  const next = attributionAuditSample(db, WED + 7 * 86_400_000);
  expect(next.items.some((i) => i.run_id === first.run_id || i.run_id === second.run_id)).toBe(false);
  expect(next.frame_n).toBe(29); // 30 − 2 audited + late-run
});
