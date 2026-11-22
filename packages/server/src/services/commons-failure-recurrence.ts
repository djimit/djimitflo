import type { Database } from 'better-sqlite3';

/**
 * Does a failure kind the Commons discussed come back less often than one it did not? Read-only and descriptive, not causal:
 * the failure agenda picks the newest undiscussed failure, not a random one.
 *
 * Kind = loop + failed gates + cause (the signature the failure agenda stores on its question). Anchor = the first Commons
 * question on that kind (discussed) or the kind's first failure in the lookback (not discussed). Recurred = another failure
 * of the kind within windowDays after the anchor. Kinds whose anchor is younger than the window are unsettled and left out.
 */
export interface FailureRecurrence {
  windowDays: number; lookbackDays: number; minN: number;
  /** rate is null below minN settled kinds per arm */
  arms: Array<{ arm: 'discussed' | 'not_discussed'; kinds: number; recurred: number; unsettled: number; rate: number | null }>;
}

const WINDOW_DAYS = 14;
const LOOKBACK_DAYS = 90;
const MIN_N = 30;

export function failureSignature(loopName: string, gatesJson: string | null, reason: string | null): string {
  let gates: Array<{ name?: string; status?: string }> = [];
  try { gates = JSON.parse(gatesJson || '[]'); } catch { /* none */ }
  return `${loopName}|${gates.filter((g) => g.status === 'fail').map((g) => g.name).sort().join('+')}|${/cause=([a-z_]+)/.exec(reason ?? '')?.[1] ?? 'unknown'}`;
}

// SQLite datetime('now') has no zone; both forms are UTC
const ms = (t: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);

/** null = the tables cannot be read on this schema (unknown, not "no recurrence"). */
export function failureRecurrence(db: Database, now = Date.now()): FailureRecurrence | null {
  let failures: Array<{ reason: string | null; created_at: string; loop_name: string; gates_json: string | null }>;
  let discussed: Array<{ sig: string; at: string }>;
  try {
    failures = db.prepare(`SELECT j.reason, j.created_at, r.loop_name, r.gates_json FROM judgments j JOIN loop_runs r ON r.id = j.subject_id
      WHERE j.judgment = 'failure_cause' AND j.subject_type = 'loop_run' AND j.created_at >= ?`).all(new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString()) as typeof failures;
    discussed = db.prepare(`SELECT json_extract(payload_json, '$.params.failure_signature') AS sig, MIN(timestamp) AS at FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.question' AND json_type(payload_json, '$.params.failure_signature') = 'text' GROUP BY 1`).all() as typeof discussed;
  } catch { return null; }
  const byKind = new Map<string, number[]>();
  for (const f of failures) {
    const sig = failureSignature(f.loop_name, f.gates_json, f.reason);
    byKind.set(sig, [...(byKind.get(sig) ?? []), ms(f.created_at)]);
  }
  const discussedAt = new Map(discussed.map((d) => [d.sig, ms(d.at)]));
  const window = WINDOW_DAYS * 86_400_000;
  const tally = { discussed: { kinds: 0, recurred: 0, unsettled: 0 }, not_discussed: { kinds: 0, recurred: 0, unsettled: 0 } };
  for (const [sig, times] of byKind) {
    const arm = discussedAt.has(sig) ? tally.discussed : tally.not_discussed;
    const anchor = discussedAt.get(sig) ?? Math.min(...times);
    if (anchor > now - window) { arm.unsettled += 1; continue; }
    arm.kinds += 1;
    if (times.some((t) => t > anchor && t <= anchor + window)) arm.recurred += 1;
  }
  return { windowDays: WINDOW_DAYS, lookbackDays: LOOKBACK_DAYS, minN: MIN_N,
    arms: (['discussed', 'not_discussed'] as const).map((arm) => ({ arm, ...tally[arm], rate: tally[arm].kinds >= MIN_N ? tally[arm].recurred / tally[arm].kinds : null })) };
}
