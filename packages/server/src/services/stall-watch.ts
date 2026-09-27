import type { Database } from 'better-sqlite3';

/**
 * Plan M10: Djimitflo noticed none of its own silent failures on 2026-09-27 — the workstation gym benched for 9 h, NVIDIA
 * 429s swallowed by the safety check, 42 review goals left 'running'. Each detector is one read-only query; a stall names
 * its subsystem, since when, and what to look at. GET /api/health/stalls always; hourly log lines with STALL_WATCH_ENABLED=true.
 */
export interface Stall { subsystem: string; since: string | null; detail: string }

const ago = (now: number, hours: number) => new Date(now - hours * 3_600_000).toISOString();
const one = <T>(db: Database, sql: string, ...args: unknown[]): T | undefined => { try { return db.prepare(sql).get(...args) as T | undefined; } catch { return undefined; } };
const all = <T>(db: Database, sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };

export function detectStalls(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Stall[] {
  const out: Stall[] = [];
  // 1. gym enabled but no scored outcome for 6 h (the breaker or the worker can silently idle it)
  if (env.EVOLUTION_GYM_ENABLED === 'true' || env.EVOLUTION_GYM_REMOTE_ENABLED === 'true') {
    const last = one<{ t: string | null }>(db, "SELECT MAX(created_at) AS t FROM skill_outcomes WHERE domain = 'gym'")?.t ?? null;
    if (!last || last < ago(now, 6)) {
      const infra = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%'", ago(now, 24))?.n ?? 0;
      out.push({ subsystem: 'gym', since: last, detail: `no gym outcome for > 6 h; ${infra} infra discard(s) in 24 h (circuit breaker benches a species at 3)` });
    }
  }
  // 2. a judgment failing more than 30 % of the time in the last 6 h (e.g. provider 429s)
  for (const j of all<{ judgment: string; errors: number; n: number }>(db, "SELECT judgment, SUM(decision = 'error') AS errors, COUNT(*) AS n FROM judgments WHERE created_at >= ? GROUP BY judgment HAVING n >= 10", ago(now, 6))) {
    if (j.errors / j.n > 0.3) out.push({ subsystem: `judgment:${j.judgment}`, since: ago(now, 6), detail: `${j.errors}/${j.n} verdicts were errors in 6 h` });
  }
  // 3. proposals waiting for a panel while no panel verdict came in 12 h
  const waiting = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'proposed' AND created_at < ?", ago(now, 12))?.n ?? 0;
  const panels = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM judgments WHERE judgment LIKE 'panel_%' AND created_at >= ?", ago(now, 12))?.n ?? 0;
  if (waiting > 0 && panels === 0) out.push({ subsystem: 'panel', since: ago(now, 12), detail: `${waiting} proposal(s) waiting > 12 h, no panel verdict in 12 h` });
  // 4. goals 'running' whose latest run ended more than 2 h ago
  const zombies = one<{ n: number; oldest: string | null }>(db, `SELECT COUNT(*) AS n, MIN(g.updated_at) AS oldest FROM goals g
    WHERE g.status = 'running' AND (SELECT r.status FROM loop_runs r WHERE r.goal_id = g.id ORDER BY r.created_at DESC LIMIT 1) IN ('completed', 'failed', 'cancelled')
      AND g.updated_at < ?`, ago(now, 2));
  if (zombies && zombies.n > 0) out.push({ subsystem: 'goals', since: zombies.oldest, detail: `${zombies.n} goal(s) 'running' although their latest run ended` });
  // 5. fleet discoveries stopped (publishers run daily)
  if (env.FRONTIER_EXPERT_SOURCE_UNITS_ENABLED === 'true') {
    const last = one<{ t: string | null }>(db, "SELECT MAX(created_at) AS t FROM judgments WHERE judgment = 'discovery_relevance'")?.t ?? null;
    if (last && last < ago(now, 36)) out.push({ subsystem: 'discoveries', since: last, detail: 'no fleet discovery judged for > 36 h (publishers on Mac mini / Eve-V / workstation)' });
  }
  return out;
}

export function startStallWatch(db: Database, intervalMs = 3_600_000): (() => void) | null {
  if (process.env.STALL_WATCH_ENABLED !== 'true') return null;
  const tick = () => { for (const s of detectStalls(db)) console.warn(`🚨 stall: ${s.subsystem} since ${s.since ?? 'never'} — ${s.detail}`); };
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
