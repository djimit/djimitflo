import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { judgmentMode, runJudgment } from './judgment-service';
import { riskAtomic, riskAtomicState } from './judgments/risk-atomic';

/**
 * Earned autonomy, shadow only (plan E3). Every human approval a loop run waits for gets a recorded "would have
 * auto-approved" decision, so agreement with the operator's real decision can be measured (funnel `judgments`,
 * outcome = the approval's final status) before anything is ever auto-approved. Nothing here approves anything.
 *
 * Rule (deliberately conservative, hard limits from the masterplan WS-C): yes only when the change is test-only, the goal
 * is not high risk / security, and the same class (loop × test-only × risk) already has >= MIN_VERIFIED verified outcomes
 * and no regression. AUTONOMY_SHADOW_ENABLED=true to record (default off).
 */
const MIN_VERIFIED = 3;

export const autonomyShadowEnabled = (): boolean => process.env.AUTONOMY_SHADOW_ENABLED === 'true';

export function recordAutoApproveShadow(db: Database, goalId: string, runId: string, approvalId: string): { decision: 'yes' | 'no'; reason: string } | null {
  if (!autonomyShadowEnabled()) return null;
  try {
    if (db.prepare("SELECT 1 FROM judgments WHERE judgment = 'auto_approve_shadow' AND subject_id = ?").get(approvalId)) return null;
    const goal = db.prepare('SELECT risk_class, improvement_id FROM goals WHERE id = ?').get(goalId) as { risk_class: string; improvement_id: string | null } | undefined;
    const run = db.prepare('SELECT loop_name FROM loop_runs WHERE id = ?').get(runId) as { loop_name: string } | undefined;
    const imp = goal?.improvement_id
      ? db.prepare('SELECT type, source, grounding_json, description, title FROM self_improvements WHERE id = ?').get(goal.improvement_id) as { type: string; source: string; grounding_json: string | null; description: string; title: string } | undefined
      : undefined;
    const testOnly = Boolean(imp && (/__tests__\//.test(imp.grounding_json || '') || /test-only/i.test(imp.description)));
    const risk = goal?.risk_class ?? 'unknown';
    // S1: jev's atomic risk answers next to the keyword class, per approval wait (shadow, fire-and-forget, fail-open)
    if (imp && judgmentMode(riskAtomic.id) !== 'off') {
      let target: string | null = null; try { target = (JSON.parse(imp.grounding_json || '{}') as { target?: string }).target ?? null; } catch { /* no grounding */ }
      void runJudgment(db, riskAtomic, { type: 'approval', id: approvalId }, riskAtomicState({ title: imp.title, description: imp.description, target }), undefined,
        { testOnly, keywordRisk: risk }).catch(() => null);
    }
    const history = imp ? db.prepare(`SELECT
        SUM(status IN ('verified','evaluating','applied')) AS verified, SUM(status = 'regressed') AS regressed
      FROM self_improvements WHERE source = ? AND type = ?`).get(imp.source, imp.type) as { verified: number | null; regressed: number | null } : { verified: 0, regressed: 0 };
    const verified = history.verified ?? 0; const regressed = history.regressed ?? 0;
    const blockers = [
      !testOnly && 'not test-only', risk === 'high' && 'high risk', imp?.type === 'security' && 'security',
      verified < MIN_VERIFIED && `only ${verified}/${MIN_VERIFIED} verified in class`, regressed > 0 && `${regressed} regression(s) in class`,
    ].filter(Boolean) as string[];
    const decision = blockers.length ? 'no' : 'yes';
    const reason = `class=${run?.loop_name ?? '?'}|${testOnly ? 'test-only' : 'code'}|${risk} verified=${verified} regressed=${regressed}${blockers.length ? ` blockers=${blockers.join('; ')}` : ''}`;
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, model, created_at)
      VALUES (?, 'auto_approve_shadow', 'approval', ?, '', 'shadow', ?, ?, '{}', 0, 'rule-v1', ?)`).run(randomUUID(), approvalId, decision, reason, new Date().toISOString());
    return { decision, reason };
  } catch { return null; } // shadow bookkeeping must never affect the loop
}

/**
 * J5 (plan WS-L): the first real auto-approve, for one lane only. LOOP_AUTO_APPROVE_TEST_GAP=true (default off; enabling it
 * is the operator's decision) lets a maker approval be decided by the rule above when the goal comes from the test-gap
 * source and its artifact is a single new test file. Returns that file (the only path the maker may touch; the
 * `auto_approved_scope` verification gate enforces it) or null. Checker, deterministic checks and a human merge stay.
 */
export function testGapAutoApproveScope(db: Database, goalId: string): string | null {
  if (process.env.LOOP_AUTO_APPROVE_TEST_GAP !== 'true') return null;
  const imp = db.prepare(`SELECT s.evidence_refs_json AS refs, json_extract(s.grounding_json, '$.artifactPath') AS artifact
    FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?`).get(goalId) as { refs: string | null; artifact: string | null } | undefined;
  if (!imp?.artifact || !/^packages\/server\/src\/__tests__\/[\w.-]+\.test\.ts$/.test(imp.artifact)) return null;
  if (/"test-gap:/.test(imp.refs || '')) return imp.artifact;
  // M2 lane (LOOP_AUTO_APPROVE_MUTATION_GAP, default off): same one-test-file scope, and its fitness is measured in code by
  // the mutation-gain check; only after the lane itself has >= 1 verified, human-approved run.
  if (/"mutation-gap:/.test(imp.refs || '') && process.env.LOOP_AUTO_APPROVE_MUTATION_GAP === 'true') {
    const proven = (db.prepare("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'verified' AND evidence_refs_json LIKE '%\"mutation-gap:%'").get() as { n: number }).n;
    return proven >= 1 ? imp.artifact : null;
  }
  return null;
}

/**
 * FINDING_FIX_AUTO_APPROVE = off (default: nothing past the flag is read) | on (operator 2026-11-14). The finding-fix lane
 * (finding-fix-source.ts) was "never auto-approved": testGapAutoApproveScope above only scopes a single new test file, so every
 * finding-fix maker waited for the human. With on, a finding-fix lane maker is approved by FINDING_FIX_AUTO_APPROVER through
 * the same daemon path and the same `auto_approved_scope` gate as the oracle lanes, when the proposal carries its
 * `finding-fix:` and `finding-file:` refs and its grounding artifactPath is that file — a non-test source file in
 * packages/server/src, so any other change (a second file, a manifest / lockfile / config / .github, a removed test) fails the
 * scope gate. `auto_approved_max_lines` adds this lane's cap (diff_lines <= 40) to that gate. Checker, security checker, the
 * finding-fix gate, the panel and the human merge are unchanged.
 * Self-revocation: when a run whose maker FINDING_FIX_AUTO_APPROVER approved regressed (proposal regressed, merge survival
 * settled regressed, a failed/removed settlement, or a revoked auto-merge window = revert / red main), one
 * `finding_fix_auto_approve_revoked` judgment is recorded (audited) and from then on the lane is never auto-approved again;
 * that row is the revoked state. There is no re-enable path yet (the operator turns the flag off; re-enabling is a later step).
 */
export const FINDING_FIX_AUTO_APPROVER = 'autonomy:finding-fix-v1';
export const FINDING_FIX_AUTO_APPROVE_MAX_LINES = 40;
export const FINDING_FIX_AUTO_APPROVE_REVOKED = 'finding_fix_auto_approve_revoked';
export const findingFixAutoApproveOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.FINDING_FIX_AUTO_APPROVE === 'on';
const FINDING_FIX_SOURCE = /^packages\/server\/src\/[\w./-]+\.(?:ts|js|mjs|cjs)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]s$/;
const isFindingFixSource = (file: string): boolean => FINDING_FIX_SOURCE.test(file) && !TEST_FILE.test(file) && !file.split('/').includes('..');

/** The finding file a finding-fix maker may change when FINDING_FIX_AUTO_APPROVE=on and the lane is not revoked, else null. */
export function findingFixAutoApproveScope(db: Database, goalId: string): string | null {
  if (!findingFixAutoApproveOn()) return null;
  const imp = db.prepare(`SELECT s.evidence_refs_json AS refs, json_extract(s.grounding_json, '$.artifactPath') AS artifact
    FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?`).get(goalId) as { refs: string | null; artifact: string | null } | undefined;
  let refs: unknown[] = [];
  try { refs = JSON.parse(imp?.refs || '[]'); } catch { return null; }
  const strings = Array.isArray(refs) ? refs.filter((r): r is string => typeof r === 'string') : [];
  const file = strings.find((r) => r.startsWith('finding-file:'))?.slice('finding-file:'.length);
  if (!file || imp?.artifact !== file || !strings.some((r) => r.startsWith('finding-fix:')) || !isFindingFixSource(file)) return null;
  return findingFixAutoApproveRevoked(db) ? null : file;
}

/** The lane's revoked state: the first revocation judgment, else a regression of an auto-approved run (recorded once). Fails closed. */
export function findingFixAutoApproveRevoked(db: Database, now = new Date()): { run_id: string; reason: string } | null {
  try {
    const prior = db.prepare('SELECT subject_id, reason FROM judgments WHERE judgment = ? ORDER BY created_at LIMIT 1').get(FINDING_FIX_AUTO_APPROVE_REVOKED) as { subject_id: string; reason: string | null } | undefined;
    if (prior) return { run_id: prior.subject_id, reason: prior.reason ?? '' };
    const rows = db.prepare(`SELECT DISTINCT r.id AS run_id, a.id AS approval_id, s.status AS status, json_extract(r.metadata, '$.pr_outcome.state') AS pr_state,
        json_extract(r.metadata, '$.pr_outcome.survived') AS survived, json_extract(r.metadata, '$.auto_merge.revoked') AS reverted,
        (SELECT j.decision FROM judgments j WHERE j.judgment = 'settlement_execution' AND j.subject_id = r.id ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS settlement
      FROM approvals a
      JOIN worker_leases l ON l.role = 'maker' AND (json_extract(l.metadata, '$.approval_id') = a.id OR json_extract(l.metadata, '$.execution_task_id') = a.task_id)
      JOIN loop_runs r ON r.id = l.loop_run_id
      LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE a.decided_by = ? AND a.status = 'approved' ORDER BY a.decided_at`).all(FINDING_FIX_AUTO_APPROVER) as Array<{ run_id: string; approval_id: string; status: string | null; pr_state: string | null; survived: number | null; reverted: string | null; settlement: string | null }>;
    for (const r of rows) {
      const why = [r.status === 'regressed' && 'outcome regressed', r.pr_state === 'merged' && r.survived === 0 && 'merge survival settled regressed',
        (r.settlement === 'fail' || r.settlement === 'removed') && `settlement ${r.settlement}`, r.reverted && `auto-merge window revoked: ${r.reverted}`].filter(Boolean) as string[];
      if (!why.length) continue;
      const reason = `run ${r.run_id} (approval ${r.approval_id}, ${FINDING_FIX_AUTO_APPROVER}): ${why.join('; ')}`.slice(0, 500);
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, model, created_at)
        VALUES (?, ?, 'loop_run', ?, '', 'act', 'revoked', ?, ?, 0, 'rule-v1', ?)`).run(randomUUID(), FINDING_FIX_AUTO_APPROVE_REVOKED, r.run_id, reason, JSON.stringify({ ...r, signals: why }), now.toISOString());
      try {
        new AuditService(db).record({ event_type: AuditEventType.CONFIG_CHANGED, action: FINDING_FIX_AUTO_APPROVE_REVOKED, resource_type: 'finding_fix_auto_approve', resource_id: r.run_id,
          risk_level: RiskLevel.HIGH, metadata: { reason, approval_id: r.approval_id, signals: why } });
      } catch { /* the judgment row is the revoked state either way */ }
      return { run_id: r.run_id, reason };
    }
    return null;
  } catch { return { run_id: '', reason: 'revocation state unreadable' }; }
}
