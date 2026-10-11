import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { earnedAutonomy, type ClassRecord } from './earned-autonomy';
import { attributionAuditSample, type AttributionAuditSample } from './outcome-attribution';
import { listDraftPrs } from './loop-draft-pr-service';

/**
 * S2 (operator 2026-09-28): the operator's open decisions in one place instead of in chat.
 * - requeue candidates (D2): regressed / infra_failed / no_change proposals of the last 30 days, with any existing requeue
 * - pre-screen labelling (D5): proposals whose latest proposal_prescreen verdict was 'no', with the operator's label if any;
 *   labels are stored as `operator_label` judgments so the false-rejection rate can be computed next to the verdicts.
 *   A proposal the enforced pre-screen parked shows the park reason (`prescreen: …`) and can be requeued (D2)
 * - Telegram allowlist (D3): the rows of telegram_identities (ids only, no tokens)
 * - CAR audit (§16 step 4): this week's seeded sample of computed attributions for the operator to judge correct / wrong /
 *   unclear (POST /self-improve/attribution-audit/:runId); reading the inbox never writes a label
 * A requeue candidate the operator dismissed (`requeue_dismiss` judgment) leaves the list; `no_change` rows stay listed
 * but are not counted as waiting for the operator (see openDecisionCounts).
 */
/**
 * Who has to act on a requeue candidate (Cockpit 3.0; prod 10-10: 59 'needs you' rows, of which 22 were system work):
 * - operator: regressed / infra_failed with a maker or environment attribution (or infra), nobody requeued it yet
 * - budgeted_requeue: newest outcome attribution = reviewer_failure — the daily budgeted requeue handles it
 * - attribution_unknown: regressed with no outcome attribution — evidence first, not a decision
 * - not_actionable: its source lane is switched off, or a later proposal with the same title verified
 * - requeued / no_change: already requeued, or nothing changed
 */
export type RequeueClass = 'operator' | 'budgeted_requeue' | 'attribution_unknown' | 'not_actionable' | 'requeued' | 'no_change';
export interface InboxRequeue { id: string; title: string; status: string; updated_at: string; requeued_as: string | null; queue_class: RequeueClass }
export interface InboxLabel { id: string; title: string; status: string; reason: string; verdict_at: string; label: 'ok' | 'wrong' | null }
export interface DecisionsInbox {
  requeue: InboxRequeue[];
  prescreen: { items: InboxLabel[]; labelled: number; wrong: number; false_rejection_pct: number | null; enforce_threshold: string };
  telegram: Array<{ telegram_user_id: string; user_id: string; email: string | null; role: string | null; added_by: string; created_at: string }>;
  memory: Array<{ id: string; title: string; content: string; memory_type: string; status: string; created_at: string }>;
  autonomy: ClassRecord[];
  attribution_audit: AttributionAuditSample;
  /**
   * Cockpit 3.0: the lists above are paginated (LIMIT 50/100/50); these are the untruncated counts over the same WHERE.
   * null = the count query failed (missing table, SQL error) — never read as 0.
   * requeue_open = regressed / infra_failed, not dismissed, not yet requeued (what openDecisionCounts reports).
   */
  totals: { requeue: number | null; requeue_open: number | null; requeue_classes: Partial<Record<RequeueClass, number>> | null; prescreen: number | null; prescreen_unlabelled: number | null;
    prescreen_labelled: number | null; prescreen_wrong: number | null; memory: number | null;
    /** proposals counted twice in needs-you: operator requeue AND an unlabelled pre-screen rejection */
    shared_subjects: number | null };
  /** Cockpit 3.0 Phase 3 (shadow): needs-you items ranked by expected value; display only, it changes nothing that needs you */
  ranking: RankedItem[];
}

/**
 * Phase 3 smallest experiment: score = expected_gain × reversibility / operator_minutes.
 * expected_gain is measured (null = INSUFFICIENT_EVIDENCE, listed last; never a guess). reversibility and operator_minutes
 * are stated assumptions per kind (`assumed`), not measurements — no operator-effort telemetry exists yet.
 */
