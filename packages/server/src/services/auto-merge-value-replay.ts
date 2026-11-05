import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { autoMergeValueSignal, VALUE_GATE_REPLAY_JUDGMENT, VALUE_KILL_SHARE_MIN } from './loop-auto-merge-state';
import { parsePrUrl } from './repo-registry';
import { runLanes } from './settlement-execution';

export { VALUE_GATE_REPLAY_JUDGMENT };

/**
 * E-assumptions C4 (re-20261030): one-off shadow evidence for LOOP_AUTO_MERGE_VALUE_GATE. Since the flip to shadow no PR reached
 * the gate (0 decisions), so the operator would decide `on` on n = 0. This replays the shipped rule (autoMergeValueSignal) on
 * the maker lease of every past auto-merge (auto_merge.decision = 'merged'; the lease the tick reads: latest completed,
 * not superseded) and, only with apply, writes one judgment per decision: judgment auto_merge_value_gate_replay, mode shadow,
 * decision pass | low | missing, answers_json.replay = true. Read-only otherwise: no decision, lease or flag is changed.
 * Idempotent: the judgment id is derived from the run id (INSERT OR IGNORE), so a re-run adds nothing.
 * CLI: node dist/scripts/auto-merge-value-replay.js --db <path> [--apply] (dry run by default).
 */
type Signal = 'pass' | 'low' | 'missing';
export interface ValueGateReplayRow {
  run_id: string; pr_number: number | null; lane: string; decided_at: string | null; signal: Signal;
  would_block_value: 'value_signal_low' | 'value_signal_missing' | null;
  fbpa: { shadow_status: unknown; before: unknown } | null; graded: { kind: unknown; score: unknown } | null; live_would_block_value: string | null;
}
const parse = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const counts = () => ({ pass: 0, low: 0, missing: 0 });

export function replayAutoMergeValueGate(db: Database, opts: { apply?: boolean; now?: Date } = {}) {
  const now = (opts.now ?? new Date()).toISOString();
  const runs = db.prepare(`SELECT r.id, json_extract(r.metadata, '$.auto_merge.pr_number') AS pr, json_extract(r.metadata, '$.auto_merge.at') AS at,
      json_extract(r.metadata, '$.auto_merge.would_block_value') AS live,
      (SELECT json_extract(l.metadata, '$.deterministic_checks') FROM worker_leases l WHERE l.loop_run_id = r.id AND l.role = 'maker' AND l.status = 'completed'
        AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY l.updated_at DESC LIMIT 1) AS checks,
      (SELECT json_extract(l.metadata, '$.graded') FROM worker_leases l WHERE l.loop_run_id = r.id AND l.role = 'maker' AND l.status = 'completed'
        AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY l.updated_at DESC LIMIT 1) AS graded
    FROM loop_runs r WHERE json_extract(r.metadata, '$.auto_merge.decision') = 'merged' ORDER BY r.id`)
    .all() as Array<{ id: string; pr: number | null; at: string | null; live: string | null; checks: string | null; graded: string | null }>;
  const lanes = runLanes(db);
  const rows: ValueGateReplayRow[] = runs.map((r) => {
    const checks = parse(r.checks); const graded = parse(r.graded) as { kind?: unknown; score?: unknown } | null;
    const signal = autoMergeValueSignal(checks, graded);
    const fbpa = Array.isArray(checks) ? (checks as Array<{ name?: unknown; shadow_status?: unknown; before?: unknown } | null>).find((c) => c?.name === 'test:fail-before-pass-after') : undefined;
    return { run_id: r.id, pr_number: r.pr, lane: lanes.get(r.id) ?? 'other', decided_at: r.at, signal,
      would_block_value: signal === 'pass' ? null : signal === 'low' ? 'value_signal_low' : 'value_signal_missing',
      fbpa: fbpa ? { shadow_status: fbpa.shadow_status ?? null, before: fbpa.before ?? null } : null,
      graded: graded && typeof graded === 'object' ? { kind: graded.kind ?? null, score: graded.score ?? null } : null, live_would_block_value: r.live };
  });
  const totals = counts(); const by_lane: Record<string, ReturnType<typeof counts>> = {};
  for (const r of rows) { totals[r.signal]++; (by_lane[r.lane] ??= counts())[r.signal]++; }
  let written = 0;
  if (opts.apply) {
    const ins = db.prepare(`INSERT OR IGNORE INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, ?, 'loop_run', ?, ?, 'shadow', ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const r of rows) {
        const answers = { replay: true, lane: r.lane, pr_number: r.pr_number, decision: 'merged', decided_at: r.decided_at, fbpa: r.fbpa, graded: r.graded,
          would_block_value: r.would_block_value, live_would_block_value: r.live_would_block_value };
        const hash = createHash('sha256').update(JSON.stringify({ fbpa: r.fbpa, graded: r.graded })).digest('hex').slice(0, 16);
        written += ins.run(`${VALUE_GATE_REPLAY_JUDGMENT}:${r.run_id}`, VALUE_GATE_REPLAY_JUDGMENT, r.run_id, hash, r.signal,
          r.would_block_value ?? 'value signal present', JSON.stringify(answers), now).changes;
      }
    })();
  }
  const would_block = totals.low + totals.missing;
  return { applied: !!opts.apply, decisions: rows.length, totals, by_lane, would_block, would_block_share: rows.length ? +(would_block / rows.length).toFixed(3) : null,
    written, already_recorded: opts.apply ? rows.length - written : 0, rows };
}

/**
 * re-20261105 B1: the merge train's input (scripts/merge-train.sh --value-signals F). For every loop PR of `repo` (any auto-merge
 * decision, or none) the gate's own rule on the deciding maker lease (latest completed, not superseded — what the tick reads):
 * lane (settlement runLanes / oracleLane) and value_signal pass | low | missing. The newest run per PR number decides. Read-only.
 * CLI: node dist/scripts/pr-value-signals.js --db <path> [--repo owner/name].
 */
export function prValueSignals(db: Database, repo: string, now = new Date()) {
  const runs = db.prepare(`SELECT r.id, json_extract(r.metadata, '$.pr_url') AS url,
      (SELECT json_extract(l.metadata, '$.deterministic_checks') FROM worker_leases l WHERE l.loop_run_id = r.id AND l.role = 'maker' AND l.status = 'completed'
        AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY l.updated_at DESC LIMIT 1) AS checks,
      (SELECT json_extract(l.metadata, '$.graded') FROM worker_leases l WHERE l.loop_run_id = r.id AND l.role = 'maker' AND l.status = 'completed'
        AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY l.updated_at DESC LIMIT 1) AS graded
    FROM loop_runs r WHERE json_extract(r.metadata, '$.pr_url') IS NOT NULL ORDER BY r.created_at, r.id`).all() as Array<{ id: string; url: string; checks: string | null; graded: string | null }>;
  const lanes = runLanes(db);
  const prs: Record<string, { lane: string; value_signal: Signal; run_id: string }> = {};
  for (const r of runs) {
    const ref = parsePrUrl(r.url);
    if (!ref || ref.slug.toLowerCase() !== repo.toLowerCase()) continue;
    prs[String(ref.number)] = { lane: lanes.get(r.id) ?? 'other', value_signal: autoMergeValueSignal(parse(r.checks), parse(r.graded)), run_id: r.id };
  }
  return { source: 'dist/scripts/pr-value-signals.js (loop-auto-merge-state autoMergeValueSignal on the deciding maker lease)', repo, generated_at: now.toISOString(),
    kill_share_min: VALUE_KILL_SHARE_MIN, prs };
}
