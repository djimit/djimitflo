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
 * stop date its pre-registration fixes. stop_by is null when the protocol names no date (an estimate such as "≈ 45 days" is
 * not a stop date) — that experiment can run forever, which the stall watch reports. status() reuses the experiment's own
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
  status: (db: Database, env: NodeJS.ProcessEnv, now: number) => ExperimentStatus;
}

const NO_STOP_DATE = 'no stop date — violates know-when-to-stop';
const X1_STARTED = '2026-10-09T00:00:00.000Z';

/** Literal dates (pinned against their source constants in experiment-registry.test.ts): X1 = start + 28 d, D5-NO = cutoff + 90 d.
 *  A function, not a constant: the imported targets are read at call time (stall-watch ↔ d5-no import cycle). */
export const experimentDefs = (): ExperimentDef[] => [
  { id: 'ACE-001', flag: 'ACE_001_MODE', protocol: 'docs/research/ace/ACE-001_PROTOCOL.md', started_at: '2026-10-12T00:00:00.000Z',
    target_n: ACE_001_TARGET_PER_ARM, stop_by: null, stop_note: `${NO_STOP_DATE} (≈ 45 days is an estimate; only a safety stop is registered)`,
    status: (db, env) => { const e = ace001Evidence(db, aceAnalysisSince(env), env);
      return { n_per_arm: Object.fromEntries(Object.entries(e.arms).map(([a, v]) => [a, v.n])), verdict: null }; } },
  { id: 'STE-001', flag: 'STE_001_MODE', protocol: 'docs/research/ace/STE-001_PROTOCOL.md', started_at: '2026-10-11T00:00:00.000Z',
    target_n: STE_001_TARGET_PER_ARM, stop_by: null, stop_note: `${NO_STOP_DATE} (≈ 44 days is an estimate)`,
    status: (db, env) => { const e = ste001Evidence(db, '2026-10-11T00:00:00.000Z', env); return { n_per_arm: { 0: e.arms['0'].n, 1: e.arms['1'].n }, verdict: null }; } },
  { id: 'MAKER-DEPS-001', flag: 'MAKER_DEPS_001_MODE', protocol: 'docs/research/di-001/MAKER_DEPS_001_PREREG.md', started_at: '2026-10-14T00:00:00.000Z',
    target_n: MAKER_DEPS_001_TARGET_PER_ARM, stop_by: null, stop_note: `${NO_STOP_DATE} (≈ 31 days is an estimate)`,
    status: (db, env) => { const e = makerDeps001Evidence(db, '2026-10-14T00:00:00.000Z', env); return { n_per_arm: { A: e.arms.A.terminal, B: e.arms.B.terminal }, verdict: null }; } },
  { id: 'X1', flag: 'EFFORT_SIBLING_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-2', started_at: X1_STARTED,
    target_n: 94, stop_by: '2026-11-06T00:00:00.000Z', stop_note: 'EXP-2 registration: 4 weeks, ~94 settled per arm',
    status: (db, env) => { const e = effortX1Evidence(db, X1_STARTED, env, fisherExact);
      return { n_per_arm: { on: e.on.verified + e.on.regressed, off: e.off.verified + e.off.regressed }, verdict: null }; } },
  { id: 'F2', flag: 'CHECKER_FAMILY_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-1', started_at: '2026-10-17T00:00:00.000Z',
    target_n: CHECKER_FAMILY_TARGET_DEFAULT, stop_by: null, stop_note: `${NO_STOP_DATE} (v2; ≈ 16 days is an estimate)`,
    status: (db, env, now) => { const e = checkerFamilyEvidence(db, '2026-10-17T00:00:00.000Z', env, fisherExact, now);
      return { n_per_arm: { same: e.primary.n.same, cross: e.primary.n.cross }, verdict: e.stop.verdict === 'collecting' ? null : e.stop.verdict }; } },
  { id: 'TG-001', flag: 'TG_001_MODE', protocol: 'docs/research/ace/TG-001_PROTOCOL.md', started_at: '2026-10-11T23:20:22.000Z',
    target_n: TG_TASKS, stop_by: null, stop_note: `${NO_STOP_DATE} (stopping rule is by tasks: 20, extend once to 40)`,
    status: (db, env) => { const e = tg001Evidence(db, env);
      const arms = 'arms' in e && Array.isArray(e.arms) ? e.arms as Array<{ arm: string; n: number }> : [];
      const result = 'result' in e ? (e as { result?: { verdict?: string } }).result : undefined;
      return { n_per_arm: arms.length ? Object.fromEntries(arms.map((a) => [a.arm, a.n])) : null, verdict: e.status === 'complete' ? result?.verdict ?? null : null }; } },
  { id: 'D5-NO', flag: 'TYPESAFE_PROPOSAL_PRESCREEN_MODE', protocol: 'docs/research/eco/D5NO_PROTOCOL.md', started_at: '2026-10-11T21:00:00.000Z',
    target_n: D5NO_ANALYSIS_N, stop_by: '2027-01-09T21:00:00.000Z', stop_note: 'cutoff + 90 days → INSUFFICIENT_EVIDENCE',
    status: (db, _env, now) => { const e = d5NoEvidence(db, now);
      if (!('confident_no' in e) || !e.confident_no) return { n_per_arm: null, verdict: null };
      return { n_per_arm: { confident_no: e.confident_no.analysis_n_reached }, verdict: e.status === 'collecting' ? null : e.status }; } },
  { id: 'JEV-114', flag: 'JEV_CHALLENGER_MODEL', protocol: 'docs/runbooks/self-improvement-loop-operations.md', started_at: '2026-10-16T00:00:00.000Z',
    target_n: null, stop_by: null, stop_note: `${NO_STOP_DATE} (no target n either: 20 pairs is only the insufficiency floor)`,
    status: (db, env) => ({ n_per_arm: Object.fromEntries(jevChallengerEvidence(db, env).by_judgment.map((j) => [j.judgment, j.n_pairs])), verdict: null }) },
  { id: 'memory-holdout', flag: 'MEMORY_HOLDOUT_RATE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-3', started_at: '2026-10-08T00:00:00.000Z',
    target_n: null, stop_by: null, stop_note: `${NO_STOP_DATE} (no registered n: power calc only, 267 + 115 settled at rate 0.3)`,
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