export interface RankedItem { kind: 'requeue' | 'loop_pr' | 'label' | 'memory_review'; id: string; title: string;
  expected_gain: number | null; reversibility: number; operator_minutes: number; score: number | null; evidence: string[] }
const KIND_ASSUMPTIONS: Record<RankedItem['kind'], { reversibility: number; operator_minutes: number; why: string }> = {
  requeue: { reversibility: 1, operator_minutes: 1, why: 'assumed: a requeue adds a linked attempt, the original stays (1 click)' },
  loop_pr: { reversibility: 0.5, operator_minutes: 5, why: 'assumed: a merge is revertable but lands on main (review ~5 min)' },
  label: { reversibility: 1, operator_minutes: 1, why: 'assumed: a label is one judgment row, relabel overrides it (1 click)' },
  memory_review: { reversibility: 1, operator_minutes: 2, why: 'assumed: a promoted rule can be retired (read + 1 click)' },
};
const MIN_N = 5;

/** newest outcome_attribution decision on proposal `s` or any of its runs (same rule as the cockpit regression split) */
export const ATTRIBUTION_OF_PROPOSAL = `(SELECT j.decision FROM judgments j WHERE j.judgment = 'outcome_attribution'
      AND ((j.subject_type = 'self_improvement' AND j.subject_id = s.id)
        OR (j.subject_type = 'loop_run' AND j.subject_id IN (SELECT r.id FROM goals g JOIN loop_runs r ON r.goal_id = g.id WHERE g.improvement_id = s.id)))
      ORDER BY j.created_at DESC LIMIT 1)`;

