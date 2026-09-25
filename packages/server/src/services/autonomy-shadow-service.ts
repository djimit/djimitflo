import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

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
      ? db.prepare('SELECT type, source, grounding_json, description FROM self_improvements WHERE id = ?').get(goal.improvement_id) as { type: string; source: string; grounding_json: string | null; description: string } | undefined
      : undefined;
    const testOnly = Boolean(imp && (/__tests__\//.test(imp.grounding_json || '') || /test-only/i.test(imp.description)));
    const risk = goal?.risk_class ?? 'unknown';
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
