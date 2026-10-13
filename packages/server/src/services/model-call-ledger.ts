import type { Database } from 'better-sqlite3';
import { recordModelCall } from './model-selector';

/**
 * B29 (operator 2026-10-11, after PR #779): every model call answers "what for, in which experiment, at what cost".
 * Maker runs (opencode / remote / atomic CLIs) spend their tokens outside the server's HTTP clients, so their call is
 * recorded here from the lease's runtime_usage when the run settles — once per run, with the experiment arms it ran in.
 */
type Usage = { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; usage_source?: unknown };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 'ACE-001:01,STE-001:1,F2:cross' — the arms a goal's maker ran in; null when it ran in none. */
export function experimentArms(db: Database, goalId: string | null, ace: { arm: string } | null, ste: { arm: number } | null): string | null {
  const arms: string[] = [];
  if (ace) arms.push(`ACE-001:${ace.arm}`);
  if (ste) arms.push(`STE-001:${ste.arm}`);
  if (goalId) {
    try {
      const f2 = db.prepare("SELECT json_extract(metadata, '$.checker_family_arm') AS arm FROM goals WHERE id = ?").get(goalId) as { arm: string | null } | undefined;
      if (f2?.arm) arms.push(`F2:${f2.arm}`);
    } catch { /* goals without metadata on an old schema */ }
  }
  return arms.length ? arms.join(',') : null;
}

export function recordMakerCall(db: Database, c: {
  runId: string; goalId: string | null; loopName: string; runtime: string; meta: { model?: unknown; runtime_usage?: Usage }; ace: { arm: string } | null;
  ste: { arm: number } | null; durationMs: number; ok: boolean;
}): void {
  const usage = c.meta.runtime_usage ?? {};
  // a runtime that reported only a total keeps tokens_in = total, tokens_out = null (split unknown) — never 0
  const input = num(usage.input_tokens); const output = num(usage.output_tokens); const total = num(usage.total_tokens);
  const tokensIn = input !== null && (input > 0 || (output ?? 0) > 0) ? input : total;
  const tokensOut = input !== null && (input > 0 || (output ?? 0) > 0) ? output : null;
  recordModelCall(db, {
    consumer: 'maker', model: typeof c.meta.model === 'string' ? c.meta.model : c.runtime, provider: c.runtime, ok: c.ok, latencyMs: c.durationMs, outChars: 0,
    shadow: 0, agree: null, tokensIn, tokensOut, taskKind: c.loopName, runId: c.runId, purpose: `maker:${c.loopName}`,
    experimentId: experimentArms(db, c.goalId, c.ace, c.ste), status: c.ok ? 'verified' : 'not_verified',
  });
}

/** Totals per purpose and per experiment arm over a window (calls, tokens with unknowns counted apart, costs). */
export function ledgerTotals(db: Database, since: string): {
  by_purpose: Array<Record<string, unknown>>; by_experiment: Array<Record<string, unknown>>;
} {
  const q = (group: string) => {
    try {
      return db.prepare(`SELECT ${group} AS key, COUNT(*) AS calls, SUM(ok) AS ok,
          SUM(CASE WHEN tokens_in IS NULL AND tokens_out IS NULL THEN 1 ELSE 0 END) AS calls_tokens_unknown,
          SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, ROUND(AVG(latency_ms)) AS avg_latency_ms,
          SUM(list_price_cost) AS list_price_cost, SUM(CASE WHEN list_price_cost IS NULL THEN 1 ELSE 0 END) AS calls_list_price_unknown,
          SUM(marginal_cost) AS marginal_cost, SUM(CASE WHEN marginal_cost IS NULL THEN 1 ELSE 0 END) AS calls_marginal_unknown,
          GROUP_CONCAT(DISTINCT cost_basis) AS cost_basis
        FROM llm_model_calls WHERE created_at >= ? AND ${group} IS NOT NULL GROUP BY 1 ORDER BY calls DESC`).all(since) as Array<Record<string, unknown>>;
    } catch { return []; }
  };
  return { by_purpose: q('purpose'), by_experiment: q('experiment_id') };
}
