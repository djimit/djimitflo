## Context

DjimFlo v8.1 has 1414 passing tests, 165+ services, and graph risk 0.00. Self-improving runs against the production database revealed critical data quality issues:

- **84% maker failure rate** — executeMaker throws exceptions without recording metadata
- **61% loop block rate** — loops blocked without structured reason
- **72 stale leases** — resources leaking due to missing cleanup
- **41% test coverage** — 97 services untested

The root cause is a single architectural gap: **failures are not recorded before exceptions are thrown**. This creates a cascade of invisible failures throughout the system.

## Goals / Non-Goals

**Goals:**
- Record structured failure metadata for 100% of maker failures
- Include block reasons for 100% of blocked loops
- Automate stale resource cleanup (target: 0 stale leases)
- Increase test coverage from 41% to >70%
- Integrate self-healing into background worker pipeline
- Monitor data quality continuously

**Non-Goals:**
- No God Class decomposition of LoopService (v9.0)
- No changes to external API contracts
- No new dependencies
- No production deployment

## Decisions

### D1 — Record-Then-Throw Pattern
**Decision**: All exception paths in executeMaker call `recordMakerFailure()` BEFORE throwing.
**Rationale**: Ensures metadata is always recorded, even if the exception propagates. The recording is best-effort (wrapped in try/catch) so it never masks the original error.
**Trade-off**: Slight overhead on failure path. Acceptable since failures should be rare in steady state.

### D2 — Background Worker for Cleanup
**Decision**: Add a `stale-resource-cleanup` worker to BackgroundWorkerService that runs every 30 minutes.
**Rationale**: Stale resources accumulate over time. Background cleanup is non-blocking and self-healing.
**Trade-off**: Requires careful tuning of thresholds (24h for prepared, 2h for running). Mitigated by making thresholds configurable via env vars.

### D3 — Structured Block Metadata
**Decision**: When gates fail, store structured metadata including gate names, evidence, and recommendations.
**Rationale**: Enables debugging, pattern analysis, and self-healing. Currently blocked loops are black boxes.
**Trade-off**: Slightly larger metadata JSON. Acceptable since blocked loops are infrequent.

### D4 — Test Generation Strategy
**Decision**: Generate test files for the 15 largest untested services using a template pattern.
**Rationale**: Manual test writing is slow. Generated tests provide baseline coverage that can be enhanced later.
**Trade-off**: Generated tests may be shallow. Acceptable as starting point — they can be deepened iteratively.

### D5 — Self-Healing Integration
**Decision**: Integrate SelfHealingService into the background worker pipeline rather than running it independently.
**Rationale**: Background workers already have scheduling, error handling, and observability infrastructure.
**None**: SelfHealingService becomes a worker that runs every 15 minutes.

## Architecture Changes

### Failure Recording Flow (Current → Fixed)
```
CURRENT (broken):
  executeMaker() → throws MAKER_WORKTREE_NOT_FOUND
                  → lease stays 'prepared'
                  → loop becomes 'blocked' with no reason
                  → operator has no debugging info

FIXED:
  executeMaker() → recordMakerFailure() → lease='failed' with metadata
                  → throws MAKER_WORKTREE_NOT_FOUND
                  → loop event emitted with failure details
                  → operator can diagnose from metadata
                  → pattern extractor can learn from failure
```

### Background Worker Pipeline (New)
```
BackgroundWorkerService
  ├── health-check (every 15 min) → SelfHealingService.checkHealth()
  ├── stale-resource-cleanup (every 30 min) → cancel stale leases
  ├── test-gap-detector (every 5 hours) → find untested services
  ├── memory-archival (every 10 hours) → archive expired memories
  ├── governance-recert (every 60 min) → re-run governance benchmark
  ├── worktree-cleanup (every 30 min) → prune orphaned worktrees
  ├── metrics-aggregation (every 5 min) → aggregate and store metrics
  └── orphan-lease-cleanup (every 15 min) → clean up stale worker leases
```

### Data Quality Monitoring
```
PredictiveAnalyticsService
  ├── checkDataQuality() → {
  │   ├── failureMetadataCompleteness: 0.0 → 1.0
  │   ├── blockReasonCompleteness: 0.0 → 1.0
  │   ├── staleLeaseCount: number
  │   └── overallScore: 0.0 → 1.0
  │ }
  └── emitAlertIfDegraded()
```

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| recordMakerFailure masks original error | Low | High | Wrapped in try/catch, best-effort only |
| Background worker cancels active leases | Low | Medium | 2h threshold + status check before cancel |
| Generated tests are too shallow | Medium | Low | Starting point, can be deepened later |
| Health check overhead | Low | Low | Read-only queries, cached results |
| Self-healing makes wrong decisions | Low | Medium | Conservative thresholds, human escalation |

## Data Model Changes

### worker_leases.metadata (enhanced)
```json
{
  "verdict": "insufficient_evidence",
  "exit_status": "MAKER_WORKTREE_NOT_FOUND",
  "failure_reason": "Worktree path does not exist",
  "failed_at": "2026-07-05T15:00:00Z",
  "auto_repaired": false
}
```

### loop_runs.metadata (enhanced)
```json
{
  "block_reason": "gate_failed:token_budget",
  "failed_gates": ["token_budget: runtime_usage=1000000 > max_tokens=500000"],
  "recommendations": ["Reduce token budget or increase max_tokens"],
  "blocked_at": "2026-07-05T15:00:00Z"
}
```
