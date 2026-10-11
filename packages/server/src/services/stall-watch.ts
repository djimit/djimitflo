import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { decide, expiringAdmissions } from '../execution/runtime-admission';
import { markRun } from './scheduler-registry';

/**
 * Plan M10: Djimitflo noticed none of its own silent failures on 2026-09-27 — the workstation gym benched for 9 h, NVIDIA
 * 429s swallowed by the safety check, 42 review goals left 'running'. Each detector is one read-only query; a stall names
 * its subsystem, since when, and what to look at. GET /api/health/stalls always; hourly log lines with STALL_WATCH_ENABLED=true.
 */
export interface Stall { subsystem: string; since: string | null; detail: string }

const ago = (now: number, hours: number) => new Date(now - hours * 3_600_000).toISOString();

/**
 * Cockpit 3.0: an empty stall list is not health. Each detector reports its own status — a query that throws (missing
 * table, SQL error) is `error`, a detector whose flag is off is `not_applicable` — so a broken detector reads UNKNOWN,
 * never HEALTHY. Queries here throw on purpose; detectStallsWithHealth catches per detector.
 */
/** capped (EP6): the subsystem is idle because it reached its own budget — expected, not a stall and not unknown. */
export type DetectorStatus = 'ok' | 'error' | 'not_applicable' | 'capped';
export interface DetectorHealth { name: string; status: DetectorStatus; error?: string; detail?: string; checked_at: string }
export type StallHealth = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'BREACHED';
export interface StallReport { stalls: Stall[]; detectors: DetectorHealth[]; health: StallHealth }

/** The remote gym's rolling 24 h cap (EVOLUTION_GYM_REMOTE_MAX_PER_DAY): claims used, the limit, and when the oldest claim
 *  in the window ages out. Shared by claim() and the stall watch, so a gym idle at its cap is not reported as stalled. */
export function remoteGymCap(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): { used: number; max: number; capped: boolean; next_slot_at: string | null } {
  const since = new Date(now - 86_400_000).toISOString();
  const r = db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND created_at >= ?").get(since) as { n: number; oldest: string | null };
  const max = Number(env.EVOLUTION_GYM_REMOTE_MAX_PER_DAY) || 24;
  return { used: r.n, max, capped: r.n >= max, next_slot_at: r.oldest ? new Date(Date.parse(r.oldest) + 86_400_000).toISOString() : null };
}

interface DeployEvent { at: string; event: string; sha: string; detail?: string }
/** Deploy log as auto-deploy.sh writes it (same file recentDeploys reads); null when the file does not exist (dev, tests). */
function readDeployLog(file: string): DeployEvent[] | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  return text.trim().split('\n').map((l) => { try { return JSON.parse(l) as DeployEvent; } catch { return null; } }).filter((e): e is DeployEvent => Boolean(e?.event));
}

/** Health from detectors + stalls: BREACHED on any stall, UNKNOWN when a detector errored and nothing stalled. */
export function stallHealth(stalls: Stall[], detectors: DetectorHealth[]): StallHealth {
  if (stalls.length) return 'BREACHED';
  if (detectors.some((d) => d.status === 'error')) return 'UNKNOWN';
  return 'HEALTHY';
}

