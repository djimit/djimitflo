## Why

Self-improving runs against the production database (109 loops, 63 makers, 140 tables) identified 7 critical structural issues that degrade DjimFlo's reliability and prevent autonomous operation:

| Issue | Severity | Impact |
|-------|----------|--------|
| 84% maker failure rate | CRITICAL | 53/63 maker leases fail without recorded reason |
| 61% loop block rate | HIGH | 67/109 loops blocked without metadata explanation |
| 41% test coverage | MEDIUM | 97/165 services untested |
| 72 stale prepared leases | HIGH | Resources leaked, database bloat |
| 2 stuck running loops | MEDIUM | Hung processes consuming resources |
| Missing failure metadata | HIGH | Debugging impossible, patterns invisible |
| No automated cleanup | MEDIUM | Manual intervention required for routine maintenance |

**Root Cause Analysis:**
The `executeMaker` method in LoopService throws exceptions (MAKER_WORKTREE_NOT_FOUND, etc.) WITHOUT first recording failure details in the lease metadata. This means:
1. Leases remain in 'prepared' status even after failure
2. Loops become 'blocked' without any block reason
3. The 84% failure rate is invisible — no verdict, no exit_status, no failure_reason
4. Pattern analysis is impossible because failure data is missing

**Business Impact:**
- Autonomous loops cannot self-diagnose failures
- Human operators cannot debug blocked loops
- Resources leak (stale leases, orphaned worktrees)
- The platform cannot learn from failures (cognitive loop is starved of data)

## What Changes

### Change 1: Failure Metadata Recording (CRITICAL)
**File**: `packages/server/src/services/loop-service.ts`

Add `recordMakerFailure()` helper that is called BEFORE throwing any exception in `executeMaker`. This ensures:
- Lease status is updated to 'failed' with verdict='insufficient_evidence'
- Exit status is recorded (e.g., 'MAKER_WORKTREE_NOT_FOUND')
- Failure reason is stored in metadata
- Loop event is emitted for observability

### Change 2: Loop Block Reason Recording (HIGH)
**File**: `packages/server/src/services/loop-service.ts`

When gates fail and a loop is blocked, the metadata MUST include:
- Which gates failed (names + evidence)
- The specific failure reasons
- Timestamp of the block event
- Recommended next actions

### Change 3: Automated Stale Resource Cleanup (HIGH)
**File**: `packages/server/src/services/background-worker-service.ts`

Add a background worker that runs every 30 minutes:
- Cancel prepared leases older than 24 hours
- Mark running leases as failed after 2 hours of inactivity
- Flag orphaned worktrees for cleanup
- Archive loop events older than 30 days

### Change 4: Test Coverage for Untested Services (MEDIUM)
**File**: `packages/server/src/__tests__/`

Add test files for the 15 largest untested services (by LOC):
1. swarm-status-service.ts (1866 LOC)
2. cs-skill-swarm-harness-service.ts (872 LOC)
3. agent-assurance-service.ts (720 LOC)
4. nested-spawn-service.ts (642 LOC)
5. specialist-panel-service.ts (635 LOC)
6. export-service.ts (557 LOC)
7. backup-service.ts (549 LOC)
8. cognitive-loop-closure-service.ts (549 LOC)
9. repository-scanner.ts (480 LOC)
10. compliance-audit-service.ts (435 LOC)
11. memory-candidate-service.ts (422 LOC)
12. evidence-service.ts (408 LOC)
13. self-modification-pipeline.ts (407 LOC)
14. citation-research-service.ts (406 LOC)
15. fleet-mesh-service.ts (373 LOC)

### Change 5: Self-Healing Automation (MEDIUM)
**File**: `packages/server/src/services/background-worker-service.ts`

Integrate SelfHealingService into the background worker pipeline:
- Run health checks every 15 minutes
- Auto-fix issues where possible (cancel stale leases, mark failed)
- Emit events for issues requiring human intervention
- Track auto-fix success rate

### Change 6: Data Quality Monitoring (LOW)
**File**: `packages/server/src/services/predictive-analytics-service.ts`

Add data quality checks to the health monitoring:
- Percentage of failed leases with missing verdict
- Percentage of blocked loops with missing reason
- Stale lease count trend
- Alert when data quality degrades

## Capabilities

### New Capabilities
- `failure-metadata-recording`: All maker failures record structured metadata before exception
- `stale-resource-cleanup`: Automated background cleanup of stale leases and worktrees
- `self-healing-pipeline`: Integrated health checks with automated remediation
- `data-quality-monitoring`: Continuous monitoring of data completeness

### Modified Capabilities
- `execute-maker`: Now records failure metadata before throwing exceptions
- `loop-blocking`: Now includes structured block reasons in metadata
- `background-workers`: Extended with cleanup and healing workers

## Non-Goals

- No changes to external HTTP API contracts
- No new npm dependencies
- No production deployment (separate change)
- No changes to OpenMythos governance benchmark (already complete)
- No changes to Legal RuleOps UC-06 (already complete)
- No God Class decomposition of LoopService (deferred to v9.0)

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| **Maker failures with metadata** | 0% | 100% |
| **Blocked loops with reason** | 0% | 100% |
| **Stale prepared leases** | 38 | 0 |
| **Test coverage** | 41% | >70% |
| **Self-healing automation** | 0% | 80% |
| **Data quality score** | Unknown | >90% |
| **Tests passing** | 1414 | >1500 |

## Impact

- **Affected packages**: `@djimitflo/server` (primary)
- **New dependencies**: None
- **APIs**: No breaking changes. New background worker endpoints.
- **Risk**: Medium. Changes to executeMaker are high-traffic. Mitigated by: (1) failure recording is additive (doesn't change success path), (2) background workers are isolated, (3) tests validate all changes.
- **Rollback**: Git revert. All changes are additive or in isolated background workers.