export function decisionsInbox(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): DecisionsInbox {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const count = (sql: string, ...args: unknown[]): number | null => { try { return Number((db.prepare(sql).get(...args) as { n: number }).n); } catch { return null; } };
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const requeueFrom = `FROM self_improvements s WHERE s.status IN ('regressed', 'infra_failed', 'no_change') AND s.updated_at >= ?
      AND NOT EXISTS (SELECT 1 FROM judgments d WHERE d.judgment = 'requeue_dismiss' AND d.subject_id = s.id)`;
  const requeuedAs = `(SELECT c.id FROM self_improvements c WHERE c.evidence_refs_json LIKE '%"requeue-of:' || s.id || '"%' LIMIT 1)`;
  // lanes switched off in this deployment (their failures have no lane to come back to)
  const offLanes = [
    env.REFLECTION_PROPOSALS_MAX_PER_DAY === '0' ? "s.source = 'reflection'" : null,
    env.SELF_IMPROVEMENT_REFINEMENT_ENABLED !== 'true' ? "s.source = 'refinement'" : null,
    // build-failure proposals only; security findings share source 'feedback' and stay actionable
    env.BUILD_ERROR_PROPOSALS_ENABLED === 'false' ? "(s.source = 'feedback' AND s.type != 'security' AND s.evidence_refs_json LIKE '%build:test-failure%')" : null,
  ].filter(Boolean);
  const queueClass = `CASE
      WHEN s.status = 'no_change' THEN 'no_change'
      WHEN ${requeuedAs} IS NOT NULL THEN 'requeued'
      WHEN ${offLanes.length ? `(${offLanes.join(' OR ')}) OR ` : ''}EXISTS (SELECT 1 FROM self_improvements v WHERE v.status = 'verified' AND v.title = s.title
        AND v.id != s.id AND v.created_at > s.created_at) THEN 'not_actionable'
      WHEN ${ATTRIBUTION_OF_PROPOSAL} = 'reviewer_failure' THEN 'budgeted_requeue'
      WHEN s.status = 'regressed' AND ${ATTRIBUTION_OF_PROPOSAL} IS NULL THEN 'attribution_unknown'
      ELSE 'operator' END`;
  const requeue = all<InboxRequeue>(`SELECT s.id, s.title, s.status, s.updated_at, ${requeuedAs} AS requeued_as, ${queueClass} AS queue_class
    ${requeueFrom} ORDER BY s.updated_at DESC LIMIT 50`, d30);
  const classRows = (() => { try { return db.prepare(`SELECT ${queueClass} AS c, COUNT(*) AS n ${requeueFrom} GROUP BY 1`).all(d30) as Array<{ c: RequeueClass; n: number }>; } catch { return null; } })();
  const requeueClasses = classRows ? Object.fromEntries(classRows.map((r) => [r.c, r.n])) as Partial<Record<RequeueClass, number>> : null;
  const labelOf = `(SELECT CASE l.decision WHEN 'yes' THEN 'ok' WHEN 'no' THEN 'wrong' END FROM judgments l
        WHERE l.judgment = 'operator_label' AND l.subject_id = s.id ORDER BY l.created_at DESC LIMIT 1)`;
  const prescreenFrom = `FROM judgments j JOIN self_improvements s ON s.id = j.subject_id
    WHERE j.judgment = 'proposal_prescreen' AND j.decision = 'no'
      AND j.created_at = (SELECT MAX(created_at) FROM judgments x WHERE x.judgment = 'proposal_prescreen' AND x.subject_id = j.subject_id)`;
  const items = all<InboxLabel>(`SELECT s.id, s.title, s.status, j.created_at AS verdict_at,
      COALESCE((SELECT pp.reason FROM judgments pp WHERE pp.judgment = 'prescreen_park' AND pp.subject_id = s.id AND s.status = 'needs_more_evidence'
        ORDER BY pp.created_at DESC LIMIT 1), j.reason) AS reason,
      ${labelOf} AS label
    ${prescreenFrom} ORDER BY j.created_at DESC LIMIT 100`);
  const labels = (() => { try { return db.prepare(`SELECT COUNT(*) AS n, SUM(label IS NULL) AS unlabelled, SUM(label = 'wrong') AS wrong
      FROM (SELECT ${labelOf} AS label ${prescreenFrom})`).get() as { n: number; unlabelled: number | null; wrong: number | null }; } catch { return null; } })();
  const memoryWhere = `FROM memory_candidates WHERE status IN ('review_required', 'candidate')`;
  const totals: DecisionsInbox['totals'] = {
    requeue: requeueClasses ? Object.values(requeueClasses).reduce((a, b) => a + b, 0) : null,
    requeue_open: requeueClasses ? requeueClasses.operator ?? 0 : null,
    requeue_classes: requeueClasses,
    prescreen: labels ? labels.n : null,
    prescreen_unlabelled: labels ? labels.unlabelled ?? 0 : null,
    prescreen_labelled: labels ? labels.n - (labels.unlabelled ?? 0) : null,
    prescreen_wrong: labels ? labels.wrong ?? 0 : null,
    memory: count(`SELECT COUNT(*) AS n ${memoryWhere}`),
    shared_subjects: count(`SELECT COUNT(*) AS n FROM (SELECT s.id ${prescreenFrom} AND ${labelOf} IS NULL) p
      WHERE p.id IN (SELECT s.id ${requeueFrom} AND ${queueClass} = 'operator')`, d30),
  };
  // the D5 rate is over every labelled rejection, not only the 100 newest listed
  const labelled = totals.prescreen_labelled ?? items.filter((i) => i.label).length;
  const wrong = totals.prescreen_wrong ?? items.filter((i) => i.label === 'wrong').length;
  const telegram = all<DecisionsInbox['telegram'][number]>(`SELECT t.telegram_user_id, t.user_id, u.email, u.role, t.added_by, t.created_at
    FROM telegram_identities t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at`);
  // memory review (U4): candidates waiting for a human; promote/reject via /swarms/memory/candidates/:id/{promote,reject}
  const memory = all<DecisionsInbox['memory'][number]>(`SELECT id, title, substr(content, 1, 600) AS content, memory_type, status, created_at ${memoryWhere}
    ORDER BY CASE status WHEN 'review_required' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`);
  const ranking = rankNeedsYou(db, requeue.filter((r) => r.queue_class === 'operator'), items.filter((i) => !i.label), memory, now,
    { labelled: totals.prescreen_labelled, wrong: totals.prescreen_wrong });
  return {
    ranking,
    autonomy: earnedAutonomy(db, now),
    attribution_audit: attributionAuditSample(db, now),
    memory,
    requeue,
    prescreen: { items, labelled, wrong, false_rejection_pct: labelled ? Math.round((1000 * wrong) / labelled) / 10 : null, enforce_threshold: '>= 30 labelled and <= 5 % wrong (D5)' },
    telegram,
    totals,
  };
}