export function detectStallsWithHealth(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): StallReport {
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const gymOn = env.EVOLUTION_GYM_ENABLED === 'true' || env.EVOLUTION_GYM_REMOTE_ENABLED === 'true';
  const out: Stall[] = []; const detectors: DetectorHealth[] = []; const checked_at = new Date(now).toISOString();
  const run = (name: string, applicable: boolean, fn: () => void | { capped: string }) => {
    if (!applicable) { detectors.push({ name, status: 'not_applicable', checked_at }); return; }
    try { const r = fn(); detectors.push(r ? { name, status: 'capped', detail: r.capped, checked_at } : { name, status: 'ok', checked_at }); }
    catch (e) { detectors.push({ name, status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 200), checked_at }); }
  };
  // 1. gym enabled but no scored outcome for 6 h (the breaker or the worker can silently idle it)
  run('gym', gymOn, () => {
    const last = one<{ t: string | null }>("SELECT MAX(created_at) AS t FROM skill_outcomes WHERE domain = 'gym'")?.t ?? null;
    if (!last || last < ago(now, 6)) {
      // EP6 (prod 10-10: the 20/day remote cap idled the gym and the cockpit read BREACHED): with the local gym off, a
      // remote gym that used its daily cap is waiting by design — alarm only when it is below its cap and still silent
      const cap = remoteGymCap(db, now, env);
      if (env.EVOLUTION_GYM_ENABLED !== 'true' && env.EVOLUTION_GYM_REMOTE_ENABLED === 'true' && cap.capped) {
        return { capped: `gym at its daily cap ${cap.used}/${cap.max}; next slot at ${cap.next_slot_at ?? 'unknown'}` };
      }
      const infra = one<{ n: number }>("SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%'", ago(now, 24))?.n ?? 0;
      out.push({ subsystem: 'gym', since: last, detail: `no gym outcome for > 6 h; ${infra} infra discard(s) in 24 h (circuit breaker benches a species at 3)` });
    }
    return undefined;
  });
  // 1b. per species: its last three gym attempts were all infra discards → the circuit breaker is benching it (prod 2026-09-27:
  // the workstation's only species sat out 9 h while VPS gym outcomes kept the global check quiet)
  run('gym_species', gymOn, () => {
    const species = all<{ sp: string }>("SELECT DISTINCT json_extract(metadata, '$.gym.species') AS sp FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym.species') IS NOT NULL", ago(now, 48));
    for (const { sp } of species) {
      const last = all<{ reason: string | null; created_at: string }>("SELECT json_extract(metadata, '$.gym_result.reason') AS reason, created_at FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.canary') IS NULL ORDER BY created_at DESC LIMIT 3", sp);
      if (last.length === 3 && last.every((r) => (r.reason ?? '').startsWith('infra:'))) out.push({ subsystem: `gym:${sp}`, since: last[2].created_at, detail: `last 3 attempts were infra discards (${(last[0].reason ?? '').slice(0, 80)}); the breaker benches this species` });
    }
  });
  // 2. a judgment failing more than 30 % of the time in the last 6 h (e.g. provider 429s). `<judgment>@local` rows are the T1
  // shadow experiment against the workstation, not production signals: their errors show in the cockpit, not as stalls.
  run('judgments', true, () => {
    for (const j of all<{ judgment: string; errors: number; n: number }>("SELECT judgment, SUM(decision = 'error') AS errors, COUNT(*) AS n FROM judgments WHERE created_at >= ? AND judgment NOT LIKE '%@local' GROUP BY judgment HAVING n >= 10", ago(now, 6))) {
      if (j.errors / j.n > 0.3) out.push({ subsystem: `judgment:${j.judgment}`, since: ago(now, 6), detail: `${j.errors}/${j.n} verdicts were errors in 6 h` });
    }
  });
  // 3. proposals waiting for a panel while no panel verdict came in 12 h
  run('panel', true, () => {
    const waiting = one<{ n: number }>("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'proposed' AND created_at < ?", ago(now, 12))?.n ?? 0;
    const panels = one<{ n: number }>("SELECT COUNT(*) AS n FROM judgments WHERE judgment LIKE 'panel_%' AND created_at >= ?", ago(now, 12))?.n ?? 0;
    if (waiting > 0 && panels === 0) out.push({ subsystem: 'panel', since: ago(now, 12), detail: `${waiting} proposal(s) waiting > 12 h, no panel verdict in 12 h` });
  });
  // 4. goals 'running' whose latest run ended more than 2 h ago
  run('goals', true, () => {
    const zombies = one<{ n: number; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(g.updated_at) AS oldest FROM goals g
      WHERE g.status = 'running' AND (SELECT r.status FROM loop_runs r WHERE r.goal_id = g.id ORDER BY r.created_at DESC LIMIT 1) IN ('completed', 'failed', 'cancelled')
        AND g.updated_at < ?`, ago(now, 2));
    if (zombies && zombies.n > 0) out.push({ subsystem: 'goals', since: zombies.oldest, detail: `${zombies.n} goal(s) 'running' although their latest run ended` });
  });
  // 5. fleet discoveries stopped (publishers run daily). Never judged at all while enabled = no telemetry, also a stall.
  run('discoveries', env.FRONTIER_EXPERT_SOURCE_UNITS_ENABLED === 'true', () => {
    const last = one<{ t: string | null }>("SELECT MAX(created_at) AS t FROM judgments WHERE judgment = 'discovery_relevance'")?.t ?? null;
    if (!last || last < ago(now, 36)) out.push({ subsystem: 'discoveries', since: last, detail: last ? 'no fleet discovery judged for > 36 h (publishers on Mac mini / Eve-V / workstation)' : 'source units are enabled but no fleet discovery was ever judged' });
  });
  // 7. RX-11: a solved gym canary (a run carrying an unsolvable test) means the oracle or the sandbox is compromised
  run('gym_canary', true, () => {
    const solved = one<{ n: number; first: string | null }>("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND json_extract(metadata, '$.gym_result.status') = 'success' AND created_at >= ?", ago(now, 24 * 30));
    if (solved && solved.n > 0) out.push({ subsystem: 'gym:canary', since: solved.first, detail: `${solved.n} gym canary run(s) reported success — a canary cannot be solved from the source file: check the oracle and the worker sandbox` });
  });
  // 8. RX-14: the nightly thermometer is on but wrote nothing for 36 h (trends cannot be backfilled)
  run('estimates', env.EVOLUTION_ESTIMATORS_ENABLED === 'true', () => {
    const last = one<{ t: string | null }>('SELECT MAX(computed_at) AS t FROM evolution_estimates')?.t ?? null;
    if (!last || last < ago(now, 36)) out.push({ subsystem: 'estimates', since: last, detail: 'EVOLUTION_ESTIMATORS_ENABLED is on but no evolution estimate was written for > 36 h' });
  });
  // 6. a runtime admission expires within 30 days: at expiry the engine stops dispatching to that runtime
  run('runtime_admission', true, () => {
    for (const a of expiringAdmissions(now)) out.push({ subsystem: `runtime_admission:${a.runtime_id}`, since: a.expires_at, detail: `admission ${decide(a).decision} expires ${a.expires_at}; reassess (execution/runtime-admission.ts) before then` });
  });
  // 9. Cockpit 3.0: a deploy that succeeded technically but never passed the post-deploy check (auto-deploy.sh writes
  // verdict_ok ~15 min after done), or whose latest event is a failure, is not a healthy build — HTTP 200 is not readiness.
  const commit = env.DJIMITFLO_BUILD_COMMIT;
  const events = (() => { try { return readDeployLog(env.DEPLOY_LOG_PATH || '/data/deploy-log.jsonl'); } catch { return undefined; } })();
  run('deploy', Boolean(commit) && events !== null, () => {
    if (!events) throw new Error('deploy log unreadable');
    const latest = events[events.length - 1];
    if (latest && (latest.event === 'failed' || latest.event === 'paused')) out.push({ subsystem: 'deploy', since: latest.at, detail: `latest deploy event '${latest.event}' for ${latest.sha.slice(0, 8)}${latest.detail ? `: ${latest.detail}` : ''}` });
    const mine = events.filter((e) => commit && e.sha && (e.sha.startsWith(commit) || commit.startsWith(e.sha)));
    const last = mine[mine.length - 1];
    if (last?.event === 'done' && Date.parse(last.at) < now - 40 * 60_000) out.push({ subsystem: 'deploy', since: last.at, detail: `build ${commit!.slice(0, 8)} deployed but no post-deploy verdict within 40 min — functional readiness unproven` });
  });
  return { stalls: out, detectors, health: stallHealth(out, detectors) };
}

/** Compatibility: the stalls only (callers that need detector health use detectStallsWithHealth). */
export function detectStalls(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Stall[] {
  return detectStallsWithHealth(db, now, env).stalls;
}

export function startStallWatch(db: Database, intervalMs = 3_600_000): (() => void) | null {
  if (process.env.STALL_WATCH_ENABLED !== 'true') return null;
  const tick = () => { markRun('stall_watch'); for (const s of detectStalls(db)) console.warn(`🚨 stall: ${s.subsystem} since ${s.since ?? 'never'} — ${s.detail}`); };
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
