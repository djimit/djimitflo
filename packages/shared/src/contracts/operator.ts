/**
 * UX-2b: the top-level response keys of the operator endpoints the dashboard renders. One list, two checks:
 * the server's contract tests assert each builder returns exactly these keys, and the dashboard's types are
 * checked against them at compile time (lib/api-contracts.ts). A key added on one side only fails one of the two.
 * Plain key lists on purpose — no runtime validation in the dashboard.
 */
export const OPERATOR_CONTRACTS = {
  /** GET /api/health/cockpit — services/operator-cockpit.ts */
  cockpit: ['at', 'build', 'scorecard', 'guardrails', 'stalls', 'gym', 'remote_workers', 'maker_usage_7d', 'judgments_7d', 'needs_you', 'schedulers', 'genomes', 'deploys'],
  /** GET /api/health/evolution-evidence — services/evolution-evidence.ts */
  evolutionEvidence: ['at', 'window_days', 'flags', 'outcomes', 'outcomes_tagged', 'merge', 'drafts', 'genomes', 'gym', 'gym_prod_gates', 'trials', 'models', 'oracle', 'commons',
    'forecasts_v2', 'hacks', 'estimates', 'ope', 'egress', 'failure_tasks', 'embedding_dim_mismatch', 'freshness', 'auto_merge', 'memory_holdout', 'effort_x1', 'graded', 'gates'],
  /** GET /api/health/forecasts-v2 — services/forecast-scoring.ts forecastScoresV2 */
  forecastsV2: ['forecasters', 'would_have_stopped'],
  /** GET /api/health/runtimes — { runtimes: RuntimeHealthRow[] } */
  runtimes: ['runtimes'],
  /** one row of GET /api/health/runtimes — services/runtime-health.ts */
  runtimeRow: ['runtime', 'admission', 'version', 'probe', 'leases_30d', 'leases_90d', 'last_success_at', 'gym', 'readiness'],
  /** GET /api/health/digest — services/operator-push.ts buildDigest */
  digest: ['at', 'text', 'data'],
  /** GET /api/loops/draft-prs — services/loop-draft-pr-service.ts listDraftPrs */
  draftPrs: ['total', 'unsettled', 'rows'],
  /** one row of GET /api/loops/draft-prs */
  draftPrRow: ['run_id', 'lane', 'pr_url', 'pr_number', 'age_days', 'outcome', 'survived', 'auto_merge'],
  /** GET /api/health/efficiency — services/resource-ledger.ts efficiencyView (Phase E1/E3) */
  efficiency: ['at', 'window_days', 'ledger_enabled', 'consumers', 'ledger', 'hosts', 'north_star', 'notes'],
  /** GET /api/health/schedulers — services/scheduler-registry.ts listSchedulers */
  schedulers: ['armed', 'off', 'schedulers'],
} as const;

export type OperatorContract = keyof typeof OPERATOR_CONTRACTS;
export type ContractKeys<C extends OperatorContract> = (typeof OPERATOR_CONTRACTS)[C][number];