/** Phase 3 shadow ranking over the listed needs-you items; only measured gains, see RankedItem. Never throws. */
export function rankNeedsYou(db: Database, requeue: InboxRequeue[], labels: InboxLabel[], memory: DecisionsInbox['memory'], now: number,
  d5: { labelled: number | null; wrong: number | null }): RankedItem[] {
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const rate = (sql: string, ...args: unknown[]): { p: number | null; n: number; k: number } => {
    try { const r = db.prepare(sql).get(...args) as { k: number | null; n: number | null }; const n = r?.n ?? 0, k = r?.k ?? 0; return { p: n >= MIN_N ? k / n : null, n, k }; }
    catch { return { p: null, n: 0, k: 0 }; }
  };
  // requeue: how often an earlier requeue (a child carrying requeue-of:) verified once it settled, 30 d
  const rq = rate(`SELECT SUM(status = 'verified') AS k, COUNT(*) AS n FROM self_improvements
    WHERE evidence_refs_json LIKE '%"requeue-of:%' AND status IN ('verified', 'regressed', 'infra_failed', 'no_change') AND updated_at >= ?`, d30);
  // loop PR: already verified (gain 1) × merge survival rate of settled loop PRs
  const ms = rate(`SELECT SUM(json_extract(metadata, '$.pr_outcome.survived') = 1) AS k, COUNT(*) AS n FROM loop_runs
    WHERE json_extract(metadata, '$.pr_outcome.survived') IS NOT NULL`);
  // label: before the D5 gate (30 labels) each label is 1/remaining of the way; after it, the chance it catches a wrong rejection
  const labelled = d5.labelled, wrong = d5.wrong;
  const labelGain = labelled === null || wrong === null ? null : labelled < 30 ? 1 / (30 - labelled) : labelled >= MIN_N ? wrong / labelled : null;
  const item = (kind: RankedItem['kind'], id: string, title: string, gain: number | null, why: string): RankedItem => {
    const a = KIND_ASSUMPTIONS[kind];
    const score = gain === null ? null : Math.round((1000 * gain * a.reversibility) / a.operator_minutes) / 1000;
    return { kind, id, title, expected_gain: gain === null ? null : Math.round(1000 * gain) / 1000, reversibility: a.reversibility, operator_minutes: a.operator_minutes,
      score, evidence: [gain === null ? `INSUFFICIENT_EVIDENCE: ${why}` : why, a.why] };
  };
  let prs: ReturnType<typeof listDraftPrs>['rows'] = [];
  try { prs = listDraftPrs(db, 100, now).rows.filter((r) => !r.outcome); } catch { /* table absent */ }
  const out = [
    ...requeue.map((r) => item('requeue', r.id, r.title, rq.p, `earlier requeues verified ${rq.k}/${rq.n} (30 d${rq.n < MIN_N ? `, need ${MIN_N}` : ''})`)),
    ...prs.map((r) => item('loop_pr', String(r.pr_number ?? r.run_id), r.pr_url, ms.p, `merge survival ${ms.k}/${ms.n} settled loop PRs${ms.n < MIN_N ? ` (need ${MIN_N})` : ''}`)),
    ...labels.map((l) => item('label', l.id, l.title, labelGain, labelled === null ? 'label counts unavailable'
      : labelled < 30 ? `D5 gate: ${labelled}/30 labels` : `D5 gate met; ${wrong}/${labelled} labels found a wrong rejection`)),
    ...memory.map((m) => item('memory_review', m.id, m.title, null, 'no fitness exists for an unpromoted candidate')),
  ];
  // measured first, by score; INSUFFICIENT_EVIDENCE last (stable within each group)
  return out.map((r, i) => ({ r, i })).sort((a, b) => (b.r.score ?? -1) - (a.r.score ?? -1) || a.i - b.i).map(({ r }) => r);
}

