import type { Database } from 'better-sqlite3';
import { ace001Evidence, aceAnalysisSince, ACE_001_TARGET_PER_ARM } from './ace-001';
import { ste001Evidence, STE_001_TARGET_PER_ARM } from './ste-001';
import { makerDeps001Evidence, MAKER_DEPS_001_TARGET_PER_ARM } from './maker-deps-001';
import { effortX1Evidence } from './effort-controller';
import { checkerFamilyEvidence, CHECKER_FAMILY_TARGET_DEFAULT } from './checker-family';
import { tg001Evidence, TG_TASKS } from './tg-001';
import { d5NoEvidence, D5NO_ANALYSIS_N } from './d5-no';
import { jevChallengerEvidence } from './jev-challenger';
import { fisherExact, memoryHoldoutEvidence } from './evolution-evidence';

/**
 * Know when to stop (SOUL.md): one read-only list of the running experiments, each with its registered target n and the
 * stop date its pre-registration (or a dated stop-condition amendment, stop_source) fixes. stop_by null = no date registered (an
 * estimate such as "≈ 45 days" is not a stop date) — that experiment could run forever, which the stall watch reports. The
 * 2026-10-19 amendments gave every experiment one: min(start + 1.25 × target ÷ slowest-arm accrual rate, start + 90 d), or
 * today + 30 d to decide extend vs close INCONCLUSIVE where accrual is ~0. status() reuses the experiment's own
 * evidence function, counting from started_at (not the evidence window), so n is the whole experiment. Nothing here
 * changes an experiment: no flag, no assignment, no prompt.
 */
export interface ExperimentStatus { n_per_arm: Record<string, number> | null; verdict: string | null }
export interface ExperimentDef {
  id: string; flag: string; protocol: string;
  /** when outcomes start counting (protocol / analysis_since); day precision where the protocol gives only a day */
  started_at: string;
  /** registered n per arm; null = the protocol registers none */
  target_n: number | null;
  /** the date the protocol stops at whatever n was reached; null = none registered */
  stop_by: string | null;
  stop_note: string;
  /** the document (and section) that registers stop_by and target_n */
  stop_source: string;
  status: (db: Database, env: NodeJS.ProcessEnv, now: number) => ExperimentStatus;
}

const AMENDED = 'stop condition added 2026-10-19; verdict rules unchanged';
const X1_STARTED = '2026-10-09T00:00:00.000Z';

/** Literal dates (pinned against their source constants in experiment-registry.test.ts): X1 = start + 28 d, D5-NO = cutoff + 90 d.
 *  A function, not a constant: the imported targets are read at call time (stall-watch ↔ d5-no import cycle). */
