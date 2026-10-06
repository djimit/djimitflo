import type { Database } from 'better-sqlite3';
import { RUNTIME_ADMISSIONS, checkAdmission, decide, type RuntimeAdmissionAssessment } from '../execution/runtime-admission';
import { infraFailing } from './evolution-gym-service';

/**
 * UX-16 (part 2): one read-only row per runtime — admission + expiry, admitted vs observed version, last contract probe,
 * 30-day lease outcomes, the gym circuit breaker and readiness for the legacy expiry (reports/runtime-admission-readiness.md).
 * Nothing here decides or changes an admission; a runtime without a probe says 'no probe', never 'ok'.
 */
export type Readiness = 'ok' | 'reassess' | 'retire_unused' | 'keep_test_only' | 'hold' | 'rejected' | 'unknown_runtime';
export interface RuntimeHealthRow {
  runtime: string;
  admission: { decision: string; expires_at: string | null; days_to_expiry: number | null; allowed_now: boolean };
  version: { admitted: string | null; observed: string | null; drift: boolean };
  probe: { status: string; probed_at: string | null; age_h: number | null };
  leases_30d: { n: number; completed: number; failed: number; cancelled: number; success_rate: number | null };
  leases_90d: number;
  last_success_at: string | null;
  gym: { species: string[]; benched: boolean };
  readiness: Readiness;
}

const DAY = 86_400_000;
const all = <T>(db: Database, sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };

export function runtimeHealth(db: Database, now = Date.now(), ledger: readonly RuntimeAdmissionAssessment[] = RUNTIME_ADMISSIONS): RuntimeHealthRow[] {
  const d30 = new Date(now - 30 * DAY).toISOString(); const d90 = new Date(now - 90 * DAY).toISOString(); const d1 = new Date(now - DAY).toISOString();
  const probes = new Map(all<{ runtime: string; status: string; version: string | null; probed_at: string }>(db,
    "SELECT runtime, status, json_extract(contract_json, '$.version') AS version, probed_at FROM runtime_contract_probes").map((p) => [p.runtime, p]));
  const leases = new Map(all<{ runtime: string; n: number; completed: number; failed: number; cancelled: number }>(db,
    `SELECT runtime, COUNT(*) AS n, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled
     FROM worker_leases WHERE created_at >= ? GROUP BY runtime`, d30).map((l) => [l.runtime, l]));
  const leases90 = new Map(all<{ runtime: string; n: number }>(db, 'SELECT runtime, COUNT(*) AS n FROM worker_leases WHERE created_at >= ? GROUP BY runtime', d90).map((l) => [l.runtime, l.n]));
  const lastSuccess = new Map(all<{ runtime: string; t: string }>(db, "SELECT runtime, MAX(updated_at) AS t FROM worker_leases WHERE status = 'completed' GROUP BY runtime").map((l) => [l.runtime, l.t]));
  const gymSpecies = all<{ s: string }>(db, "SELECT DISTINCT json_extract(metadata, '$.gym.species') AS s FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym.species') IS NOT NULL", d30).map((r) => r.s);

  const ids = [...new Set([...ledger.map((a) => a.runtime_id), ...leases.keys(), ...probes.keys()])].sort();
  return ids.map((runtime) => {
    const records = ledger.filter((a) => a.runtime_id === runtime);
    const record = records[0];
    const probe = probes.get(runtime);
    const observed = probe?.version ?? null;
    const check = checkAdmission(runtime, observed, now, ledger);
    const decision = record ? decide(record).decision : 'UNKNOWN_RUNTIME';
    const expires = record?.expires_at ?? null;
    const l = leases.get(runtime) ?? { n: 0, completed: 0, failed: 0, cancelled: 0 };
    const decided = l.completed + l.failed;
    const n90 = leases90.get(runtime) ?? 0;
    const species = gymSpecies.filter((s) => s.split('@')[0] === runtime);
    const readiness: Readiness = !record ? 'unknown_runtime'
      : decision === 'REJECT' ? 'rejected'
        : decision === 'HOLD' ? 'hold'
          : runtime === 'mock' ? 'keep_test_only'
            : decision !== 'LEGACY_ADMITTED' && expires && Date.parse(expires) > now + 90 * DAY ? 'ok'
              : n90 === 0 ? 'retire_unused' : 'reassess';
    return {
      runtime,
      admission: { decision, expires_at: expires, days_to_expiry: expires ? Math.floor((Date.parse(expires) - now) / DAY) : null, allowed_now: check.allowed },
      version: { admitted: record?.runtime_version ?? null, observed, drift: Boolean(record?.runtime_version && observed && !check.allowed && check.reasons.some((r) => r.startsWith('runtime drift'))) },
      probe: probe ? { status: probe.status, probed_at: probe.probed_at, age_h: Math.round((now - Date.parse(probe.probed_at)) / 3_600_000) } : { status: 'no probe', probed_at: null, age_h: null },
      leases_30d: { n: l.n, completed: l.completed, failed: l.failed, cancelled: l.cancelled, success_rate: decided ? +(l.completed / decided).toFixed(3) : null },
      leases_90d: n90,
      last_success_at: lastSuccess.get(runtime) ?? null,
      gym: { species, benched: species.some((s) => { try { return infraFailing(db, s, d1); } catch { return false; } }) },
      readiness,
    };
  });
}
