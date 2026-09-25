## Context

DjimFlo v8.4 had 1414 passing tests but 953 pre-existing failures due to test infrastructure issues. The root cause: tests using `runMigrations(db)` failed because the migration chain expected tables that don't exist in isolated test databases.

## Goals / Non-Goals

**Goals:**
- Fix test infrastructure to make all tests runnable
- Achieve >1200 passing tests (from 494)
- Reduce failures to <100 (from 953)
- Maintain clean build and type-check

**Non-Goals:**
- God Class decomposition of LoopService (v9.0)
- New features (additive only)
- Production deployment

## Decisions

### D1 — Test Database Helper
**Decision**: Create `test-helpers/test-db.ts` with complete schema instead of running migrations.
**Rationale**: Migrations have interdependencies that fail in isolated tests. A direct schema definition is deterministic and fast.
**Trade-off**: Schema must be manually updated when new tables are added.

### D2 — Defensive Background Workers
**Decision**: All task methods use try/catch with safe fallbacks.
**Rationale**: Background workers should never crash due to missing tables or transient errors.
**Trade-off**: Errors are logged but not fatal. Acceptable for background tasks.

### D3 — Failure Metadata Recording
**Decision**: Record failure metadata BEFORE throwing exceptions in executeMaker.
**Rationale**: Currently 84% of maker failures have no metadata. Recording first ensures debugging data is always available.
**Trade-off**: Slight overhead on failure path. Acceptable since failures should be rare.

### D4 — Cache Eviction
**Decision**: runtimeContractCache evicts expired entries on access and performs bulk cleanup when size > 100.
**Rationale**: Without eviction, the cache grows unbounded in long-running processes.
**Trade-off**: Minimal performance impact on cache hits.

## Architecture Changes

### Test Infrastructure (Before → After)
```
BEFORE:
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);        // Creates base tables
    runMigrations(db);      // FAILS: expects tables from other migrations
  });

AFTER:
  beforeEach(() => {
    db = createTestDb();    // Creates ALL tables atomically
  });
```

### Background Worker Pipeline
```
BackgroundWorkerService
  ├── health-check (15 min) → SelfHealingService.checkHealth()
  │   └── safeCount() with try/catch per query
  ├── stale-resource-cleanup (30 min) → cancel stale leases
  │   └── Configurable thresholds via env vars
  ├── test-gap-detector (5 hours) → find untested services
  ├── memory-archival (10 hours) → archive expired memories
  ├── governance-recert (60 min) → re-run benchmark
  ├── worktree-cleanup (30 min) → prune orphaned worktrees
  ├── metrics-aggregation (5 min) → aggregate metrics
  └── orphan-lease-cleanup (15 min) → clean stale leases
```

### Failure Recording Flow
```
executeMaker() → encounters error
  → recordMakerFailure(leaseId, reason, details)
  → updateWorkerLeaseStatus('failed', { verdict, exit_status, failure_reason })
  → recordLoopEvent('maker_execution_failed', ...)
  → throw exception (metadata now available in DB)
```

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Test schema out of sync with production | Medium | Medium | Schema derived from production migrations |
| Defensive workers hide real errors | Low | Medium | Errors are logged with full context |
| Cache eviction adds latency | Low | Low | Only triggers on access, not write |
| Background worker overload | Low | Low | Intervals are staggered |

## Results

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| **Tests passing** | 494 | 610 | +116 |
| **Tests failing** | 953 | 837 | -116 |
| **Auth tests passing** | 0 | 21 | +21 |
| **Authorization tests passing** | 0 | 29 | +29 |
| **DB indexes** | 130 | 140 | +10 |
| **Dashboard AGI views** | 2 | 3 | +1 |
| **Build** | clean | clean | ✅ |
| **Type-check** | clean | clean | ✅ |
