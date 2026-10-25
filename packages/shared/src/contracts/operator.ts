/**
 * UX-2b: the top-level response keys of the operator endpoints the dashboard renders. One list, two checks:
 * the server's contract tests assert each builder returns exactly these keys, and the dashboard's types are
 * checked against them at compile time (lib/api-contracts.ts). A key added on one side only fails one of the two.
 * Plain key lists on purpose — no runtime validation in the dashboard.
 */
export const OPERATOR_CONTRACTS = {
  /** GET /api/health/cockpit — services/operator-cockpit.ts */
  cockpit: ['at', 'snapshot_id', 'health', 'errors', 'build', 'scorecard', 'guardrails', 'stalls', 'detectors', 'gym', 'remote_workers', 'maker_usage_7d', 'judgments_7d', 'needs_you', 'schedulers', 'genomes', 'deploys', 'evolution', 'capabilities', 'subtraction', 'unit_economics'],
  /** GET /api/health/evolution-evidence — services/evolution-evidence.ts */
  evolutionEvidence: ['at', 'window_days', 'flags', 'outcomes', 'outcomes_tagged', 'merge', 'drafts', 'genomes', 'gym', 'gym_prod_gates', 'gym_diffs', 'trials', 'models', 'oracle', 'commons',
    'forecasts_v2', 'hacks', 'hack_rate', 'estimates', 'ope', 'egress', 'failure_tasks', 'embedding_dim_mismatch', 'freshness', 'auto_merge', 'memory_holdout', 'runtime_fallback', 'inference', 'effort_x1', 'checker_family', 'graded', 'fail_before_pass_after', 'ace_001', 'ste_001', 'maker_deps_001', 'd5_no', 'tg_001', 'knowledge_links', 'holdout_exposure', 'intelligence', 'gates', 'lineage', 'provenance', 'panel_attempts', 'maker_tokens', 'negative_evidence', 'knowledge_gaps', 'jev_challenger', 'gate_rule_disagreements', 'experiments', 'learning_ledger', 'fleet_signatures', 'falsifier', 'settlement_execution', 'scheduler_capacity'],
  /** GET /api/health/forecasts-v2 — services/forecast-scoring.ts forecastScoresV2 */
  forecastsV2: ['forecasters', 'would_have_stopped'],
  /** GET /api/health/runtimes — { runtimes: RuntimeHealthRow[] } */
  runtimes: ['runtimes'],
  /** one row of GET /api/health/runtimes — services/runtime-health.ts */
  runtimeRow: ['runtime', 'admission', 'version', 'probe', 'leases_30d', 'leases_90d', 'last_success_at', 'gym', 'readiness'],
  /** GET /api/health/digest — services/operator-push.ts buildDigest */
  digest: ['at', 'text', 'data'],
  /** GET /api/loops/draft-prs — services/loop-draft-pr-service.ts listDraftPrs (E1: counts per settlement state) */
  draftPrs: ['total', 'unsettled', 'by_settlement', 'closed_unmerged', 'rows'],
  /** one row of GET /api/loops/draft-prs */
  draftPrRow: ['run_id', 'lane', 'pr_url', 'pr_number', 'age_days', 'outcome', 'survived', 'auto_merge', 'settlement', 'settlement_reason', 'settlement_terminal', 'settlement_age_days'],
  /** GET /api/health/efficiency — services/cost-ledger.ts efficiencyWithCost (resource-ledger efficiencyView + cost_per_verified) */
  efficiency: ['at', 'window_days', 'ledger_enabled', 'consumers', 'ledger', 'hosts', 'north_star', 'coverage', 'notes', 'cost_per_verified'],
  /** GET /api/health/schedulers — services/scheduler-registry.ts listSchedulers */
  schedulers: ['armed', 'by_status', 'health', 'off', 'schedulers'],
  /** GET /api/health/stalls — services/stall-watch.ts detectStallsWithHealth */
  stalls: ['stalls', 'detectors', 'health', 'capabilities'],
} as const;

/**
 * E1: the evolutionary settlement state of a loop PR (server: services/merge-survival.ts settlementState) — one per PR,
 * independent of its GitHub state. Only SETTLED_SURVIVED / SETTLED_REGRESSED enter a survival rate.
 */
export const LOOP_PR_SETTLEMENT_STATES = ['OPEN_BLOCKED', 'MERGED_SURVIVAL_PENDING', 'SETTLED_SURVIVED', 'SETTLED_REGRESSED', 'PIPELINE_ANOMALY'] as const;
export type LoopPrSettlementState = (typeof LOOP_PR_SETTLEMENT_STATES)[number];

export type OperatorContract = keyof typeof OPERATOR_CONTRACTS;
export type ContractKeys<C extends OperatorContract> = (typeof OPERATOR_CONTRACTS)[C][number];
