/**
 * Required status checks as branch protection defines them: a context AND the app that must produce it (`checks[].app_id`;
 * -1 or absent = any source). The producer is part of the identity — a skipped GitHub Actions `sbom` next to a successful
 * `sbom` from another app is not a pass (Codex review of #1061). Used by loop-auto-merge.ts and dependency-lane.ts;
 * scripts/merge-train.sh and scripts/auto-deploy.sh mirror it.
 */
export interface RequiredCheck { context: string; app_id: number | null }
export type ProtectionChecks = { contexts?: string[]; checks?: Array<{ context?: string; app_id?: number | null }> } | null | undefined;
export interface CheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; completed_at?: string | null; app?: { id?: number } | null }

/** The required checks of a `required_status_checks` block; a context listed only in the legacy `contexts` is any-source. */
export function requiredChecksOf(r: ProtectionChecks): RequiredCheck[] {
  const out = new Map<string, RequiredCheck>();
  for (const c of r?.checks ?? []) {
    if (c.context) out.set(c.context, { context: c.context, app_id: typeof c.app_id === 'number' && c.app_id >= 0 ? c.app_id : null });
  }
  for (const n of r?.contexts ?? []) if (n && !out.has(n)) out.set(n, { context: n, app_id: null });
  return [...out.values()];
}

const order = (a: CheckRun, b: CheckRun) => (Number(a.id) || 0) - (Number(b.id) || 0) || String(a.completed_at ?? '').localeCompare(String(b.completed_at ?? ''));
const newestBy = <T extends CheckRun>(runs: T[], key: (r: T) => string): T[] => [...new Map([...runs].sort(order).map((r) => [key(r), r] as const)).values()];

/** The newest run per producer and name: a rerun replaces the run it re-ran, another app's run never hides it. */
export const newestRuns = <T extends CheckRun>(runs: T[]): T[] => newestBy(runs, (r) => `${r.app?.id ?? ''}\u0000${r.name ?? ''}`);

/** The newest run of `req` from its required producer; undefined when that producer has not reported it. */
export function requiredRun<T extends CheckRun>(runs: T[], req: RequiredCheck): T | undefined {
  return newestBy(runs.filter((r) => r.name === req.context && (req.app_id === null || r.app?.id === req.app_id)), (r) => String(r.name)).at(0);
}
