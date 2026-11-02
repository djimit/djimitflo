import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopEventService } from './loop-event-service';
import { TG_LOOP } from './tg-001';
import { notFallbackGoalSql } from './ollama-outage-fallback';

/**
 * MAKER-DEPS-001 v1 (pre-registered: docs/research/di-001/MAKER_DEPS_001_PREREG.md, sha256 in MAKER_DEPS_001_PREREG.sha256).
 * Does preparing a local opencode maker's worktree dependencies before it starts change verified completion?
 *   arm A = today; arm B = the daemon runs the deterministic checks' own `npm ci` (+ the @djimitflo/shared build) first.
 * Arm = parity of sha256('maker-deps-001:' + goal id): every run, retry and evolve sibling of a goal is in one arm (the cluster).
 * The salt is orthogonal to ACE-001, STE-001, X1 and F2 (maker-deps-001.test.ts checks independence). Prompt, template, caps,
 * timeouts and gates are the same in both arms. TG-001, the gym and remote makers are never in it.
 *   MAKER_DEPS_001_MODE=on (default off)
 */
export const MAKER_DEPS_001 = { id: 'MAKER-DEPS-001', version: 'v1' } as const;
/** +12 pp from p0 = 0.786 (post-#716 base rate), two-sided alpha 0.05, power 0.80 */
export const MAKER_DEPS_001_TARGET_PER_ARM = 141;
export type MakerDepsArm = 'A' | 'B';
export interface MakerDepsRecord { experiment: 'MAKER-DEPS-001'; version: 'v1'; arm: MakerDepsArm; goal_id: string; maker_lease_id: string }

export const makerDeps001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.MAKER_DEPS_001_MODE === 'on';

export const makerDepsArm = (goalId: string): MakerDepsArm =>
  (parseInt(createHash('sha256').update(`maker-deps-001:${goalId}`).digest('hex').slice(0, 8), 16) % 2 === 1 ? 'B' : 'A');

/** Local opencode makers of goal runs only: never TG-001, the gym, remote/mock/manual or any other runtime. */
export function makerDepsEligible(x: { runtime: string; role: string; goal_id: string | null | undefined; loop_name: string | null | undefined }): boolean {
  return x.runtime === 'opencode' && x.role === 'maker' && Boolean(x.goal_id) && x.loop_name !== TG_LOOP && x.loop_name !== 'evolution-gym';
}

const isRecord = (v: unknown): v is MakerDepsRecord =>
  !!v && typeof v === 'object' && (v as MakerDepsRecord).experiment === MAKER_DEPS_001.id && ((v as MakerDepsRecord).arm === 'A' || (v as MakerDepsRecord).arm === 'B');

/**
 * Assign and record before the maker starts: once on the lease (never overwritten) and as one `maker_deps_arm` event.
 * A lease that already carries an arm keeps it.
 */
export function assignMakerDepsArm(db: Database, runId: string, lease: { id: string; metadata: Record<string, unknown> }, goalId: string): MakerDepsRecord {
  const prior = lease.metadata?.maker_deps_001;
  const record: MakerDepsRecord = isRecord(prior) ? prior
    : { experiment: MAKER_DEPS_001.id, version: MAKER_DEPS_001.version, arm: makerDepsArm(goalId), goal_id: goalId, maker_lease_id: lease.id };
  try {
    db.prepare(`UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.maker_deps_001', json(?))
      WHERE id = ? AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.maker_deps_001') IS NULL`).run(JSON.stringify(record), lease.id);
    new LoopEventService(db).recordEvent(runId, 'maker_deps_arm', 'info',
      `MAKER-DEPS-001 v1: arm ${record.arm}${record.arm === 'B' ? ' (dependencies prepared before the maker starts)' : ' (existing behaviour)'}.`, { ...record });
  } catch { /* the arm still decides; only the record is best-effort */ }
  return record;
}

const TERMINAL = new Set(['verified', 'regressed', 'infra_failed', 'no_change', 'needs_more_evidence', 'archived']);

