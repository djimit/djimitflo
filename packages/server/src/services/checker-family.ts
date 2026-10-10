import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { cohenKappa } from './honest-numbers';
import { rng } from './gym-mutants';
import { leaseIdentity } from './reviewer-independence-service';
import { LoopEventService } from './loop-event-service';

/**
 * F2 (operator-approved 10-10): does a checker of a different model family than the maker catch more defects?
 * F1 (09-10) found the prod checker (opencode on ollama/glm-5.2:cloud, the maker's family) discriminates (AUC 0.875) but
 * accepted 3/7 diffs whose matchers were weakened to toBeDefined().
 *
 * CHECKER_FAMILY_RANDOMISE=off|on (default off, acting). For an oracle-lane goal (evolveEligible: test-gap / mutation-gap /
 * metadata.evolve) whose automated checker runs on opencode, the arm is sha256('checker-family:' + goal id): 'same' keeps
 * the checker's model (the runtime default), 'cross' sets CHECKER_CROSS_MODEL as the checker lease's model (the executor
 * passes it as --model). The security checker is never touched. Arm and reviewer model go on the checker lease, the goal
 * (metadata.checker_family_arm / checker_model) and a `checker_family_arm` loop event; evolution-evidence `checker_family`
 * compares the arms.
 *
 * Cross model rule (documented, 10-10): the first model that is (1) registered in prod's opencode provider config, so no
 * config change, (2) of another family than the maker by leaseIdentity's family token, and (3) already used in prod as a
 * reviewer. /app/opencode.json registers qwen3.5:cloud, glm-5.2:cloud and kimi-k3:cloud; kimi-k3 (Moonshot) is the panel
 * reviewer (MODEL_CANDIDATES_PANEL_REVIEW) → ollama/kimi-k3:cloud. deepseek / gpt-oss are not registered with opencode.
 *
 * Pre-registered: stop and report at CHECKER_FAMILY_STOP_PER_ARM labelled goals per arm; the hypothesis (cross agrees
 * better with the outcome) is falsified if the bootstrap 95 % CI of Δkappa (cross − same) includes 0.
 */
export const DEFAULT_CHECKER_CROSS_MODEL = 'ollama/kimi-k3:cloud';
export const CHECKER_FAMILY_STOP_PER_ARM = 30;
export type CheckerFamilyArm = 'same' | 'cross';

export const checkerFamilyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.CHECKER_FAMILY_RANDOMISE === 'on';
export const checkerCrossModel = (env: NodeJS.ProcessEnv = process.env): string => env.CHECKER_CROSS_MODEL?.trim() || DEFAULT_CHECKER_CROSS_MODEL;
/** ~50/50, salted so it is independent of the X1 and memory-holdout arms. */
export const checkerFamilyArm = (goalId: string): CheckerFamilyArm =>
  (createHash('sha256').update(`checker-family:${goalId}`).digest()[0] % 2 === 0 ? 'same' : 'cross');

const parse = (s: string | null | undefined): Record<string, unknown> => { try { return JSON.parse(s || '{}') as Record<string, unknown>; } catch { return {}; } };

/**
 * Assign the arm of a goal to its (prepared) checker lease. Arm 'cross' sets lease.metadata.model; 'same' leaves it.
 * Both stamp the arm and the reviewer model on the lease and goal and log an event. The arm decides even if a record fails.
 */
export function assignCheckerFamily(db: Database, runId: string, goalId: string, checkerLeaseId: string, runtime: string,
  env: NodeJS.ProcessEnv = process.env): CheckerFamilyArm {
  const arm = checkerFamilyArm(goalId);
  const lease = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(checkerLeaseId) as { metadata: string } | undefined;
  const meta = parse(lease?.metadata);
  const maker = typeof meta.maker_lease_id === 'string'
    ? parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(meta.maker_lease_id) as { metadata: string } | undefined)?.metadata) : {};
  const model = arm === 'cross' ? checkerCrossModel(env) : undefined;
  const id = leaseIdentity(runtime, model ?? (typeof meta.model === 'string' ? meta.model : undefined), '', env);
  const makerFamily = typeof maker.model_family === 'string' ? maker.model_family : null;
  const stamp = { ...(model ? { model } : {}), checker_family_arm: arm, checker_model_id: id.model_id, checker_model_family: id.model_family, maker_model_family: makerFamily };
  db.prepare('UPDATE worker_leases SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...meta, ...stamp }), checkerLeaseId);
  try {
    db.prepare("UPDATE goals SET metadata = json_set(json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.checker_family_arm', ?), '$.checker_model', ?) WHERE id = ?")
      .run(arm, id.model_id, goalId);
    new LoopEventService(db).recordEvent(runId, 'checker_family_arm', 'info', `F2 checker family: arm ${arm}, checker ${id.model_id} (${id.model_family}) for a ${makerFamily ?? 'unknown'} maker`,
      { goal_id: goalId, arm, lease_id: checkerLeaseId, checker_model: id.model_id, checker_model_family: id.model_family, maker_model_family: makerFamily });
  } catch { /* the arm still decides; only the record is best-effort */ }
  return arm;
}

