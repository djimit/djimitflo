import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';

/**
 * Phase E1 + E3 (operator 08-10, "efficiency as fitness"): what each consumer of compute spends and what it delivered.
 * - cloud / local tokens per consumer per day, aggregated from what is already recorded: llm_model_calls (consumer, model,
 *   tokens) and worker_leases runtime_usage (role × runtime × model). Nothing new is captured.
 * - local GPU time per job: remote gym runs (loop_runs created → completed), remote maker jobs and committee jobs
 *   (claimed → finished), each on the host that ran it.
 * - measured energy: the host agent posts its GPU package power with every poll (RESOURCE_LEDGER_ENABLED stores it in
 *   host_power_samples); Wh for a job window is the trapezoid integral of that host's samples inside the window. A gap
 *   longer than MAX_SAMPLE_GAP_MS is not bridged, and a window without samples is 'not measured' — no watt figure is
 *   ever invented. Overlapping jobs on one host share each sample's Wh equally while they overlap (exclusive
 *   attribution: the consumers' sum never exceeds the host's measured total, hosts[].gpu_kwh — the wall-meter figure).
 * - value (simple v1): verified production maker runs (skill_outcomes loop-maker:<lane>:<runtime>, success = all gates
 *   pass) credit their maker species; the north star counts self_improvements that reached 'verified'.
 * Tokens and kWh are reported separately, never folded into one invented unit.
 */
export const resourceLedgerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.RESOURCE_LEDGER_ENABLED === 'true';
export const MAX_SAMPLE_GAP_MS = 180_000; // the agent polls every 30 s; its failure backoff (up to 600 s) is a gap, not a reading
const SAMPLE_RETENTION_MS = 63 * 86_400_000; // the 8-week north-star trend
const DAY = 86_400_000;
const FINISHED_RUN = "('completed', 'failed', 'interrupted', 'cancelled', 'escalated', 'blocked', 'ready_for_human_merge')";