/** Seeded PRNG for the descriptive bootstrap (the pre-registered analysis uses 10 000 draws, seed 20261014). */
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** evolution-evidence `maker_deps_001`: ITT by goal per arm (verified / terminal), B preparation success, maker lease failures. */
export function makerDeps001Evidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let goals: Array<{ arm: string; goal: string; status: string | null }> = [];
  let preps: Array<{ arm: string; failed: number }> = [];
  let leases: Array<{ arm: string; status: string; tokens: number | null; timed_out: number }> = [];
  try {
    goals = db.prepare(`SELECT json_extract(e.metadata, '$.arm') AS arm, json_extract(e.metadata, '$.goal_id') AS goal, MAX(s.status) AS status
      FROM loop_events e LEFT JOIN goals g ON g.id = json_extract(e.metadata, '$.goal_id') LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE e.event_type = 'maker_deps_arm' AND json_extract(e.metadata, '$.experiment') = ? AND e.created_at >= ?
        AND ${notFallbackGoalSql("json_extract(e.metadata, '$.goal_id')")} GROUP BY 1, 2`).all(MAKER_DEPS_001.id, since) as typeof goals;
    preps = db.prepare(`SELECT json_extract(metadata, '$.arm') AS arm,
        (COALESCE(json_extract(metadata, '$.install_failed'), 0) OR COALESCE(json_extract(metadata, '$.shared_failed'), 0)) AS failed
      FROM loop_events WHERE event_type = 'maker_worktree_prepared' AND created_at >= ?`).all(since) as typeof preps;
    leases = db.prepare(`SELECT json_extract(metadata, '$.maker_deps_001.arm') AS arm, status, json_extract(metadata, '$.runtime_usage.total_tokens') AS tokens,
        COALESCE(json_extract(metadata, '$.timed_out'), 0) AS timed_out
      FROM worker_leases WHERE role = 'maker' AND json_extract(metadata, '$.maker_deps_001.experiment') = ? AND created_at >= ?
        AND json_extract(metadata, '$.runtime_fallback') IS NULL`).all(MAKER_DEPS_001.id, since) as typeof leases;
  } catch { /* missing tables */ }
  const outcomes = (a: MakerDepsArm) => goals.filter((g) => g.arm === a && g.status && TERMINAL.has(g.status)).map((g) => (g.status === 'verified' ? 1 : 0));
  const arm = (a: MakerDepsArm) => {
    const g = goals.filter((x) => x.arm === a); const term = outcomes(a); const v = term.reduce((s: number, x: number) => s + x, 0);
    const p = preps.filter((x) => x.arm === a); const l = leases.filter((x) => x.arm === a); const tok = l.filter((x) => typeof x.tokens === 'number');
    return { goals: g.length, terminal: term.length, verified: v, regressed: g.filter((x) => x.status === 'regressed').length, censored: g.length - term.length,
      verified_rate: term.length ? +(v / term.length).toFixed(3) : null,
      preparations: p.length, preparation_failed: p.filter((x) => x.failed).length,
      maker_leases: l.length, maker_failed: l.filter((x) => x.status === 'failed').length, maker_timed_out: l.filter((x) => x.timed_out).length,
      tokens_mean: tok.length ? Math.round(tok.reduce((s, x) => s + (x.tokens as number), 0) / tok.length) : null };
  };
  const arms = { A: arm('A'), B: arm('B') };
  // descriptive cluster bootstrap over goals (one outcome per goal = one cluster)
  let diffCi: [number, number] | null = null;
  const oa = outcomes('A'); const ob = outcomes('B');
  if (oa.length && ob.length) {
    const rnd = mulberry32(20261014); const draws: number[] = [];
    const mean = (xs: number[]) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; return s / xs.length; };
    for (let i = 0; i < 2000; i++) draws.push(mean(ob) - mean(oa));
    draws.sort((x, y) => x - y); diffCi = [+draws[49].toFixed(3), +draws[1949].toFixed(3)];
  }
  const reached = arms.A.terminal >= MAKER_DEPS_001_TARGET_PER_ARM && arms.B.terminal >= MAKER_DEPS_001_TARGET_PER_ARM;
  return { experiment: MAKER_DEPS_001.id, version: MAKER_DEPS_001.version, mode: env.MAKER_DEPS_001_MODE ?? null, target_per_arm: MAKER_DEPS_001_TARGET_PER_ARM, arms,
    diff: arms.A.verified_rate !== null && arms.B.verified_rate !== null ? +(arms.B.verified_rate - arms.A.verified_rate).toFixed(3) : null, diff_ci_descriptive: diffCi,
    status: reached ? 'analysable' as const : 'collecting' as const,
    note: 'MAKER-DEPS-001 v1 (MAKER_DEPS_001_MODE): local opencode maker goals by sha256 parity; A = existing behaviour, B = the checks\' npm ci + shared build before the maker starts. ITT by goal. Interim figures are descriptive; the pre-registered analysis (docs/research/di-001/MAKER_DEPS_001_PREREG.md) runs once both arms reach the target. No automatic promotion.' };
}