const LABELS = ['accepted', 'needs_revision', 'rejected'] as const;
const CHECKER_GATES = new Set(['checker_verdict', 'maker_checker_separation']);
interface Row { arm: CheckerFamilyArm; verdict: string; cross: boolean; outcome: 0 | 1 | null; woChecker: 0 | 1 | null; survived: 0 | 1 | null; strength: 'pass' | 'fail' | null }

/** binary kappa: checker accepted vs label 1 */
const kappaOf = (rows: Array<{ verdict: string; y: 0 | 1 }>): number | null => {
  const t = [[0, 0], [0, 0]];
  for (const r of rows) t[r.verdict === 'accepted' ? 0 : 1][r.y === 1 ? 0 : 1]++;
  const k = cohenKappa(t);
  return k === null ? null : +k.toFixed(4);
};
const labelled = (rows: Row[], key: 'outcome' | 'woChecker' | 'survived') => rows.filter((r) => r[key] !== null).map((r) => ({ verdict: r.verdict, y: r[key] as 0 | 1 }));
const agreeCount = (rows: Array<{ verdict: string; y: 0 | 1 }>) => rows.filter((r) => (r.verdict === 'accepted') === (r.y === 1)).length;

/** Seeded two-sample bootstrap 95 % interval of kappa(cross) − kappa(same). */
function deltaKappaCi(same: Array<{ verdict: string; y: 0 | 1 }>, cross: Array<{ verdict: string; y: 0 | 1 }>, seed = 42, B = 1000): [number, number] | null {
  if (same.length < 2 || cross.length < 2) return null;
  const r = rng(seed); const vals: number[] = [];
  const resample = <T>(s: T[]) => Array.from({ length: s.length }, () => s[Math.floor(r() * s.length)]);
  for (let b = 0; b < B; b++) {
    const kc = kappaOf(resample(cross)); const ks = kappaOf(resample(same));
    if (kc !== null && ks !== null) vals.push(kc - ks);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return [+vals[Math.floor(0.025 * vals.length)].toFixed(4), +vals[Math.min(vals.length - 1, Math.floor(0.975 * vals.length))].toFixed(4)];
}

/**
 * evolution-evidence `checker_family`: per arm the final checker verdict of each randomised goal, its agreement with the
 * attributed outcome (verified = 1, maker_failure = 0; reviewer_failure / environment_failure excluded), Cohen's kappa, and
 * the maker's assertion-strength result (WEAK_ASSERTION_CHECK_MODE shadow/enforce) as a second ground truth for test lanes.
 */
export function checkerFamilyEvidence(db: Database, since: string, env: NodeJS.ProcessEnv, fisher: (a: number, b: number, c: number, d: number) => number) {
  let leases: Array<{ run_id: string; goal_id: string; metadata: string; run: string | null; maker: string | null; decision: string | null; answers: string | null }> = [];
  let goals: Array<{ arm: string; n: number }> = [];
  try {
    goals = db.prepare(`SELECT json_extract(metadata, '$.checker_family_arm') AS arm, COUNT(*) AS n FROM goals
      WHERE json_extract(metadata, '$.checker_family_arm') IN ('same', 'cross') AND created_at >= ? GROUP BY 1`).all(since) as typeof goals;
    leases = db.prepare(`SELECT l.loop_run_id AS run_id, r.goal_id, l.metadata, r.metadata AS run, m.metadata AS maker,
        (SELECT j.decision FROM judgments j WHERE j.judgment = 'outcome_attribution' AND j.subject_type = 'loop_run' AND j.subject_id = l.loop_run_id ORDER BY j.created_at DESC LIMIT 1) AS decision,
        (SELECT j.answers_json FROM judgments j WHERE j.judgment = 'outcome_attribution' AND j.subject_type = 'loop_run' AND j.subject_id = l.loop_run_id ORDER BY j.created_at DESC LIMIT 1) AS answers
      FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id JOIN goals g ON g.id = r.goal_id
      LEFT JOIN worker_leases m ON m.id = json_extract(l.metadata, '$.maker_lease_id')
      WHERE l.role = 'checker' AND l.status = 'completed' AND json_extract(l.metadata, '$.checker_family_arm') IN ('same', 'cross') AND g.created_at >= ?
      ORDER BY l.created_at, l.rowid`).all(since) as typeof leases;
  } catch { /* missing tables */ }
  const byGoal = new Map<string, Row>(); // the goal's last labelled checker verdict (a retry or a later run supersedes)
  for (const l of leases) {
    const m = parse(l.metadata);
    if (!LABELS.includes(m.verdict as typeof LABELS[number])) continue;
    const outcome = l.decision === 'verified' ? 1 : l.decision === 'maker_failure' ? 0 : null;
    const gates = ((parse(l.answers).failed_gates as unknown[] | undefined) ?? []).map(String).filter((g) => !CHECKER_GATES.has(g));
    const check = ((parse(l.maker).deterministic_checks as Array<Record<string, unknown>> | undefined) ?? []).find((c) => c?.name === 'test:assertion-strength');
    const s = check ? (check.shadow_status ?? check.status) : null;
    const survived = (parse(l.run).pr_outcome as { survived?: unknown } | undefined)?.survived;
    byGoal.set(l.goal_id, {
      arm: m.checker_family_arm as CheckerFamilyArm, verdict: String(m.verdict),
      cross: typeof m.maker_model_family === 'string' && typeof m.checker_model_family === 'string' && m.maker_model_family !== m.checker_model_family,
      outcome, woChecker: outcome === null ? null : gates.length ? 0 : 1, survived: survived === true ? 1 : survived === false ? 0 : null, strength: s === 'pass' || s === 'fail' ? s : null,
    });
  }
  const rows = [...byGoal.values()];
  const arm = (name: CheckerFamilyArm) => {
    const rs = rows.filter((r) => r.arm === name);
    const out = labelled(rs, 'outcome'); const wo = labelled(rs, 'woChecker'); const sv = labelled(rs, 'survived');
    const strong = rs.filter((r) => r.strength !== null); const weak = strong.filter((r) => r.strength === 'fail');
    const caught = weak.filter((r) => r.verdict !== 'accepted').length;
    return {
      goals: goals.find((g) => g.arm === name)?.n ?? 0, reviewed: rs.length,
      verdicts: Object.fromEntries(LABELS.map((v) => [v, rs.filter((r) => r.verdict === v).length])) as Record<typeof LABELS[number], number>,
      realized_cross: rs.filter((r) => r.cross).length,
      outcome: { n: out.length, agree: agreeCount(out), agreement: out.length ? +(agreeCount(out) / out.length).toFixed(3) : null, kappa: kappaOf(out) },
      outcome_wo_checker: { n: wo.length, agree: agreeCount(wo), kappa: kappaOf(wo) },
      // merge survival (pr_outcome.survived): the label EXPERIMENT_PROTOCOL EXP-1 registers, independent of the checker
      outcome_survival: { n: sv.length, agree: agreeCount(sv), kappa: kappaOf(sv) },
      weak_assertion: { n: strong.length, weak: weak.length, caught, missed: weak.length - caught,
        false_alarms: strong.filter((r) => r.strength === 'pass' && r.verdict !== 'accepted').length,
        sensitivity: weak.length ? +(caught / weak.length).toFixed(3) : null },
      _out: out,
    };
  };
  const { _out: sOut, ...same } = arm('same'); const { _out: cOut, ...cross } = arm('cross');
  const delta = same.outcome.kappa !== null && cross.outcome.kappa !== null ? +(cross.outcome.kappa - same.outcome.kappa).toFixed(4) : null;
  const ci = deltaKappaCi(sOut, cOut);
  const reached = same.outcome.n >= CHECKER_FAMILY_STOP_PER_ARM && cross.outcome.n >= CHECKER_FAMILY_STOP_PER_ARM;
  const verdict = !reached ? 'collecting' : !ci ? 'inconclusive' : ci[0] > 0 ? 'supported' : ci[1] < 0 ? 'reversed' : 'falsified';
  return {
    enabled: env.CHECKER_FAMILY_RANDOMISE ?? null, cross_model: checkerCrossModel(env), same, cross,
    delta_kappa: delta, delta_kappa_ci: ci,
    fisher_p: +fisher(cross.outcome.agree, cross.outcome.n - cross.outcome.agree, same.outcome.agree, same.outcome.n - same.outcome.agree).toPrecision(4),
    weak_fisher_p: +fisher(cross.weak_assertion.caught, cross.weak_assertion.missed, same.weak_assertion.caught, same.weak_assertion.missed).toPrecision(4),
    stop: { per_arm: CHECKER_FAMILY_STOP_PER_ARM, reached, verdict },
    note: 'F2 (CHECKER_FAMILY_RANDOMISE): oracle-lane goals by sha256(checker-family:goal id); same = checker on the runtime default, cross = CHECKER_CROSS_MODEL; security checker unchanged. One row per goal (its last completed checker with a verdict). outcome: verified = 1, maker_failure = 0, reviewer/environment failures excluded — the checker\'s own rejection is part of maker_failure, so outcome_wo_checker relabels from the other failed gates only and outcome_survival uses merge survival (checker-independent; few labels until drafts settle). kappa: binary (accepted vs not). delta_kappa_ci: seeded two-sample bootstrap 95 %. fisher_p: agree/disagree × arm; weak_fisher_p: weak-assertion diffs caught/missed × arm. Pre-registered stop at 30 labelled goals per arm; falsified if the Δkappa CI includes 0.',
  };
}