/** One `needs_you_ranking` shadow judgment per UTC day (top 5), so after 2 weeks we can check whether the operator acted on them first. */
export function recordNeedsYouRanking(db: Database, now = Date.now()): boolean {
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    if (db.prepare("SELECT 1 FROM judgments WHERE judgment = 'needs_you_ranking' AND subject_id = ?").get(day)) return false;
    const top = decisionsInbox(db, now).ranking.slice(0, 5).map((r) => ({ kind: r.kind, id: r.id, score: r.score }));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'needs_you_ranking', 'operator_queue', ?, 'score=gain*reversibility/minutes', 'shadow', 'yes', ?, ?, ?)`)
      .run(randomUUID(), day, `shadow ranking of ${top.length} top needs-you items`, JSON.stringify(top), new Date(now).toISOString());
    return true;
  } catch { return false; }
}

/**
 * Needs-you counts shared by the cockpit and the daily digest. Requeue counts only the `operator` class (see RequeueClass):
 * system-side rows (budgeted requeue, unknown attribution, not actionable) are counted in totals.requeue_classes instead.
 * Counts come from the untruncated totals (prod 10-10: the listed arrays stop at 50/100); null = the count failed.
 */
export function openDecisionCounts(inbox: DecisionsInbox): { requeue: number | null; labels: number | null; memory_review: number | null; shared_subjects: number | null } {
  return { requeue: inbox.totals.requeue_open, labels: inbox.totals.prescreen_unlabelled, memory_review: inbox.totals.memory, shared_subjects: inbox.totals.shared_subjects };
}

/** D2: the operator decides a requeue candidate needs no requeue; audited as a `requeue_dismiss` judgment, the row leaves the list. */
export function dismissRequeue(db: Database, improvementId: string, actor: string, reason = ''): void {
  const row = db.prepare(`SELECT status FROM self_improvements WHERE id = ? AND status IN ('regressed', 'infra_failed', 'no_change')`).get(improvementId) as { status: string } | undefined;
  if (!row) throw new Error('DISMISS_NOT_A_REQUEUE_CANDIDATE');
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 300);
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'requeue_dismiss', 'self_improvement', ?, ?, 'enforce', 'yes', ?, ?)`)
    .run(randomUUID(), improvementId, row.status, `requeue candidate (${row.status}) dismissed by ${actor}${why ? `: ${why}` : ''}`, new Date().toISOString());
}

/** D5: the operator's verdict on a pre-screen rejection ('ok' = rejecting was right, 'wrong' = it deserved a panel). */
export function labelPrescreen(db: Database, improvementId: string, label: 'ok' | 'wrong', actor: string): void {
  const verdict = db.prepare(`SELECT 1 FROM judgments WHERE judgment = 'proposal_prescreen' AND subject_id = ? AND decision = 'no' LIMIT 1`).get(improvementId);
  if (!verdict) throw new Error('LABEL_NO_PRESCREEN_REJECTION');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'operator_label', 'self_improvement', ?, 'proposal_prescreen', 'enforce', ?, ?, ?)`)
    .run(randomUUID(), improvementId, label === 'ok' ? 'yes' : 'no', `proposal_prescreen rejection labelled '${label}' by ${actor}`, new Date().toISOString());
}

/** D3: add or remove an allowlist row (ids only). The mapped user must exist. */
export function setTelegramIdentity(db: Database, telegramUserId: string, userId: string | null, actor: string, note?: string): void {
  const id = String(telegramUserId).trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('TELEGRAM_ID_INVALID');
  const audit = (what: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'telegram_access', 'telegram_user', ?, 'allowlist', 'enforce', 'yes', ?, ?)`).run(randomUUID(), id, `allowlist ${what} by ${actor}`, new Date().toISOString());
  if (userId === null) { db.prepare('DELETE FROM telegram_identities WHERE telegram_user_id = ?').run(id); audit('removed'); return; }
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error('TELEGRAM_USER_NOT_FOUND');
  audit(`set -> ${userId}`);
  db.prepare(`INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET user_id = excluded.user_id, added_by = excluded.added_by, note = excluded.note`)
    .run(id, userId, actor, note?.slice(0, 200) ?? null);
}
