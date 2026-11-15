/**
 * S7 — a scheduled task is demonstrably triggered and processed, and a stuck scheduler becomes visible (E3).
 *
 * Scheduler: compliance_report (ComplianceReportScheduler) — cheap, deterministic, DB-only tick (generateReport over the
 * audit/approval/runtime tables → one compliance_reports row per interval). It is armed exactly as src/index.ts:309-311
 * does it (registerRestart + noteScheduler(name, flag, sched.start(), intervalHours × 3 600 000)), with a short interval
 * through its own env (COMPLIANCE_REPORT_INTERVAL_HOURS=0.0002 → 720 ms). Observed through the projections the dashboard
 * reads: GET /api/health/schedulers (registry), GET /api/health/cockpit (scheduler health), GET /api/health/stalls
 * (stall watch) and the scheduler's own output rows (compliance_reports). The self-heal watchdog runs through its own
 * start function (startSchedulerWatchdog) in its default mode (SCHEDULER_SELF_HEAL_MODE unset = shadow).
 *
 * Fault injection: the "stuck" cases use only the scheduler's own seams — the report generator constructor parameter
 * (a generator that throws) and the scheduler's stop() (a timer that no longer fires). No registry or DB row is written
 * by the test. "FAIL D-…" tests are `it.fails` (see s01); SCENARIO_STRICT=1 runs them as plain `it`.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { startHarness, envSnapshot, until, recordObs, type Harness } from './harness';
import { ComplianceReportScheduler } from '../../services/compliance-report-scheduler';
import { guardTick, markRun, noteScheduler, registerRestart, resetSchedulers } from '../../services/scheduler-registry';
import { startSchedulerWatchdog } from '../../services/stall-watch';

const failing = process.env.SCENARIO_STRICT === '1' ? it : it.fails;
const INTERVAL_HOURS = '0.0002'; // 720 ms
const INTERVAL_MS = Number(INTERVAL_HOURS) * 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('S7 scheduler trigger + stuck visibility (E3)', { timeout: 60_000 }, () => {
  let h: Harness;
  let restore: () => void;
  let sched: ComplianceReportScheduler | null = null;
  let stopWatchdog: (() => void) | null = null;

  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(() => {
    restore = envSnapshot(['COMPLIANCE_REPORT_SCHEDULER_ENABLED', 'COMPLIANCE_REPORT_INTERVAL_HOURS', 'COMPLIANCE_REPORT_TYPE', 'SCHEDULER_SELF_HEAL_MODE']);
    process.env.COMPLIANCE_REPORT_SCHEDULER_ENABLED = 'true';
    process.env.COMPLIANCE_REPORT_INTERVAL_HOURS = INTERVAL_HOURS;
    process.env.COMPLIANCE_REPORT_TYPE = 'custom';
    delete process.env.SCHEDULER_SELF_HEAL_MODE;
    resetSchedulers(Date.now()); // a fresh boot of the in-memory registry (index.ts builds it once at boot)
  });
  afterEach(() => { sched?.stop(); sched = null; stopWatchdog?.(); stopWatchdog = null; restore(); });

  /** index.ts:309-311, verbatim apart from the optional generator. */
  function armComplianceScheduler(generator?: ConstructorParameters<typeof ComplianceReportScheduler>[1]) {
    const s = new ComplianceReportScheduler(h.db, generator);
    registerRestart('compliance_report', () => { s.stop(); s.start(); });
    const armed = noteScheduler('compliance_report', 'COMPLIANCE_REPORT_SCHEDULER_ENABLED', s.start(), s.intervalHours() * 3_600_000);
    sched = s;
    return armed;
  }
  const registryEntry = async () => {
    const r = await h.api('GET', '/health/schedulers');
    expect(r.status).toBe(200);
    return { health: r.body.health, entry: (r.body.schedulers as Array<Record<string, unknown>>).find((s) => s.name === 'compliance_report') };
  };
  const reportCount = (since = '') => (h.db.prepare("SELECT COUNT(*) AS n FROM compliance_reports WHERE type = 'custom' AND generated_at >= ?").get(since) as { n: number }).n;

  it('S7-a triggered + processed: boot tick and timer ticks each write a report; registry shows executing', async () => {
    const before = reportCount();
    expect(armComplianceScheduler()).toBe(true);
    const afterBoot = reportCount();
    const first = await registryEntry();
    // two more intervals: the timer (not the boot catch-up) must have produced at least one more report
    const afterTimer = await until(() => (reportCount() >= afterBoot + 1 ? reportCount() : null), 10_000, 100);
    const second = await registryEntry();
    const cockpit = await h.api('GET', '/health/cockpit');
    const rows = h.db.prepare("SELECT id, type, generated_at, score, status FROM compliance_reports WHERE type = 'custom' ORDER BY generated_at").all();
    const obs = { interval_ms: INTERVAL_MS, reports: { before, after_boot_tick: afterBoot, after_timer: afterTimer }, rows,
      registry_after_boot: first, registry_after_timer: second, cockpit_scheduler_fields: pickSchedulerFields(cockpit.body), outbound: [...h.outbound] };
    recordObs('S7-a', obs);

    expect(before).toBe(0);
    expect(afterBoot).toBe(1);
    expect(afterTimer).toBeGreaterThanOrEqual(2);
    expect(first.entry).toMatchObject({ armed: true, interval_ms: INTERVAL_MS, status: 'executing', last_error: null });
    expect(second.entry?.status).toBe('executing');
    expect(Date.parse(String(second.entry?.last_run))).toBeGreaterThan(Date.parse(String(first.entry?.last_run)));
    expect(h.outbound).toEqual([]);
  });

  it('S7-c stuck (timer stops firing): registry turns armed_not_ticking past 2× interval; watchdog diagnoses it', async () => {
    expect(armComplianceScheduler()).toBe(true);
    sched!.stop(); // the timer no longer fires (process alive, scheduler dead)
    stopWatchdog = startSchedulerWatchdog(h.db, 200); // product start function, default (shadow) mode
    const detectedAt = await until(async () => ((await registryEntry()).entry?.status === 'armed_not_ticking' ? Date.now() : null), 10_000, 100);
    await sleep(600); // a few watchdog ticks
    const reg = await registryEntry();
    const cockpit = await h.api('GET', '/health/cockpit');
    const stalls = await h.api('GET', '/health/stalls');
    const needsYou = await h.api('GET', '/health/needs-you');
    const judgments = h.db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'scheduler_recovery' AND subject_id = 'compliance_report' ORDER BY created_at").all() as Array<{ decision: string; reason: string }>;
    const schedulerStalls = ((stalls.body.stalls ?? []) as Array<{ subsystem: string }>).filter((s) => s.subsystem.includes('compliance_report') || s.subsystem.includes('compliance'));
    const lastRun = Date.parse(String(reg.entry?.last_run));
    const obs = { interval_ms: INTERVAL_MS, detected_after_last_tick_ms: detectedAt - lastRun, registry: reg, cockpit_scheduler_fields: pickSchedulerFields(cockpit.body),
      scheduler_recovery_judgments: judgments, stall_watch_scheduler_stalls: schedulerStalls, stall_watch_health: stalls.body.health,
      needs_you_stalls: { stalls: needsYou.body.needs_you?.stalls, operator_stalls: needsYou.body.needs_you?.operator_stalls }, outbound: [...h.outbound] };
    recordObs('S7-c', obs);

    expect(reg.entry?.status).toBe('armed_not_ticking');
    expect(reg.health).toBe('BREACHED');
    expect(obs.detected_after_last_tick_ms).toBeLessThanOrEqual(2 * INTERVAL_MS + 1_000); // the registry's own rule: > 2× interval
    expect(judgments.map((j) => j.decision)).toContain('diagnosed');
  });

  failing('FAIL D-S7-2 stuck scheduler with a restart function is never escalated to the stall watch in the default (shadow) self-heal mode', async () => {
    expect(armComplianceScheduler()).toBe(true);
    sched!.stop();
    stopWatchdog = startSchedulerWatchdog(h.db, 200);
    await until(async () => ((await registryEntry()).entry?.status === 'armed_not_ticking' ? true : null), 10_000, 100);
    await sleep(1_500);
    const stalls = await h.api('GET', '/health/stalls');
    const subsystems = ((stalls.body.stalls ?? []) as Array<{ subsystem: string }>).map((s) => s.subsystem);
    recordObs('S7-c-escalation', { subsystems, health: stalls.body.health });
    // expected: "shadow (default) diagnoses + escalates without restarting" (scheduler-registry.ts header of healSchedulers)
    expect(subsystems.some((s) => s.includes('compliance_report'))).toBe(true);
  });

  failing('FAIL D-S7-1 a tick whose work throws is never "failing": markRun runs before the work and the error is swallowed', async () => {
    const thrower = { generateReport: () => { throw new Error('S7 injected report failure'); } } as unknown as ConstructorParameters<typeof ComplianceReportScheduler>[1];
    const since = new Date().toISOString();
    expect(armComplianceScheduler(thrower)).toBe(true);
    await sleep(2 * INTERVAL_MS + 300); // boot tick + ≥ 2 timer ticks, every one of which failed its work
    const reg = await registryEntry();
    const cockpit = await h.api('GET', '/health/cockpit');
    const obs = { registry: reg, reports_written: reportCount(since), cockpit_scheduler_fields: pickSchedulerFields(cockpit.body) };
    recordObs('S7-b', obs);
    expect(obs.reports_written).toBe(0); // the work really failed on every tick since it was armed
    // the registry's rule: "failing: its last tick reported an error"
    expect(reg.entry?.status).toBe('failing');
    expect(reg.health).toBe('BREACHED');
  });

  failing('FAIL D-S7-3 (E2, primitive) guardTick never clears an earlier error for a tick fn that does not call markRun itself', async () => {
    // the shape of inference_failover_probe / operator_digest: setInterval(guardTick(name, () => work()))
    noteScheduler('s7_guardtick_probe', 'S7_PROBE', true, 60_000);
    let fail = true;
    const tick = guardTick('s7_guardtick_probe', () => { if (fail) throw new Error('S7 transient failure'); });
    tick(); // fails
    fail = false;
    tick(); tick(); // succeed
    const entry = (await h.api('GET', '/health/schedulers')).body.schedulers.find((s: { name: string }) => s.name === 's7_guardtick_probe');
    recordObs('S7-d', { entry });
    markRun('s7_guardtick_probe'); // cleanup only (after the observation): not part of the scenario outcome
    expect(entry.status).toBe('executing');
    expect(entry.last_error).toBeNull();
  });
});

function pickSchedulerFields(cockpit: unknown): unknown {
  const out: Record<string, unknown> = {};
  const walk = (v: unknown, p: string) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/scheduler/i.test(k)) out[`${p}${k}`] = x;
      else if (x && typeof x === 'object' && !Array.isArray(x) && p.split('.').length < 3) walk(x, `${p}${k}.`);
    }
  };
  walk(cockpit, '');
  return out;
}
