import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import type { Database } from 'better-sqlite3';

/**
 * G24: ResourceScheduler — resource-aware goal scheduling.
 *
 * Matches goals to available resources from fleetPools(). A goal that requires GPU
 * waits for GPU availability. Deferred goals are queued with reason 'waiting_for_resources'.
 *
 * RESOURCE_SCHEDULER_MODE (off | shadow, default off): the decision always comes from the simplified constants below.
 * In shadow, the decision the observed capacity (host os numbers, a container cgroup limit wins) would give is computed
 * too and, when the two differ, recorded as one `scheduler_capacity` judgments row (mode shadow, subject goal),
 * at most one per goal per 10 min. Nothing reads it for a decision. CPU available is count − used in one scope: under a
 * cgroup limit the cgroup's own cpu accounting, otherwise the host load; never a cgroup limit minus the host-wide load.
 */

interface ResourceRequirement {
  requires_gpu?: boolean;
  requires_cpu?: number;  // min CPU cores
  requires_mem_mb?: number;  // min memory in MB
}

interface ResourceAvailability {
  has_gpu: boolean;
  cpu_available: number | null;
  mem_available_mb: number | null;
}

/** What this process can see. null = unknown (unreadable), never a made-up number. */
export interface ObservedCapacity {
  cpus: number | null;
  /** Scope of cpus, cpu_used and cpu_available alike: a cgroup limit is never combined with the host-wide load. */
  cpu_source: 'cgroup' | 'host' | null;
  /** 1-min load average. Host-wide on Linux (not namespaced per container); informational under a cgroup limit. */
  load1: number | null;
  /** Cores in use in the cpu_source scope: cgroup cpu accounting (Δusage / Δtime between observations) or host load1. */
  cpu_used: number | null;
  cpu_used_source: CpuUsedSource | null;
  /** Window of the cgroup usage delta; null for host load1 (the kernel's 1-min average). */
  cpu_used_window_ms: number | null;
  /** max(0, cpus − cpu_used). */
  cpu_available: number | null;
  /** Why cpu_available is null (null when it is known). */
  cpu_available_reason: string | null;
  mem_total_mb: number | null;
  mem_available_mb: number | null;
  mem_source: 'cgroup' | 'host' | null;
}

type Decision = { canSchedule: boolean; reason: string };
type CpuUsedSource = 'cgroup_v2_cpu_stat' | 'cgroup_v1_cpuacct' | 'host_loadavg';
/** The previous cgroup cpu usage reading and the last measured window (module state between observations). */
export interface CpuUsageSamples { base?: { path: string; usec: number; at: number }; last?: { used: number; window_ms: number } }
type HostOs = Pick<typeof os, 'loadavg' | 'freemem' | 'totalmem'> & { cpus: () => number };

const MB = 1024 * 1024;
const SHADOW_BOUND_MS = 10 * 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** A shorter window than this reuses the last measured one (several goals in one tick). */
const MIN_CPU_WINDOW_MS = 1000;
const cpuSamples: CpuUsageSamples = {};

export const schedulerMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' => (env.RESOURCE_SCHEDULER_MODE === 'shadow' ? 'shadow' : 'off');

/** cgroup v2 cpu.max "<quota> <period>" → cpus; "max …" (no limit) or unparseable → null. */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/).map(Number);
  return quota > 0 && period > 0 ? round2(quota / period) : null;
}

/** memory.max / memory.limit_in_bytes bytes → MB; "max", the v1 unlimited sentinel (≈ 2^63) or unparseable → null. */
export function parseMemLimitMb(text: string): number | null {
  const bytes = Number(text.trim());
  return Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 62 ? Math.floor(bytes / MB) : null;
}

