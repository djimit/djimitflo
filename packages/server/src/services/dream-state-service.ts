import type { Database } from 'better-sqlite3';
import { judgmentMode, runJudgment } from './judgment-service';
import { failureCause } from './judgments/failure-cause';
import { MemoryCandidateService } from './memory-candidate-service';

/**
 * Outcome-driven dream state (plan E11), step 1–2: replay the recent failed/blocked loop runs and classify each once with
 * the `failure_cause` judgment (shadow). Replaces the legacy capability ranking (gated off in E14). Later steps consolidate
 * recurring causes into engineering rules and generate grounded fix proposals.
 *   DREAM_STATE_ENABLED=true to schedule (every 6 h, first run 2 min after boot); TYPESAFE_FAILURE_CAUSE_MODE=shadow to classify.
 */
const MAX_PER_REPLAY = 25;
const MIN_RECURRENCE = 2;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);

export const dreamStateEnabled = (): boolean => process.env.DREAM_STATE_ENABLED === 'true';

export interface ReplayResult { candidates: number; classified: number; consolidated?: number }

export class DreamStateService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 6 * 3600_000): void {
    if (this.timer || !dreamStateEnabled()) return;
    const run = () => { this.replay().then((r) => { if (r.classified) console.log(`🌙 dream state: classified ${r.classified}/${r.candidates} failed runs`); }).catch((err) => console.warn('Dream state replay failed:', err instanceof Error ? err.message : String(err))); };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 120_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Failed/blocked runs of the last `days` without a failure_cause judgment yet, with their evidence. */
  pendingFailures(days = 7, limit = MAX_PER_REPLAY): Array<{ id: string; state: Record<string, unknown> }> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const runs = this.db.prepare(`SELECT id, loop_name, status, gates_json, goal_id FROM loop_runs
      WHERE status IN ('blocked', 'failed') AND updated_at >= ?
        -- classified once, except that an 'uncertain' result gets one more try (the state was enriched on 2026-09-24)
        AND id NOT IN (SELECT subject_id FROM judgments WHERE judgment = 'failure_cause' AND subject_type = 'loop_run'
          GROUP BY subject_id HAVING SUM(decision != 'uncertain') > 0 OR COUNT(*) >= 2)
      ORDER BY updated_at DESC LIMIT ?`).all(since, limit) as Array<{ id: string; loop_name: string; status: string; gates_json: string | null; goal_id: string | null }>;
    return runs.map((r) => {
      let gates: Array<{ name?: string; status?: string; evidence?: string }> = [];
      try { gates = JSON.parse(r.gates_json || '[]'); } catch { /* keep empty */ }
      const leases = this.db.prepare(`SELECT role, status, json_extract(metadata, '$.verdict') AS verdict,
        COALESCE(json_extract(metadata, '$.notes'), json_extract(metadata, '$.failure_reason'), '') AS notes,
        json_extract(metadata, '$.deterministic_checks') AS checks
        FROM worker_leases WHERE loop_run_id = ?`).all(r.id) as Array<{ role: string; status: string; verdict: string | null; notes: string; checks: string | null }>;
      // Prod 2026-09-24: 17/23 classifications were `uncertain` where the state held only gate names; the run's own events
      // and check results are what a human reads to diagnose, so they go into the state too (still clipped, no raw logs).
      const events = (this.db.prepare(`SELECT event_type, message FROM loop_events WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 8`).all(r.id) as Array<{ event_type: string; message: string }>)
        .reverse().map((e) => `${e.event_type}: ${clip(e.message, 200)}`);
      const checks = (raw: string | null) => { try { return (JSON.parse(raw || '[]') as Array<{ name?: string; status?: string; exit_status?: number }>).map((c) => `${c.name}=${c.status}${c.exit_status ? ` (exit ${c.exit_status})` : ''}`); } catch { return []; } };
      const goalFailure = r.goal_id ? (this.db.prepare(`SELECT message FROM loop_events WHERE loop_run_id = ? AND event_type = 'goal_failed' ORDER BY created_at DESC LIMIT 1`).get(r.id) as { message: string } | undefined)?.message : undefined;
      return { id: r.id, state: { run: {
        loop: r.loop_name, status: r.status,
        failed_gates: gates.filter((g) => g.status !== 'pass').map((g) => `${g.name}: ${clip(g.evidence, 300)}`),
        workers: leases.map((l) => ({ role: l.role, status: l.status, verdict: l.verdict, notes: clip(l.notes, 400), ...(l.checks ? { checks: checks(l.checks) } : {}) })),
        events,
        goal_failure: clip(goalFailure, 300),
      } } };
    });
  }

  async replay(): Promise<ReplayResult> {
    if (judgmentMode(failureCause.id) === 'off') return { candidates: 0, classified: 0 };
    const pending = this.pendingFailures();
    let classified = 0;
    for (const p of pending) if (await runJudgment(this.db, failureCause, { type: 'loop_run', id: p.id }, p.state)) classified += 1;
    return { candidates: pending.length, classified, consolidated: this.consolidate() };
  }

  /**
   * Step 3: a cause that recurs (>= MIN_RECURRENCE confident classifications in 7 days for the same cause + failed gate)
   * becomes one memory candidate (engineering_rule), at most once per 7 days per key. Candidates still go through the
   * normal review/promotion before any decision reads them (E8).
   */
  consolidate(days = 7): number {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT j.reason, r.gates_json, r.loop_name FROM judgments j JOIN loop_runs r ON r.id = j.subject_id
      WHERE j.judgment = 'failure_cause' AND j.decision != 'uncertain' AND j.created_at >= ?`).all(since) as Array<{ reason: string | null; gates_json: string | null; loop_name: string }>;
    const groups = new Map<string, { cause: string; gate: string; loop: string; n: number; platform: number }>();
    for (const r of rows) {
      const cause = /cause=([a-z_]+)/.exec(r.reason || '')?.[1];
      if (!cause) continue;
      let gates: Array<{ name?: string; status?: string }> = [];
      try { gates = JSON.parse(r.gates_json || '[]'); } catch { /* none */ }
      const gate = gates.find((g) => g.status === 'fail')?.name ?? 'no_failed_gate';
      const key = `${cause}:${gate}`;
      const g = groups.get(key) ?? { cause, gate, loop: r.loop_name, n: 0, platform: 0 };
      g.n += 1; if (Number(/platform_fault=([0-9.]+)/.exec(r.reason || '')?.[1] ?? 0) > 0.5) g.platform += 1;
      groups.set(key, g);
    }
    const memory = new MemoryCandidateService(this.db);
    let created = 0;
    for (const [key, g] of groups) {
      if (g.n < MIN_RECURRENCE) continue;
      const sourceRef = `dream:cause:${key}`;
      if (this.db.prepare('SELECT 1 FROM memory_candidates WHERE source_ref = ? AND created_at >= ?').get(sourceRef, since)) continue;
      try {
        memory.create({
          title: `Recurring loop failure: ${g.cause} at ${g.gate}`.slice(0, 200),
          content: `In the last ${days} days ${g.n} ${g.loop} runs failed with cause "${g.cause}" at gate "${g.gate}"`
            + ` (${g.platform}/${g.n} judged a platform fault). Check this before approving or reviewing similar runs; `
            + `a platform fault needs a platform fix, not a new attempt at the same change.`,
          memory_type: 'engineering_rule', source_ref: sourceRef,
          metadata: { origin: 'dream-state', cause: g.cause, gate: g.gate, occurrences: g.n, platform_fault_count: g.platform },
        });
        created += 1;
      } catch { /* e.g. secret detector: skip, never break the replay */ }
    }
    return created;
  }
}
