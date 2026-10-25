import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';
import {
  observeCapacity, parseCpuMax, parseMemLimitMb, ResourceScheduler, schedulerCapacityEvidence, type ObservedCapacity,
} from '../services/resource-scheduler';

/** RESOURCE_SCHEDULER_MODE: observed host / cgroup capacity next to the simplified constants (shadow only). */
const GiB = 1024 ** 3;
const host = (o: Partial<{ cpus: number; load1: number; free: number; total: number }> = {}) => ({
  cpus: () => o.cpus ?? 2, loadavg: () => [o.load1 ?? 0.5, 0, 0], freemem: () => o.free ?? 3 * GiB, totalmem: () => o.total ?? 7 * GiB,
});
const files = (m: Record<string, string>) => (p: string) => { if (p in m) return m[p]; throw new Error(`ENOENT ${p}`); };
const short: ObservedCapacity = { cpus: 2, cpu_source: 'host', load1: 1.8, cpu_available: 0.2, mem_total_mb: 7168, mem_available_mb: 300, mem_source: 'host' };

describe('observed capacity parsing', () => {
  it('cgroup v2 cpu.max: quota / period is the cpu count, "max" is no limit, garbage is null', () => {
    expect(parseCpuMax('200000 100000\n')).toBe(2);
    expect(parseCpuMax('150000 100000')).toBe(1.5);
    expect(parseCpuMax('max 100000')).toBeNull();
    expect(parseCpuMax('')).toBeNull();
    expect(parseCpuMax('nonsense')).toBeNull();
  });

  it('memory.max "max" and the v1 unlimited sentinel are no limit; bytes become MB', () => {
    expect(parseMemLimitMb('max\n')).toBeNull();
    expect(parseMemLimitMb('9223372036854771712')).toBeNull();
    expect(parseMemLimitMb(String(2 * GiB))).toBe(2048);
    expect(parseMemLimitMb('x')).toBeNull();
  });

  it('a cgroup cpu limit of "200000 100000" wins over the host count', () => {
    const c = observeCapacity(files({ '/sys/fs/cgroup/cpu.max': '200000 100000' }), host({ cpus: 16, load1: 0.5 }));
    expect(c).toMatchObject({ cpus: 2, cpu_source: 'cgroup', load1: 0.5, cpu_available: 1.5 });
  });

  it('"max 100000" and memory.max "max" fall back to host numbers', () => {
    const c = observeCapacity(files({ '/sys/fs/cgroup/cpu.max': 'max 100000', '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/memory.current': '1' }), host());
    expect(c).toEqual({ cpus: 2, cpu_source: 'host', load1: 0.5, cpu_available: 1.5, mem_total_mb: 7168, mem_available_mb: 3072, mem_source: 'host' });
  });

  it('a cgroup memory limit wins: available = limit − current, never above host free', () => {
    const c = observeCapacity(files({ '/sys/fs/cgroup/memory.max': String(2 * GiB), '/sys/fs/cgroup/memory.current': String(GiB / 2) }), host());
    expect(c).toMatchObject({ mem_total_mb: 2048, mem_available_mb: 1536, mem_source: 'cgroup' });
    const tight = observeCapacity(files({ '/sys/fs/cgroup/memory.max': String(6 * GiB), '/sys/fs/cgroup/memory.current': '0' }), host({ free: GiB }));
    expect(tight.mem_available_mb).toBe(1024);
  });

  it('cgroup v1 fallback: cfs quota / period and memory.limit_in_bytes', () => {
    const c = observeCapacity(files({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '100000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(GiB), '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(GiB / 4),
    }), host({ cpus: 8, load1: 0 }));
    expect(c).toMatchObject({ cpus: 1, cpu_source: 'cgroup', cpu_available: 1, mem_total_mb: 1024, mem_available_mb: 768, mem_source: 'cgroup' });
    expect(observeCapacity(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }), host()).cpu_source).toBe('host');
  });

  it('unreadable is null, never a made-up number', () => {
    const none = { cpus: () => 0, loadavg: () => { throw new Error('no'); }, freemem: () => { throw new Error('no'); }, totalmem: () => 0 };
    expect(observeCapacity(files({}), none)).toEqual({ cpus: null, cpu_source: null, load1: null, cpu_available: null, mem_total_mb: null, mem_available_mb: null, mem_source: null });
    // a cgroup memory limit without a readable usage gives no available number
    expect(observeCapacity(files({ '/sys/fs/cgroup/memory.max': String(GiB) }), host()).mem_available_mb).toBeNull();
  });
});