/** cgroup v2 cpu.stat → usage_usec; absent or unparseable → null. */
export function parseCpuStatUsageUsec(text: string): number | null {
  const m = /^usage_usec\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** Container cores used = Δusage / Δtime against the previous reading of the same file; the first reading only sets the baseline. */
function cgroupCpuUsed(path: string, usec: number | null, now: number, s: CpuUsageSamples): { used: number; window_ms: number } | { reason: string } {
  if (usec === null) return { reason: 'cgroup_cpu_usage_unreadable' };
  const b = s.base;
  if (!b || b.path !== path || now < b.at || usec < b.usec) { s.base = { path, usec, at: now }; s.last = undefined; return { reason: 'cgroup_cpu_usage_no_baseline' }; }
  if (now - b.at < MIN_CPU_WINDOW_MS) return s.last ?? { reason: 'cgroup_cpu_usage_window_too_short' };
  s.last = { used: round2((usec - b.usec) / 1000 / (now - b.at)), window_ms: now - b.at };
  s.base = { path, usec, at: now };
  return s.last;
}

const hostOs: HostOs = { cpus: () => os.cpus().length, loadavg: os.loadavg, freemem: os.freemem, totalmem: os.totalmem };

export function observeCapacity(
  read: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'), host: HostOs = hostOs, now = performance.now(), samples: CpuUsageSamples = cpuSamples,
): ObservedCapacity {
  const tryRead = (p: string): string | null => { try { return read(p); } catch { return null; } };
  const tryNum = (f: () => number): number | null => { try { const n = f(); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } };
  const bytes = (p: string): number | null => { const t = tryRead(p); const n = t === null ? NaN : Number(t.trim()); return Number.isFinite(n) && n >= 0 ? n : null; };

  // CPU: cgroup v2 cpu.max, else v1 cfs quota / period; the limit wins over the host count (capped at it).
  const v2Cpu = tryRead('/sys/fs/cgroup/cpu.max');
  const v1Quota = tryRead('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'); const v1Period = tryRead('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  const cgCpus = v2Cpu !== null ? parseCpuMax(v2Cpu) : v1Quota !== null && v1Period !== null ? parseCpuMax(`${v1Quota.trim()} ${v1Period.trim()}`) : null;
  const hostCpus = tryNum(host.cpus);
  const cpus = cgCpus !== null ? (hostCpus !== null ? Math.min(cgCpus, hostCpus) : cgCpus) : hostCpus;
  let load1: number | null = null;
  try { const l = host.loadavg()[0]; load1 = Number.isFinite(l) && l >= 0 ? round2(l) : null; } catch { /* unknown */ }
  // Used cores in the same scope as the count: under a cgroup limit the cgroup's cpu accounting (v2 cpu.stat usage_usec,
  // v1 cpuacct.usage ns), never the host-wide load; otherwise host load1.
  let cpu_used: number | null = null; let cpu_used_source: CpuUsedSource | null = null; let cpu_used_window_ms: number | null = null;
  let cpu_available_reason: string | null = null;
  if (cgCpus !== null) {
    const v2Stat = v2Cpu !== null;
    const path = v2Stat ? '/sys/fs/cgroup/cpu.stat' : '/sys/fs/cgroup/cpuacct/cpuacct.usage';
    const text = tryRead(path);
    const ns = text === null || v2Stat ? NaN : Number(text.trim());
    const usec = text === null ? null : v2Stat ? parseCpuStatUsageUsec(text) : Number.isFinite(ns) && ns >= 0 ? ns / 1000 : null;
    const r = cgroupCpuUsed(path, usec, now, samples);
    if ('used' in r) { cpu_used = r.used; cpu_used_window_ms = r.window_ms; } else cpu_available_reason = r.reason;
    if (usec !== null) cpu_used_source = v2Stat ? 'cgroup_v2_cpu_stat' : 'cgroup_v1_cpuacct';
  } else if (cpus !== null) {
    cpu_used = load1;
    if (load1 !== null) cpu_used_source = 'host_loadavg'; else cpu_available_reason = 'host_loadavg_unreadable';
  } else cpu_available_reason = 'cpu_count_unreadable';

  // Memory: cgroup v2 memory.max + memory.current, else v1 limit_in_bytes + usage_in_bytes; available = limit − usage,
  // never above host free. Without a readable usage under a limit the available number is unknown.
  const v2Mem = tryRead('/sys/fs/cgroup/memory.max');
  const v2 = v2Mem !== null;
  const cgLimit = parseMemLimitMb(v2 ? v2Mem : tryRead('/sys/fs/cgroup/memory/memory.limit_in_bytes') ?? '');
  const hostTotal = tryNum(host.totalmem); const hostFree = tryNum(host.freemem);
  const hostTotalMb = hostTotal !== null ? Math.floor(hostTotal / MB) : null; const hostFreeMb = hostFree !== null ? Math.floor(hostFree / MB) : null;
  const limited = cgLimit !== null && (hostTotalMb === null || cgLimit < hostTotalMb);
  let mem_available_mb: number | null = hostFreeMb;
  if (limited) {
    const usage = bytes(v2 ? '/sys/fs/cgroup/memory.current' : '/sys/fs/cgroup/memory/memory.usage_in_bytes');
    mem_available_mb = usage === null ? null : Math.max(0, Math.min(cgLimit - Math.floor(usage / MB), hostFreeMb ?? Infinity));
  }

  return {
    cpus, cpu_source: cgCpus !== null ? 'cgroup' : cpus !== null ? 'host' : null, load1, cpu_used, cpu_used_source, cpu_used_window_ms,
    cpu_available: cpus !== null && cpu_used !== null ? round2(Math.max(0, cpus - cpu_used)) : null, cpu_available_reason,
    mem_total_mb: limited ? cgLimit : hostTotalMb, mem_available_mb, mem_source: limited ? 'cgroup' : hostTotalMb !== null || hostFreeMb !== null ? 'host' : null,
  };
}

/** The capacity rule; an unknown (null) availability never defers. */
function decide(req: ResourceRequirement, avail: ResourceAvailability): Decision {
  if (req.requires_gpu && !avail.has_gpu) {
    return { canSchedule: false, reason: 'waiting_for_resources: gpu not available' };
  }
  if (req.requires_cpu && avail.cpu_available !== null && req.requires_cpu > avail.cpu_available) {
    return { canSchedule: false, reason: 'waiting_for_resources: insufficient cpu' };
  }
  if (req.requires_mem_mb && avail.mem_available_mb !== null && req.requires_mem_mb > avail.mem_available_mb) {
    return { canSchedule: false, reason: 'waiting_for_resources: insufficient memory' };
  }
  return { canSchedule: true, reason: 'resources available' };
}

export class ResourceScheduler {
  constructor() {}

  /**
   * Estimate resource requirements for a goal from its metadata.
   */
  estimateResources(goalMetadata: Record<string, unknown>): ResourceRequirement {
    return {
      requires_gpu: Boolean(goalMetadata.requires_gpu),
      requires_cpu: typeof goalMetadata.requires_cpu === 'number' ? goalMetadata.requires_cpu : 1,
      requires_mem_mb: typeof goalMetadata.requires_mem_mb === 'number' ? goalMetadata.requires_mem_mb : 512,
    };
  }

  /**
   * Check if resources are available for a goal.
   * In production, this would query fleetPools(). For now, it uses a simple heuristic.
   */
  checkAvailability(req: ResourceRequirement): ResourceAvailability {
    // In production: query SwarmStatusService.fleetPools() for actual resources.
    // For now: assume CPU and memory are always available; GPU depends on env.
    const hasGpu = process.env.FLEET_HAS_GPU === 'true' || !req.requires_gpu;
    return {
      has_gpu: hasGpu,
      cpu_available: 8, // simplified
      mem_available_mb: 16384, // simplified
    };
  }

  /** Observed capacity of this host / container (no GPU observation: has_gpu stays the env answer). */
  observe(): ObservedCapacity {
    return observeCapacity();
  }

  /**
   * Check if a goal can be scheduled given current resources.
   */
  canSchedule(goalMetadata: Record<string, unknown>): Decision {
    const req = this.estimateResources(goalMetadata);
    return decide(req, this.checkAvailability(req));
  }

  /**
   * RESOURCE_SCHEDULER_MODE=shadow: compute the decision the observed capacity would give and, when it differs from the
   * simplified one, record one `scheduler_capacity` judgments row (≤ 1 per goal per 10 min). Never throws, never changes
   * the decision; off returns before observing anything.
   */
  recordShadow(db: Database, goalId: string, goalMetadata: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
    if (schedulerMode(env) !== 'shadow') return;
    try {
      const requirement = this.estimateResources(goalMetadata);
      const simplified = this.checkAvailability(requirement);
      const simplified_decision = decide(requirement, simplified);
      const observed = this.observe();
      const observed_decision = decide(requirement, { has_gpu: simplified.has_gpu, cpu_available: observed.cpu_available, mem_available_mb: observed.mem_available_mb });
      if (observed_decision.canSchedule === simplified_decision.canSchedule) return;
      const recent = db.prepare("SELECT 1 FROM judgments WHERE judgment = 'scheduler_capacity' AND subject_id = ? AND created_at > ? LIMIT 1")
        .get(goalId, new Date(now - SHADOW_BOUND_MS).toISOString());
      if (recent) return;
      const would_defer = !observed_decision.canSchedule;
      const answers = { goal_id: goalId, requirement, simplified, observed, simplified_decision, observed_decision, would_defer };
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
        VALUES (?, 'scheduler_capacity', 'goal', ?, ?, 'shadow', ?, ?, ?, NULL, ?)`)
        .run(randomUUID(), goalId, `cpu=${observed.cpu_available};mem=${observed.mem_available_mb}`, would_defer ? 'defer' : 'schedule',
          observed_decision.reason, JSON.stringify(answers), new Date(now).toISOString());
    } catch { /* shadow: never affects scheduling */ }
  }
}

/**
 * Evidence `scheduler_capacity`: shadow rows where the observed capacity would defer (24 h, 7 d) or schedule (7 d) a goal
 * the simplified constants decided otherwise, the latest row's observed capacity, and the capacity observed now.
 * Counts are null with the mode off and no row ever recorded (nothing measured) or when the table is unreadable.
 */
export function schedulerCapacityEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = schedulerMode(env);
  const iso = (ms: number) => new Date(now - ms).toISOString();
  let counts: { would_defer_24h: number | null; would_defer_7d: number | null; would_schedule_7d: number | null } = { would_defer_24h: null, would_defer_7d: null, would_schedule_7d: null };
  let latest: { at: string; goal_id: string; would_defer: boolean; observed: ObservedCapacity } | null = null;
  try {
    const c = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(decision = 'defer' AND created_at >= ?), 0) AS d24, COALESCE(SUM(decision = 'defer' AND created_at >= ?), 0) AS d7,
      COALESCE(SUM(decision = 'schedule' AND created_at >= ?), 0) AS s7 FROM judgments WHERE judgment = 'scheduler_capacity' AND created_at <= ?`)
      .get(iso(86_400_000), iso(7 * 86_400_000), iso(7 * 86_400_000), iso(0)) as { total: number; d24: number; d7: number; s7: number };
    if (mode === 'shadow' || c.total > 0) counts = { would_defer_24h: c.d24, would_defer_7d: c.d7, would_schedule_7d: c.s7 };
    const row = db.prepare("SELECT created_at, answers_json FROM judgments WHERE judgment = 'scheduler_capacity' AND created_at <= ? ORDER BY created_at DESC LIMIT 1")
      .get(iso(0)) as { created_at: string; answers_json: string } | undefined;
    if (row) { const a = JSON.parse(row.answers_json); latest = { at: row.created_at, goal_id: a.goal_id, would_defer: a.would_defer, observed: a.observed }; }
  } catch { /* table absent: null */ }
  let observed_now: ObservedCapacity | null = null;
  try { observed_now = observeCapacity(); } catch { /* null */ }
  return { mode, ...counts, latest, observed_now };
}