export const experimentDefs = (): ExperimentDef[] => [
  { id: 'ACE-001', flag: 'ACE_001_MODE', protocol: 'docs/research/ace/ACE-001_PROTOCOL.md', started_at: '2026-10-12T00:00:00.000Z',
    target_n: ACE_001_TARGET_PER_ARM, stop_by: '2026-11-15T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 1.25 × 50 ÷ 1.87/day (slowest arm, 13 in 6.9 d)`, stop_source: 'docs/research/ace/ACE-001_PROTOCOL.md#amendment-2-2026-10-19',
    status: (db, env) => { const e = ace001Evidence(db, aceAnalysisSince(env), env);
      return { n_per_arm: Object.fromEntries(Object.entries(e.arms).map(([a, v]) => [a, v.n])), verdict: null }; } },
  { id: 'STE-001', flag: 'STE_001_MODE', protocol: 'docs/research/ace/STE-001_PROTOCOL.md', started_at: '2026-10-11T00:00:00.000Z',
    target_n: STE_001_TARGET_PER_ARM, stop_by: '2026-11-14T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 1.25 × 100 ÷ 3.78/day (slowest arm, 30 in 7.9 d)`, stop_source: 'docs/research/ace/STE-001_PROTOCOL.md#amendment-1-2026-10-19',
    status: (db, env) => { const e = ste001Evidence(db, '2026-10-11T00:00:00.000Z', env); return { n_per_arm: { 0: e.arms['0'].n, 1: e.arms['1'].n }, verdict: null }; } },
  { id: 'MAKER-DEPS-001', flag: 'MAKER_DEPS_001_MODE', protocol: 'docs/research/di-001/MAKER_DEPS_001_PREREG.md', started_at: '2026-10-14T00:00:00.000Z',
    target_n: MAKER_DEPS_001_TARGET_PER_ARM, stop_by: '2026-12-16T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 1.25 × 141 ÷ 2.83/day (slowest arm, 14 in 4.9 d)`, stop_source: 'docs/research/di-001/MAKER_DEPS_001_AMENDMENT_1.md#amendment-1-2026-10-19',
    status: (db, env) => { const e = makerDeps001Evidence(db, '2026-10-14T00:00:00.000Z', env); return { n_per_arm: { A: e.arms.A.terminal, B: e.arms.B.terminal }, verdict: null }; } },
  { id: 'X1', flag: 'EFFORT_SIBLING_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-2', started_at: X1_STARTED,
    target_n: 94, stop_by: '2026-11-06T00:00:00.000Z', stop_note: 'EXP-2 registration: 4 weeks, ~94 settled per arm', stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-2',
    status: (db, env) => { const e = effortX1Evidence(db, X1_STARTED, env, fisherExact);
      return { n_per_arm: { on: e.on.verified + e.on.regressed, off: e.off.verified + e.off.regressed }, verdict: null }; } },
  { id: 'F2', flag: 'CHECKER_FAMILY_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-1', started_at: '2026-10-17T00:00:00.000Z',
    target_n: CHECKER_FAMILY_TARGET_DEFAULT, stop_by: '2027-01-15T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 90 d cap (v2; 1 settled per arm in 1.9 d projects past the cap)`, stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#amendment-2026-10-19-stop-conditions',
    status: (db, env, now) => { const e = checkerFamilyEvidence(db, '2026-10-17T00:00:00.000Z', env, fisherExact, now);
      return { n_per_arm: { same: e.primary.n.same, cross: e.primary.n.cross }, verdict: e.stop.verdict === 'collecting' ? null : e.stop.verdict }; } },
  { id: 'TG-001', flag: 'TG_001_MODE', protocol: 'docs/research/ace/TG-001_PROTOCOL.md', started_at: '2026-10-11T23:20:22.000Z',
    target_n: TG_TASKS, stop_by: '2026-11-18T00:00:00.000Z',
    stop_note: `${AMENDED}: 20-task result INCONCLUSIVE, the extension to 40 waits on task supply (accrual ~0) → today + 30 d: decide extend or close INCONCLUSIVE`,
    stop_source: 'docs/research/ace/TG-001_PROTOCOL.md#amendment-2026-10-19-stop-condition',
    status: (db, env) => { const e = tg001Evidence(db, env);
      const arms = 'arms' in e && Array.isArray(e.arms) ? e.arms as Array<{ arm: string; n: number }> : [];
      const result = 'result' in e ? (e as { result?: { verdict?: string } }).result : undefined;
      // INCONCLUSIVE at 20 tasks is not a closing verdict: the stopping rule extends once to 40, so the stop date still applies
      const verdict = e.status === 'complete' ? result?.verdict ?? null : null;
      return { n_per_arm: arms.length ? Object.fromEntries(arms.map((a) => [a.arm, a.n])) : null, verdict: verdict === 'inconclusive' ? null : verdict }; } },
  { id: 'D5-NO', flag: 'TYPESAFE_PROPOSAL_PRESCREEN_MODE', protocol: 'docs/research/eco/D5NO_PROTOCOL.md', started_at: '2026-10-11T21:00:00.000Z',
    target_n: D5NO_ANALYSIS_N, stop_by: '2027-01-09T21:00:00.000Z', stop_note: 'cutoff + 90 days → INSUFFICIENT_EVIDENCE', stop_source: 'docs/research/eco/D5NO_PROTOCOL.md',
    status: (db, _env, now) => { const e = d5NoEvidence(db, now);
      if (!('confident_no' in e) || !e.confident_no) return { n_per_arm: null, verdict: null };
      return { n_per_arm: { confident_no: e.confident_no.analysis_n_reached }, verdict: e.status === 'collecting' ? null : e.status }; } },
  { id: 'JEV-114', flag: 'JEV_CHALLENGER_MODEL', protocol: 'docs/runbooks/self-improvement-loop-operations.md', started_at: '2026-10-16T00:00:00.000Z',
    target_n: 100, stop_by: '2027-01-14T00:00:00.000Z',
    stop_note: `${AMENDED}: target 100 paired judgments with ground truth (operator default); start + 90 d cap (2 in 2.9 d projects past it)`,
    stop_source: 'docs/research/eco/JEV-114_PROTOCOL.md#amendment-1-2026-10-19',
    // one arm: the paired judgments that carry a ground-truth label (per judgment the label source with the most pairs, so a pair
    // labelled by two sources counts once), summed over judgments
    status: (db, env) => { const pairs = jevChallengerEvidence(db, env).by_judgment.reduce((sum, j) => sum + Math.max(0,
      ...Object.values(j.ground_truth).map((t) => (t ? t.primary.n + (t.abstained?.primary ?? 0) : 0))), 0);
      return { n_per_arm: { with_ground_truth: pairs }, verdict: null }; } },
  { id: 'memory-holdout', flag: 'MEMORY_HOLDOUT_RATE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-3', started_at: '2026-10-08T00:00:00.000Z',
    target_n: 30, stop_by: '2026-10-27T00:00:00.000Z',
    stop_note: `${AMENDED}: target 30 outcomes per arm (operator default); start + 1.25 × 30 ÷ 2.01/day (holdout arm, 22 in 10.9 d)`,
    stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#amendment-2026-10-19-stop-conditions',
    status: (db, env) => { const e = memoryHoldoutEvidence(db, '2026-10-08T00:00:00.000Z', env); return { n_per_arm: { rules: e.rules.n, holdout: e.holdout.n }, verdict: null }; } },
];