describe('RESOURCE_SCHEDULER_MODE', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); });
  const rows = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'scheduler_capacity' ORDER BY created_at, rowid").all() as Array<Record<string, string>>;

  it('off (default) is identical to today: simplified constants, no observation, no rows', () => {
    const s = new ResourceScheduler();
    const observe = vi.spyOn(s, 'observe');
    expect(s.checkAvailability({})).toEqual({ has_gpu: true, cpu_available: 8, mem_available_mb: 16384 });
    expect(s.canSchedule({})).toEqual({ canSchedule: true, reason: 'resources available' });
    expect(s.canSchedule({ requires_cpu: 9 })).toEqual({ canSchedule: false, reason: 'waiting_for_resources: insufficient cpu' });
    expect(s.canSchedule({ requires_mem_mb: 16385 })).toEqual({ canSchedule: false, reason: 'waiting_for_resources: insufficient memory' });
    s.recordShadow(db, 'g1', {}, {});
    s.recordShadow(db, 'g1', {}, { RESOURCE_SCHEDULER_MODE: 'off' });
    expect(observe).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(schedulerCapacityEvidence(db, {}, Date.now())).toMatchObject({ mode: 'off', would_defer_24h: null, would_defer_7d: null, latest: null });
  });

  it('shadow keeps the decision and records would_defer when the observed capacity is short, bounded to one row per goal per 10 min', () => {
    const s = new ResourceScheduler();
    vi.spyOn(s, 'observe').mockReturnValue(short);
    const env = { RESOURCE_SCHEDULER_MODE: 'shadow' };
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    expect(s.canSchedule({})).toEqual({ canSchedule: true, reason: 'resources available' });
    s.recordShadow(db, 'g1', {}, env, t0);
    s.recordShadow(db, 'g1', {}, env, t0 + 5 * 60_000); // within 10 min: bounded
    s.recordShadow(db, 'g2', {}, env, t0);
    s.recordShadow(db, 'g1', {}, env, t0 + 11 * 60_000);
    const r = rows();
    expect(r.map((x) => x.subject_id)).toEqual(['g1', 'g2', 'g1']);
    expect(r[0]).toMatchObject({ subject_type: 'goal', mode: 'shadow', decision: 'defer', reason: 'waiting_for_resources: insufficient cpu' });
    expect(JSON.parse(r[0].answers_json)).toMatchObject({
      goal_id: 'g1', requirement: { requires_gpu: false, requires_cpu: 1, requires_mem_mb: 512 },
      simplified: { has_gpu: true, cpu_available: 8, mem_available_mb: 16384 }, observed: short,
      simplified_decision: { canSchedule: true }, observed_decision: { canSchedule: false }, would_defer: true,
    });
    expect(schedulerCapacityEvidence(db, env, t0 + 12 * 60_000)).toMatchObject({
      mode: 'shadow', would_defer_24h: 3, would_defer_7d: 3, would_schedule_7d: 0, latest: { goal_id: 'g1', observed: short },
    });
    expect(schedulerCapacityEvidence(db, env, t0 + 2 * 86_400_000)).toMatchObject({ would_defer_24h: 0, would_defer_7d: 3 });
  });

  it('shadow records nothing when both decisions agree, and would_defer false when only the simplified one defers', () => {
    const s = new ResourceScheduler();
    vi.spyOn(s, 'observe').mockReturnValue({ ...short, cpus: 32, cpu_available: 30, mem_available_mb: 60_000 });
    const env = { RESOURCE_SCHEDULER_MODE: 'shadow' };
    s.recordShadow(db, 'agree', {}, env);
    expect(rows()).toEqual([]);
    s.recordShadow(db, 'big', { requires_cpu: 12 }, env); // simplified (8) defers, observed (30) would schedule
    expect(rows().map((x) => [x.subject_id, x.decision, JSON.parse(x.answers_json).would_defer])).toEqual([['big', 'schedule', false]]);
  });

  it('unknown observed capacity never counts as short', () => {
    const s = new ResourceScheduler();
    vi.spyOn(s, 'observe').mockReturnValue({ cpus: null, cpu_source: null, load1: null, cpu_available: null, mem_total_mb: null, mem_available_mb: null, mem_source: null });
    s.recordShadow(db, 'g1', {}, { RESOURCE_SCHEDULER_MODE: 'shadow' });
    expect(rows()).toEqual([]);
  });

  it('loop daemon: shadow schedules the goal exactly as off does and records the would-defer row', async () => {
    const goals = new GoalService(db);
    // decomposition (loops.getGoal) runs only after the capacity check passed: the sentinel for 'scheduled'
    const stub = () => ({ getGoal: vi.fn(() => { throw new Error('stop after scheduling'); }), pruneOrphanedWorktrees: vi.fn() });
    const run = async (mode: string) => {
      vi.stubEnv('RESOURCE_SCHEDULER_MODE', mode);
      db.prepare("UPDATE goals SET status = 'cancelled'").run();
      const goal = goals.createGoal({ objective: 'Add a test', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
      const loops = stub();
      const daemon = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
      await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
      return { goal, loops, status: (db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string }).status };
    };
    const observe = vi.spyOn(ResourceScheduler.prototype, 'observe').mockReturnValue(short);
    const off = await run('off');
    expect(off.loops.getGoal).toHaveBeenCalledTimes(1); // scheduled: the capacity check passed
    expect(observe).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    const shadow = await run('shadow');
    expect(shadow.loops.getGoal).toHaveBeenCalledTimes(1);
    expect(shadow.status).toBe(off.status);
    expect(rows().map((x) => [x.subject_id, x.decision])).toEqual([[shadow.goal.id, 'defer']]);
  });
});
