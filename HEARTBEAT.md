<!-- generated — do not edit. Source: noteScheduler(...) calls in packages/server/src (registry behind GET /api/health/schedulers). Regenerate: node scripts/gen-agent-docs.mjs -->

# HEARTBEAT — what runs on its own

Background schedulers registered at boot. Armed = its flag is set in runtime.env; live status (executing / armed_not_ticking /
unknown …) is `GET /api/health/schedulers` (admins). Armed is intent, not execution: UNKNOWN is not HEALTHY.

| Scheduler | Gating flag | Interval | Owner |
|---|---|---|---|
| advisory_exposure | `ADVISORY_EXPOSURE_MODE` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| auto_requeue | `REQUEUE_AUTO_MODE` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| committee_evolution | `COMMITTEE_SWARM_ENABLED` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| commons_falsifier | `COMMONS_FALSIFIER_MODE` | 1 h | `packages/server/src/services/commons-falsifier.ts` |
| commons_investigation_outcomes | `COMMONS_INVESTIGATION_MODE` | 15 min | `packages/server/src/services/commons-investigation.ts` |
| compliance_report | `COMPLIANCE_REPORT_SCHEDULER_ENABLED` | `complianceReportSched.intervalHours()` h | `packages/server/src/index.ts` |
| content_drafts | `CONTENT_DRAFTS_MODE` | 6 h | `packages/server/src/index.ts` |
| dead_code_lane | `DEAD_CODE_LANE_ENABLED` | 12 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| dependency_lane | `DEPENDENCY_LANE_MODE` | `laneIntervalMs()` | `packages/server/src/index.ts` |
| djimitsec_repository_scan | `DJIMITSEC_SCAN_TRIGGERS` | 1 min | `packages/server/src/index.ts` |
| dream_evolution | `DREAM_EVOLUTION_ENABLED` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| dream_state | `DREAM_STATE_ENABLED` | 6 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| evolution_estimators | `EVOLUTION_ESTIMATORS_ENABLED` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| evolution_gym | `EVOLUTION_GYM_ENABLED` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| finding_fix_lane | `FINDING_FIX_LANE` | 12 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| fleet_repair | `FLEET_REPAIR_MODE` | 24 h | `packages/server/src/services/fleet-repair.ts` |
| frontier_experts | `FRONTIER_EXPERTS_SCHEDULER_ENABLED` | `frontierExpertsSched.intervalMinutes()` min | `packages/server/src/index.ts` |
| gym_orphan_sweep | `GYM_ORPHAN_SWEEP` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| inference_failover_probe | `OLLAMA_AUTO_FAILOVER` | 30 min | `packages/server/src/index.ts` |
| loop_auto_merge | `LOOP_AUTO_MERGE_TEST_ONLY` | 15 min | `packages/server/src/bootstrap/autonomous-services.ts` |
| memory_candidate_review | `MEMORY_CANDIDATE_REVIEW_ENABLED` | `memoryCandidateReviewSched.intervalMinutes()` min | `packages/server/src/index.ts` |
| memory_delivery_reconcile | `MEMORY_DELIVERY_RECEIPTS` | 10 min | `packages/server/src/index.ts` |
| merge_survival | `MERGE_SURVIVAL_ENABLED` | 6 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| retention | `RETENTION_ENABLED` | `this.intervalMs` | `packages/server/src/services/retention-service.ts` |
| scheduled_proposal_goals | `(always on with autonomy)` | `Number(process.env.SCHEDULED_PROPOSAL_GOALS_INTERVAL_MS) \|\| 3_600_0…` | `packages/server/src/bootstrap/autonomous-services.ts` |
| self_healing | `SELF_HEALING_SCHEDULER_ENABLED` | `selfHealingSched.intervalMinutes()` min | `packages/server/src/index.ts` |
| self_improvement_auto_review | `SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED` | `selfImprovementAutoReviewSched.intervalMinutes()` min | `packages/server/src/index.ts` |
| settlement_execution | `SETTLEMENT_EXECUTION_MODE` | 24 h | `packages/server/src/services/settlement-execution.ts` |
| shipped_code_scan | `SHIPPED_CODE_SCAN_MODE` | 24 h | `packages/server/src/index.ts` |
| skill_distillation | `SKILL_DISTILLATION_MODE` | 24 h | `packages/server/src/index.ts` |
| specialist_panel_backlog | `SPECIALIST_PANEL_BACKLOG_ENABLED` | `specialistPanelBacklogSched.intervalMinutes()` min | `packages/server/src/index.ts` |
| stall_watch | `STALL_WATCH_ENABLED` | 1 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| test_gap_source | `TEST_GAP_SOURCE_ENABLED` | 6 h | `packages/server/src/bootstrap/autonomous-services.ts` |
| value_allocator | `VALUE_ALLOCATOR_MODE` | 6 h | `packages/server/src/bootstrap/autonomous-services.ts` |

## Operator tasks (daily)

- Read the operator digest (`GET /api/health/digest`; Telegram when `OPERATOR_DIGEST_ENABLED`).
- Answer pending approvals and the needs-you list before their TTL (`APPROVAL_TTL_MS`, prod 12 h).
- Check scheduler health (`GET /api/health/schedulers`: BREACHED or UNKNOWN needs a look) and stalls (`GET /api/health/stalls`).
- Check provider usage against the plan limits (`/usage`; TOOLS.md) and the Ollama failover state (`inference.failover`).
- Review loop draft PRs; merge only via `scripts/merge-train.sh` with a pinned head.
- Before a legacy runtime admission expires, re-assess it (TOOLS.md "Runtimes"; `expiringAdmissions`).
- Production deploys itself from green `main` (`scripts/auto-deploy.sh`); stop with `/srv/djimitflo/AUTO_DEPLOY_DISABLED`.
