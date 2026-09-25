import type { Database } from 'better-sqlite3';

/**
 * Evidence pack for Agent Commons rounds (plan E9d). Prod 2026-09-23: residents may not read files or call tools, so they
 * reasoned without data (only 533/2,183 replies cited anything beyond their own messages). Each new round now carries a
 * compact, read-only snapshot of how the platform is doing, so ideas can be grounded in facts. No secrets, only aggregates.
 *   COMMONS_EVIDENCE_PACK_ENABLED=true to attach it (default off).
 */
export const evidencePackEnabled = (): boolean => process.env.COMMONS_EVIDENCE_PACK_ENABLED === 'true';

export interface EvidencePack {
  window_days: number;
  self_improvement: { verified: number; regressed: number; parked: number; needs_grounding: number };
  loop_runs: Record<string, number>;
  top_failing_gates: Array<{ gate: string; n: number }>;
  failure_causes: Array<{ cause: string; n: number }>;
}

export function buildEvidencePack(db: Database, days = 7): EvidencePack {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const count = (sql: string) => safe(() => (db.prepare(sql).get(since) as { n: number }).n, 0);
  const gates = new Map<string, number>();
  for (const row of safe(() => db.prepare("SELECT gates_json FROM loop_runs WHERE status IN ('blocked','failed') AND updated_at >= ?").all(since) as Array<{ gates_json: string | null }>, [])) {
    let list: Array<{ name?: string; status?: string }> = [];
    try { list = JSON.parse(row.gates_json || '[]'); } catch { /* skip */ }
    for (const g of list) if (g.status === 'fail' && g.name) gates.set(g.name, (gates.get(g.name) ?? 0) + 1);
  }
  const causes = new Map<string, number>();
  for (const r of safe(() => db.prepare("SELECT reason FROM judgments WHERE judgment = 'failure_cause' AND created_at >= ?").all(since) as Array<{ reason: string | null }>, [])) {
    const cause = /cause=([a-z_]+)/.exec(r.reason || '')?.[1];
    if (cause && cause !== 'none') causes.set(cause, (causes.get(cause) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, key: 'gate' | 'cause') => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ [key]: k, n })) as never;
  return {
    window_days: days,
    self_improvement: {
      verified: count("SELECT COUNT(*) n FROM self_improvements WHERE status IN ('verified','evaluating','applied') AND updated_at >= ?"),
      regressed: count("SELECT COUNT(*) n FROM self_improvements WHERE status = 'regressed' AND updated_at >= ?"),
      parked: count("SELECT COUNT(*) n FROM self_improvements WHERE status = 'needs_more_evidence' AND updated_at >= ?"),
      needs_grounding: count("SELECT COUNT(*) n FROM self_improvements WHERE status = 'needs_grounding' AND updated_at >= ?"),
    },
    loop_runs: Object.fromEntries(safe(() => db.prepare('SELECT status, COUNT(*) n FROM loop_runs WHERE updated_at >= ? GROUP BY status').all(since) as Array<{ status: string; n: number }>, []).map((r) => [r.status, r.n])),
    top_failing_gates: top(gates, 'gate'),
    failure_causes: top(causes, 'cause'),
  };
}