export interface ExperimentRow extends Omit<ExperimentDef, 'status'> {
  n_per_arm: Record<string, number> | null; min_arm_n: number | null; verdict: string | null;
  /** past stop_by, or every arm at the target, and no verdict recorded */
  overdue: boolean; overdue_reason: string | null; error?: string;
}

export function experimentsReport(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), defs: ExperimentDef[] = experimentDefs()) {
  const experiments: ExperimentRow[] = defs.map(({ status, ...d }) => {
    let s: ExperimentStatus = { n_per_arm: null, verdict: null }; let error: string | undefined;
    try { s = status(db, env, now); } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 200); }
    const ns = s.n_per_arm ? Object.values(s.n_per_arm) : [];
    const min_arm_n = ns.length ? Math.min(...ns) : null;
    const past = d.stop_by !== null && now > Date.parse(d.stop_by);
    const reached = d.target_n !== null && min_arm_n !== null && min_arm_n >= d.target_n;
    const overdue = s.verdict === null && (past || reached);
    const overdue_reason = !overdue ? null : past ? `past stop_by ${d.stop_by} without a verdict (n per arm ${JSON.stringify(s.n_per_arm)})`
      : `every arm reached target ${d.target_n} without a verdict`;
    return { ...d, ...s, min_arm_n, overdue, overdue_reason, ...(error ? { error } : {}) };
  });
  return { experiments, overdue: experiments.filter((e) => e.overdue).map((e) => e.id), no_stop_date: experiments.filter((e) => e.stop_by === null).map((e) => e.id),
    note: 'Report-only. stop_by = the date the pre-registration stops at (null = none registered); overdue = past stop_by or every arm at target_n with no verdict. n counts from started_at.' };
}
