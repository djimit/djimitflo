import type { Database } from 'better-sqlite3';
import { guardTick, markRun } from './scheduler-registry';
import { wilson } from './evolution-estimators';
import { gatedEvidence } from './dream-evolution';
import { BASELINE_GENOME, frozenHoldoutCommits, genome, holdoutEpoch, mutantHoldoutKeys, writeTestHoldoutKeys } from './genome-registry';
import { BENCHMARKS, MIN_SCORED, benchmarkScheduleMode, benchmarkState, latestSlot, realLeasesRunning, recordBenchmarkRun, runnerCommand, sha, type BenchmarkRun, type BenchmarkStatus } from './benchmark-schedule';

/**
 * Periodic benchmarks, the in-process half (benchmark-schedule.ts has the contract): the weekly gym holdout readout, the
 * hourly tick and the scheduler behind BENCHMARK_SCHEDULE_MODE=on.
 */
// ── gym frozen holdout readout (weekly, in-process, no new attempts) ─────────────────────────────────────────────────────

export interface HoldoutSetReadout { tasks: number; eligible: number; passed: number; rate: number | null; ci: [number, number] | null; newest: string | null }
/** Pass rate with a Wilson interval; null without eligible results (never 0). */
export function passRate(passed: number, eligible: number): { rate: number | null; ci: [number, number] | null } {
  return eligible > 0 ? { rate: +(passed / eligible).toFixed(4), ci: wilson(passed, eligible) } : { rate: null, ci: null };
}

/**
 * The evolving species (DREAM_EVOLUTION_SPECIES) with its current genome (newest active non-baseline, else the baseline): its
 * newest eligible gated result per task of the current epoch's deciding holdouts (mined, mutant, write_test) — the same
 * evidence a trial decides on (gatedEvidence). value = passed / eligible over all three, Wilson 95 %; insufficient below
 * MIN_SCORED eligible tasks. Reads only; the row is the scheduler's single write.
 */
export function gymHoldoutReadout(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): BenchmarkRun {
  const species = env.DREAM_EVOLUTION_SPECIES || 'atomic@llama-router';
  const active = db.prepare("SELECT id FROM maker_genomes WHERE status = 'active' AND id <> ? ORDER BY updated_at DESC LIMIT 1").get(BASELINE_GENOME) as { id: string } | undefined;
  const genomeId = active?.id ?? BASELINE_GENOME;
  const lines = genome(db, genomeId)?.lines ?? [];
  const keys = { mined: frozenHoldoutCommits(db), mutant: mutantHoldoutKeys(db), write_test: writeTestHoldoutKeys(db) };
  const sets: Record<string, HoldoutSetReadout> = {};
  let passed = 0; let eligible = 0; let tasks = 0; let newest: string | null = null; let oldest: string | null = null;
  for (const [name, ks] of Object.entries(keys)) {
    const ev = gatedEvidence(db, species, genomeId, ks);
    const obs = [...ev.byKey.values()];
    const p = obs.filter((o) => o.status === 'success').length;
    const n = obs.reduce<string | null>((a, o) => (!a || o.created_at > a ? o.created_at : a), null);
    for (const o of obs) if (!oldest || o.created_at < oldest) oldest = o.created_at;
    if (n && (!newest || n > newest)) newest = n;
    sets[name] = { tasks: ks.length, eligible: obs.length, passed: p, ...passRate(p, obs.length), newest: n };
    passed += p; eligible += obs.length; tasks += ks.length;
  }
  const { rate, ci } = passRate(passed, eligible);
  const epochs = { mined: holdoutEpoch(db, 'gym_holdout', env), mutant: holdoutEpoch(db, 'gym_mutant_holdout', env), write_test: holdoutEpoch(db, 'gym_write_test_holdout', env) };
  const slot = new Date(latestSlot('weekly', now)).toISOString();
  const status: BenchmarkStatus = eligible >= MIN_SCORED ? 'ok' : 'insufficient';
  const at = new Date(now).toISOString();
  return { id: `gym-holdout:${slot}`, benchmark_id: 'gym-holdout', slot, manifest_sha256: sha(JSON.stringify(keys)), prompt_sha256: sha(JSON.stringify(lines)),
    models: [species], runtime: 'gym', started_at: at, finished_at: at, tokens: 0, metric: 'pass_rate', value: rate, ci_low: ci?.[0] ?? null, ci_high: ci?.[1] ?? null,
    n: eligible, positives: null, negatives: null, catches: null, false_rejects: null, status,
    reason: status === 'ok' ? null : `${eligible} eligible result(s) on ${tasks} holdout task(s) (< ${MIN_SCORED})`, source: 'scheduler',
    detail: { species, genome: genomeId, epochs, tasks, sets, oldest_result: oldest, newest_result: newest, note: 'newest eligible gated result per task within the epoch; no new attempts' } };
}

// ── scheduler ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const announced = new Set<string>();
/** One tick: records a due gym readout; for a due reviewer benchmark only reports (the stall watch raises the alert). */
export function benchmarkTick(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { recorded: string[]; due: string[]; waiting: string[] } {
  const out = { recorded: [] as string[], due: [] as string[], waiting: [] as string[] };
  if (benchmarkScheduleMode(env) === 'off') return out;
  for (const def of BENCHMARKS) {
    const st = benchmarkState(db, def, now);
    if (!st.due) continue;
    if (def.execution === 'in_process') {
      let run: BenchmarkRun;
      try { run = gymHoldoutReadout(db, env, now); }
      catch (e) {
        const at = new Date(now).toISOString();
        run = { id: `gym-holdout:${st.slot}:failed`, benchmark_id: def.id, slot: st.slot, manifest_sha256: null, prompt_sha256: null, models: [], runtime: 'gym', started_at: at, finished_at: at,
          tokens: 0, metric: def.metric, value: null, ci_low: null, ci_high: null, n: 0, positives: null, negatives: null, catches: null, false_rejects: null, status: 'failed',
          reason: (e instanceof Error ? e.message : String(e)).slice(0, 300), source: 'scheduler', detail: {} };
      }
      if (recordBenchmarkRun(db, run)) out.recorded.push(run.id);
      continue;
    }
    const busy = realLeasesRunning(db).length;
    (busy ? out.waiting : out.due).push(def.id);
    const key = `${def.id}:${st.slot}:${busy ? 'waiting' : 'due'}`;
    if (!announced.has(key)) { announced.add(key); console.log(`📏 benchmark ${def.id} due (slot ${st.slot}): ${busy ? `waiting, ${busy} real lease(s) running` : `run \`${runnerCommand(def.id)}\` on the VPS host`}`); }
  }
  return out;
}

/** Hourly tick behind BENCHMARK_SCHEDULE_MODE=on; null (nothing runs) when off. */
export function startBenchmarkSchedule(db: Database, intervalMs = 3_600_000, env: NodeJS.ProcessEnv = process.env, clock = () => Date.now()): (() => void) | null {
  if (benchmarkScheduleMode(env) === 'off') return null;
  const tick = guardTick('benchmark_schedule', () => { benchmarkTick(db, env, clock()); markRun('benchmark_schedule'); });
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}

