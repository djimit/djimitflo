# Implementation Tasks — DjimFlo v8.2 Structural Improvements

## Phase 1: Failure Metadata Recording (CRITICAL, 3u)

- [ ] 1.1 Add `recordMakerFailure()` helper to LoopService (already done in v8.1, verify)
- [ ] 1.2 Add recordMakerFailure call before ALL exception throws in executeMaker
- [ ] 1.3 Add structured block reason recording when gates fail in verifyLoopRun
- [ ] 1.4 Write tests for recordMakerFailure (all exception paths)
- [ ] 1.5 Write tests for block reason recording
- [ ] 1.6 Validate: run full test suite, 0 regressions

## Phase 2: Stale Resource Cleanup (HIGH, 4u)

- [ ] 2.1 Add `stale-resource-cleanup` worker to BackgroundWorkerService
- [ ] 2.2 Implement cancel stale prepared leases (>24h) logic
- [ ] 2.3 Implement mark hung running leases as failed (>2h) logic
- [ ] 2.4 Add configurable thresholds via environment variables
- [ ] 2.5 Add cleanup result logging and event emission
- [ ] 2.6 Write tests for stale cleanup worker
- [ ] 2.7 Validate: run full test suite, 0 regressions

## Phase 3: Self-Healing Pipeline (MEDIUM, 3u)

- [ ] 3.1 Integrate SelfHealingService into BackgroundWorkerService pipeline
- [ ] 3.2 Add health check worker (every 15 min)
- [ ] 3.3 Add auto-fix attempt for known issues
- [ ] 3.4 Add escalation for unfixable issues
- [ ] 3.5 Store health check results for trending
- [ ] 3.6 Write tests for self-healing pipeline integration
- [ ] 3.7 Validate: run full test suite, 0 regressions

## Phase 4: Data Quality Monitoring (LOW, 2u)

- [ ] 4.1 Add data quality checks to PredictiveAnalyticsService
- [ ] 4.2 Add failure metadata completeness metric
- [ ] 4.3 Add block reason completeness metric
- [ ] 4.4 Add GET /api/intelligence/data-quality endpoint
- [ ] 4.5 Write tests for data quality monitoring
- [ ] 4.6 Validate: run full test suite, 0 regressions

## Phase 5: Test Coverage Expansion (MEDIUM, 6u)

- [ ] 5.1 Generate test file for swarm-status-service.ts (1866 LOC)
- [ ] 5.2 Generate test file for cs-skill-swarm-harness-service.ts (872 LOC)
- [ ] 5.3 Generate test file for agent-assurance-service.ts (720 LOC)
- [ ] 5.4 Generate test file for nested-spawn-service.ts (642 LOC)
- [ ] 5.5 Generate test file for specialist-panel-service.ts (635 LOC)
- [ ] 5.6 Generate test file for export-service.ts (557 LOC)
- [ ] 5.7 Generate test file for backup-service.ts (549 LOC)
- [ ] 5.8 Generate test file for cognitive-loop-closure-service.ts (549 LOC)
- [ ] 5.9 Generate test file for repository-scanner.ts (480 LOC)
- [ ] 5.10 Generate test file for compliance-audit-service.ts (435 LOC)
- [ ] 5.11 Generate test file for remaining 5 untested services >400 LOC
- [ ] 5.12 Validate: run full test suite, >1500 tests, 0 regressions

## Validation & Ship Gate

- [ ] V.1 Run `npm run type-check` — clean
- [ ] V.2 Run `npm run lint` — clean
- [ ] V.3 Run `npm run build` — clean
- [ ] V.4 Run `npx vitest run` — >1500 tests, 0 new failures
- [ ] V.5 Verify all maker failures record metadata
- [ ] V.6 Verify all blocked loops include structured reasons
- [ ] V.7 Verify stale lease count = 0 after cleanup
- [ ] V.8 Verify self-healing pipeline runs automatically
- [ ] V.9 Generate release notes
- [ ] V.10 Tag v8.2.0 and push