export function ensurePowerTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS host_power_samples (host TEXT NOT NULL, at TEXT NOT NULL, gpu_watts REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_host_power_samples ON host_power_samples(host, at)`);
}

/** Stores the agent's `info.power.gpu_watts` (a number in [0, 5000]); anything else is ignored. Returns whether it stored. */
export function recordPowerSample(db: Database, host: string, power: unknown, now = Date.now()): boolean {
  const watts = (power as { gpu_watts?: unknown } | null | undefined)?.gpu_watts;
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0 || watts > 5000) return false;
  ensurePowerTable(db);
  db.prepare('INSERT INTO host_power_samples (host, at, gpu_watts) VALUES (?, ?, ?)').run(host, new Date(now).toISOString(), +watts.toFixed(1));
  db.prepare('DELETE FROM host_power_samples WHERE host = ? AND at < ?').run(host, new Date(now - SAMPLE_RETENTION_MS).toISOString());
  return true;
}

export interface Sample { t: number; w: number }

/** Trapezoid Wh over [start, end] from ascending samples; segments longer than maxGapMs count as unmeasured. */
export function integrateWh(samples: Sample[], start: number, end: number, maxGapMs = MAX_SAMPLE_GAP_MS): { wh: number; covered_s: number } {
  let wh = 0; let covered = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]; const b = samples[i];
    if (b.t - a.t > maxGapMs || b.t <= a.t) continue;
    const from = Math.max(a.t, start); const to = Math.min(b.t, end);
    if (to <= from) continue;
    const at = (t: number) => a.w + ((b.w - a.w) * (t - a.t)) / (b.t - a.t);
    wh += ((at(from) + at(to)) / 2) * ((to - from) / 3_600_000);
    covered += (to - from) / 1000;
  }
  return { wh: +wh.toFixed(3), covered_s: Math.round(covered) };
}

function hostSamples(db: Database, host: string, start: number, end: number): Sample[] {
  try {
    return (db.prepare('SELECT at, gpu_watts FROM host_power_samples WHERE host = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(host, new Date(start - MAX_SAMPLE_GAP_MS).toISOString(), new Date(end + MAX_SAMPLE_GAP_MS).toISOString()) as Array<{ at: string; gpu_watts: number }>)
      .map((s) => ({ t: Date.parse(s.at), w: s.gpu_watts }));
  } catch { return []; } // no sample was ever stored
}

/** ollama / local runtimes are local compute; `:cloud` models served through ollama are not. */
export const isLocalModel = (provider: string | null, model: string | null): boolean => {
  const m = String(model ?? ''); const p = String(provider ?? '').toLowerCase();
  if (/:cloud$/i.test(m)) return false;
  return ['ollama', 'local', 'llama.cpp', 'llama-router'].includes(p) || /^(ollama|local)[:/]/i.test(m);
};

const leaseConsumer = (role: string, runtime: string, model: string | null) =>
  role === 'maker' ? `maker:${runtime}${model ? `@${model}` : ''}` : role === 'checker' || role === 'security_checker' ? `reviewer:${role}:${runtime}` : `lease:${role}:${runtime}`;

export interface Job { consumer: string; host: string; start: number; end: number }

/**
 * Exclusive energy per job on one host: the window is cut at every job start/end; each piece's Wh is split equally over
 * the jobs active in it (ponytail: equal split, per-process GPU share if the agent ever reports it). covered_s stays the
 * job's own sampled time. Sum of wh over jobs ≤ integrateWh of the union.
 */
export function exclusiveWh(samples: Sample[], jobs: Array<{ start: number; end: number }>): Array<{ wh: number; covered_s: number }> {
  const out = jobs.map(() => ({ wh: 0, covered_s: 0 }));
  const cuts = [...new Set(jobs.flatMap((j) => [j.start, j.end]))].sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1]; const b = cuts[i];
    const active = jobs.map((j, k) => (j.start <= a && j.end >= b ? k : -1)).filter((k) => k >= 0);
    if (!active.length) continue;
    const e = integrateWh(samples, a, b);
    for (const k of active) { out[k].wh += e.wh / active.length; out[k].covered_s += e.covered_s; }
  }
  return out.map((o) => ({ wh: +o.wh.toFixed(3), covered_s: o.covered_s }));
}
export interface LedgerDay { day: string; consumer: string; cloud_tokens: number; local_tokens: number; gpu_seconds: number; jobs: number; wh: number | null; covered_s: number }
export interface Interval { value: number; low: number | null; high: number | null; n: number }
export interface ConsumerRow {
  consumer: string; cloud_tokens: number; local_tokens: number; gpu_seconds: number; jobs: number;
  wh: number | null; energy: 'measured' | 'partial' | 'not_measured'; energy_coverage: number | null;
  /** energy_coverage as a percentage (sampled GPU seconds / GPU seconds), null without GPU time */
  coverage_pct: number | null;
  verified: number | null; attempts: number | null; lanes: Record<string, number> | null;
  per_m_tokens: Interval | null; per_kwh: Interval | null;
}
/**
 * per_kwh counts only verified changes whose maker ran on a metered host (local_verified) and only when the metered hosts
 * were sampled for ≥ MIN_ENERGY_COVERAGE of the week; otherwise null with per_kwh_reason (INSUFFICIENT_EVIDENCE), never a
 * ratio of cloud-made changes over a fraction of local energy (prod 10-10: 28 cloud changes / 2.2 kWh over 38.7 of 168 h).
 */
export interface NorthStarWeek { week_start: string; verified: number; cloud_m_tokens: number; local_kwh: number | null; local_covered_h: number; per_m_tokens: number | null; per_kwh: number | null;
  local_verified: number; coverage_pct: number | null; per_kwh_reason: string | null }
export const MIN_ENERGY_COVERAGE = 0.8;
export interface EfficiencyView {
  at: string; window_days: number; ledger_enabled: boolean;
  consumers: ConsumerRow[]; ledger: LedgerDay[];
  hosts: Array<{ host: string; samples: number; last_sample: string | null; avg_watts: number | null; gpu_kwh: number | null; covered_h: number; coverage_pct: number }>;
  north_star: { weeks: NorthStarWeek[] };
  /** jobs_pct: sampled / total local GPU seconds over all consumers; window_pct: sampled hours / window hours over metered hosts */
  coverage: { jobs_pct: number | null; window_pct: number | null };
  notes: string[];
}

function safeAll<T>(db: Database, sql: string, ...args: unknown[]): T[] { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }

/** Local GPU jobs that started in [since, until): gym on a remote host, remote makers, committee jobs. */
export function gpuJobs(db: Database, since: string, until: string): Job[] {
  const rows = [
    ...safeAll<{ consumer: string; host: string; s: string; e: string }>(db, `SELECT 'gym:' || COALESCE(json_extract(metadata, '$.gym.species'), 'unknown') AS consumer,
        json_extract(metadata, '$.gym.remote_host') AS host, created_at AS s, COALESCE(completed_at, updated_at) AS e FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND status IN ${FINISHED_RUN} AND created_at >= ? AND created_at < ?`, since, until),
    ...safeAll<{ consumer: string; host: string; s: string; e: string }>(db, `SELECT 'maker:remote@' || host || '/' || species AS consumer, host, claimed_at AS s, finished_at AS e
      FROM remote_maker_jobs WHERE claimed_at IS NOT NULL AND finished_at IS NOT NULL AND claimed_at >= ? AND claimed_at < ?`, since, until),
    ...safeAll<{ consumer: string; host: string; s: string; e: string }>(db, `SELECT 'committee' AS consumer, host, claimed_at AS s, finished_at AS e
      FROM committee_jobs WHERE host IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NOT NULL AND claimed_at >= ? AND claimed_at < ?`, since, until),
  ];
  return rows.map((r) => ({ consumer: r.consumer, host: r.host, start: Date.parse(r.s), end: Date.parse(r.e) }))
    .filter((j) => j.host && Number.isFinite(j.start) && Number.isFinite(j.end) && j.end > j.start);
}

/** Cloud and local tokens per (day, consumer) from leases and model calls created in [since, until). */
export function tokenLedger(db: Database, since: string, until: string): Array<{ day: string; consumer: string; cloud: number; local: number }> {
  const out: Array<{ day: string; consumer: string; cloud: number; local: number }> = [];
  for (const r of safeAll<{ day: string; role: string; runtime: string; model: string | null; tokens: number }>(db, `SELECT substr(created_at, 1, 10) AS day, role, runtime,
      json_extract(metadata, '$.model') AS model, COALESCE(SUM(json_extract(metadata, '$.runtime_usage.total_tokens')), 0) AS tokens
      FROM worker_leases WHERE created_at >= ? AND created_at < ? AND runtime != 'manual' GROUP BY 1, 2, 3, 4`, since, until)) {
    const local = r.runtime === 'remote';
    out.push({ day: r.day, consumer: leaseConsumer(r.role, r.runtime, r.model), cloud: local ? 0 : r.tokens, local: local ? r.tokens : 0 });
  }
  for (const r of safeAll<{ day: string; consumer: string; model: string; provider: string | null; tokens: number }>(db, `SELECT substr(created_at, 1, 10) AS day, consumer, model, provider,
      COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens FROM llm_model_calls WHERE created_at >= ? AND created_at < ? GROUP BY 1, 2, 3, 4`, since, until)) {
    const local = isLocalModel(r.provider, r.model);
    out.push({ day: r.day, consumer: `llm:${r.consumer}`, cloud: local ? 0 : r.tokens, local: local ? r.tokens : 0 });
  }
  return out;
}

/**
 * Value v1: verified production maker runs per maker species (lane breakdown). gym and merge outcomes are not verified
 * changes. TODO(E2): full attribution — credit the reviewer pair, model, memory rules / examples in the assignment, cited
 * KB pages and the judgments that gated each silver/gold outcome; reviewer/env failures credit nobody.
 */
export function attributeOutcomes(db: Database, since: string, until: string): Map<string, { verified: number; attempts: number; lanes: Record<string, number> }> {
  const credit = new Map<string, { verified: number; attempts: number; lanes: Record<string, number> }>();
  for (const r of safeAll<{ skill_id: string; model: string | null; success: number }>(db, `SELECT skill_id, model, success FROM skill_outcomes
      WHERE skill_id LIKE 'loop-maker:%' AND skill_id NOT LIKE 'loop-maker:gym:%' AND skill_id NOT LIKE 'loop-maker:merge:%' AND created_at >= ? AND created_at < ?`, since, until)) {
    const [, lane, runtime] = r.skill_id.split(':');
    if (!lane || !runtime) continue;
    const key = `maker:${runtime}${r.model ? `@${r.model}` : ''}`;
    const c = credit.get(key) ?? { verified: 0, attempts: 0, lanes: {} };
    c.attempts++;
    if (r.success) { c.verified++; c.lanes[lane] = (c.lanes[lane] ?? 0) + 1; }
    credit.set(key, c);
  }
  return credit;
}

/** k verified of n attempts that cost `resource` units: value = k / resource; Wilson 95 % on k/n scaled by n / resource when n ≥ 5. */
export function valuePer(k: number, n: number, resource: number): Interval | null {
  if (!(resource > 0)) return null;
  if (n < 5) return { value: +(k / resource).toFixed(4), low: null, high: null, n };
  const [lo, hi] = wilson(k, n);
  return { value: +(k / resource).toFixed(4), low: +((lo * n) / resource).toFixed(4), high: +((hi * n) / resource).toFixed(4), n };
}

function hostEnergy(db: Database, start: number, end: number): Array<{ host: string; samples: number; last_sample: string | null; avg_watts: number | null; wh: number; covered_s: number }> {
  return safeAll<{ host: string; samples: number; last_sample: string | null; avg_watts: number | null }>(db, `SELECT host, COUNT(*) AS samples, MAX(at) AS last_sample,
      ROUND(AVG(gpu_watts), 1) AS avg_watts FROM host_power_samples WHERE at >= ? AND at < ? GROUP BY host ORDER BY host`, new Date(start).toISOString(), new Date(end).toISOString())
    .map((h) => ({ ...h, ...integrateWh(hostSamples(db, h.host, start, end), start, end) }));
}

export function efficiencyView(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, windowDays = 7): EfficiencyView {
  const start = now - windowDays * DAY; const since = new Date(start).toISOString(); const until = new Date(now).toISOString();
  const days = new Map<string, LedgerDay>();
  const day = (d: string, consumer: string) => {
    const k = `${d}|${consumer}`;
    if (!days.has(k)) days.set(k, { day: d, consumer, cloud_tokens: 0, local_tokens: 0, gpu_seconds: 0, jobs: 0, wh: null, covered_s: 0 });
    return days.get(k)!;
  };
  for (const t of tokenLedger(db, since, until)) { const d = day(t.day, t.consumer); d.cloud_tokens += t.cloud; d.local_tokens += t.local; }
  const sampleCache = new Map<string, Sample[]>();
  const samplesOf = (host: string) => { if (!sampleCache.has(host)) sampleCache.set(host, hostSamples(db, host, start, now + DAY)); return sampleCache.get(host)!; };
  const jobsByHost = new Map<string, Job[]>();
  for (const j of gpuJobs(db, since, until)) jobsByHost.set(j.host, [...(jobsByHost.get(j.host) ?? []), j]);
  for (const [host, jobs] of jobsByHost) {
    const energy = exclusiveWh(samplesOf(host), jobs);
    jobs.forEach((j, k) => {
      const d = day(new Date(j.start).toISOString().slice(0, 10), j.consumer); const e = energy[k];
      d.jobs++; d.gpu_seconds += Math.round((j.end - j.start) / 1000); d.covered_s += e.covered_s;
      if (e.covered_s > 0) d.wh = +((d.wh ?? 0) + e.wh).toFixed(3);
    });
  }
  const ledger = [...days.values()].sort((a, b) => b.day.localeCompare(a.day) || a.consumer.localeCompare(b.consumer));

  const credit = attributeOutcomes(db, since, until);
  const byConsumer = new Map<string, LedgerDay>();
  for (const d of ledger) {
    const c = byConsumer.get(d.consumer) ?? { ...d, day: '', cloud_tokens: 0, local_tokens: 0, gpu_seconds: 0, jobs: 0, wh: null, covered_s: 0 };
    c.cloud_tokens += d.cloud_tokens; c.local_tokens += d.local_tokens; c.gpu_seconds += d.gpu_seconds; c.jobs += d.jobs; c.covered_s += d.covered_s;
    if (d.wh !== null) c.wh = +((c.wh ?? 0) + d.wh).toFixed(3);
    byConsumer.set(d.consumer, c);
  }
  for (const k of credit.keys()) if (!byConsumer.has(k)) byConsumer.set(k, { day: '', consumer: k, cloud_tokens: 0, local_tokens: 0, gpu_seconds: 0, jobs: 0, wh: null, covered_s: 0 });
  const consumers: ConsumerRow[] = [...byConsumer.values()].map((c) => {
    const coverage = c.gpu_seconds > 0 ? Math.min(1, c.covered_s / c.gpu_seconds) : null;
    const energy: ConsumerRow['energy'] = !coverage ? 'not_measured' : coverage >= 0.9 ? 'measured' : 'partial';
    const v = credit.get(c.consumer);
    return {
      consumer: c.consumer, cloud_tokens: c.cloud_tokens, local_tokens: c.local_tokens, gpu_seconds: c.gpu_seconds, jobs: c.jobs,
      wh: energy === 'not_measured' ? null : c.wh, energy, energy_coverage: coverage === null ? null : +coverage.toFixed(3),
      coverage_pct: coverage === null ? null : +(coverage * 100).toFixed(1),
      verified: v ? v.verified : null, attempts: v ? v.attempts : null, lanes: v ? v.lanes : null,
      per_m_tokens: v ? valuePer(v.verified, v.attempts, c.cloud_tokens / 1e6) : null,
      // a partial window under-counts energy and so over-states value: only fully measured consumers get a value per kWh
      per_kwh: v && energy === 'measured' && c.wh ? valuePer(v.verified, v.attempts, c.wh / 1000) : null,
    };
  }).sort((a, b) => b.cloud_tokens - a.cloud_tokens || b.gpu_seconds - a.gpu_seconds || a.consumer.localeCompare(b.consumer));

  const hosts = hostEnergy(db, start, now).map((h) => ({ host: h.host, samples: h.samples, last_sample: h.last_sample, avg_watts: h.avg_watts,
    gpu_kwh: h.covered_s > 0 ? +(h.wh / 1000).toFixed(3) : null, covered_h: +(h.covered_s / 3600).toFixed(2),
    coverage_pct: +((100 * h.covered_s * 1000) / (now - start)).toFixed(1) }));

  const weeks: NorthStarWeek[] = [];
  for (let i = 0; i < 8; i++) {
    const ws = now - (i + 1) * 7 * DAY; const we = now - i * 7 * DAY;
    const wsI = new Date(ws).toISOString(); const weI = new Date(we).toISOString();
    const verified = (safeAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'verified' AND updated_at >= ? AND updated_at < ?", wsI, weI)[0]?.n) ?? 0;
    const cloud = tokenLedger(db, wsI, weI).reduce((s, t) => s + t.cloud, 0) / 1e6;
    const energy = hostEnergy(db, ws, we);
    const covered = energy.reduce((s, h) => s + h.covered_s, 0);
    const kwh = covered > 0 ? energy.reduce((s, h) => s + h.wh, 0) / 1000 : null;
    const metered = new Set(energy.filter((h) => h.covered_s > 0).map((h) => h.host));
    const coverage = metered.size ? (covered * 1000) / ((we - ws) * metered.size) : null;
    // verified production makers that ran on a metered host (runtime remote, model '<host>/<species>')
    const localVerified = safeAll<{ model: string | null }>(db, `SELECT model FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%:remote'
        AND skill_id NOT LIKE 'loop-maker:gym:%' AND skill_id NOT LIKE 'loop-maker:merge:%' AND success = 1 AND created_at >= ? AND created_at < ?`, wsI, weI)
      .filter((r) => metered.has(String(r.model ?? '').split('/')[0])).length;
    const reason = kwh === null ? 'INSUFFICIENT_EVIDENCE: no energy measured'
      : coverage! < MIN_ENERGY_COVERAGE ? `INSUFFICIENT_EVIDENCE: metered hosts sampled ${(coverage! * 100).toFixed(1)} % of the week (< ${MIN_ENERGY_COVERAGE * 100} %)`
      : localVerified === 0 ? 'INSUFFICIENT_EVIDENCE: no verified change was made on a metered host' : null;
    weeks.push({ week_start: wsI.slice(0, 10), verified, cloud_m_tokens: +cloud.toFixed(3), local_kwh: kwh === null ? null : +kwh.toFixed(3),
      local_covered_h: +(covered / 3600).toFixed(1), per_m_tokens: cloud > 0 ? +(verified / cloud).toFixed(3) : null,
      per_kwh: reason ? null : +(localVerified / kwh!).toFixed(3), local_verified: localVerified,
      coverage_pct: coverage === null ? null : +(coverage * 100).toFixed(1), per_kwh_reason: reason });
  }
  const gpuS = consumers.reduce((s, c) => s + c.gpu_seconds, 0);
  const sampledS = consumers.reduce((s, c) => s + (c.energy_coverage ?? 0) * c.gpu_seconds, 0);
  const meteredHosts = hosts.filter((h) => h.covered_h > 0);

  return {
    at: until, window_days: windowDays, ledger_enabled: resourceLedgerEnabled(env), consumers, ledger, hosts, north_star: { weeks },
    coverage: { jobs_pct: gpuS > 0 ? +((100 * sampledS) / gpuS).toFixed(1) : null,
      window_pct: meteredHosts.length ? +(meteredHosts.reduce((s, h) => s + h.coverage_pct, 0) / meteredHosts.length).toFixed(1) : null },
    notes: [
      'Energy is GPU package power from the host agent (rocm-smi / nvidia-smi), integrated per job window; windows without samples are not measured.',
      'Overlapping jobs on one host share the measured Wh equally while they overlap; idle host power is attributed to nobody (hosts[].gpu_kwh is the wall-meter figure).',
      `per kWh counts only changes made on a metered host, and only when the metered hosts were sampled for ≥ ${MIN_ENERGY_COVERAGE * 100} % of the week.`,
      'Value v1 credits only maker species (verified production runs); reviewers, models, memory and knowledge are credited in E2.',
    ],
  };
}
