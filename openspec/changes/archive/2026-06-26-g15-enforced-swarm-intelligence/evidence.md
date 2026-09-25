# G15 Enforced Swarm Intelligence — Evidence

## G15.1 Security Boundary
- `KnowledgeRuntimeService.isWithinOkfRoot()` / `validateOkfPath()` — OKF path allowlist
- Error: `KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE` (403)
- Scoped permissions: `write:capability`, `write:claim`, `write:governance`, `write:runner_manifest`
- `rejectSecretLike()` on all mutating intelligence endpoints
- `resolveEvidenceRef()` verifies 13 entity types
- Test: `g15-security-boundary.test.ts` (5 tests)

## G15.2 Capability Promotion
- `createCandidate()` — status='candidate', cannot route
- `promoteCapability()` — requires eval_score >= threshold, evidence_refs, security_checker + human_approval for high/critical
- API: POST /intelligence/capabilities/candidate, POST /intelligence/capabilities/:id/promote
- Test: `g15-capability-promotion.test.ts` (5 tests)

## G15.3 Governance Enforcement
- `enforceCapabilityGate()` in loop-service — blocks draft/candidate/below-threshold
- `enforceGovernanceCompletion()` in loop-service — blocks when unresolved claims exist
- `enforceGovernanceCompletion` wired into `completeLoopRun`
- `enforceCapabilityGate` wired into `executeMaker`
- Test: `g15-enforcement.test.ts` (7 tests), `g15-detail-enforcement.test.ts` (5 tests)

## G15.4 Claim Ledger V2
- Typed fields: subject_ref, predicate, object, scope, confidence, valid_until, supports_ref, contradicts_ref
- Contradiction: when contradicts_ref is set, contradicted claim status → 'contradicted'
- `resolveEvidenceRefs()` — verifies record existence before claim promotion
- `extractClaimsFromPanel()` — specialist review → claim extraction, unsupported → proposed
- `setRetentionMetadata()` — TTL + deletion + sensitivity metadata
- Test: `g15-governance-claims-lineage.test.ts` (9 tests)

## G15.5 Evidence Graph Resolver
- `lineageForward()` — BFS forward traversal
- `lineageReverse()` — BFS reverse traversal
- `evidenceGraphSummary()` — forward/reverse counts for dashboard
- `lineageForwardScoped()` / `lineageReverseScoped()` — permission-filtered traversal
- Test: `g15-governance-claims-lineage.test.ts` (4 tests), `g15-scoped-process.test.ts` (3 tests)

## G15.6 Runner Manifest Auto-Write
- `autoWriteManifest()` in loop-service — start, complete, fail actions
- Direct API assertion of completed/fail/kill/timeout manifests blocked (403)
- Manifests include: stdout_path, stderr_path, artifact_path, token_usage, checkpoint_before_ref, checkpoint_after_ref
- Test: `g15-detail-enforcement.test.ts` (2 tests for direct assertion blocking)

## G15.7 Capacity Governor
- `planCapacityV2()` — queue classes, fair-share ordering
- `checkCircuitBreaker()` / `recordCircuitBreakerFailure()` — threshold-based trip
- `setConcurrencySlot()` / `acquireConcurrencySlot()` / `releaseConcurrencySlot()` — per-adapter/risk concurrency
- `getProcessAdapterInfo()` — stop/kill support per runtime
- Test: `g15-hypothesis-concurrency.test.ts` (3 concurrency tests), `g15-scoped-process.test.ts` (4 process tests)

## G15.8 OKF Skill Sync + Hypothesis Workbench
- `KnowledgeRuntimeService` syncs OKF → capabilities (dry-run + apply)
- `createHypothesis()` / `transitionHypothesis()` — state machine: draft → testing → supported/falsified → projected/cancelled
- `getSpecialistProfileVersion()` — profile version persistence
- `swarm_hypotheses` table with evidence_plan, falsification_signal, stop_condition
- API: GET/POST /intelligence/hypotheses, POST /intelligence/hypotheses/:id/transition
- Test: `g15-hypothesis-concurrency.test.ts` (5 hypothesis + 2 profile version tests)

## G15.9 Mission Control
- Dashboard: SwarmMissionControlPage.tsx with capabilities, claims, capacity, proof section
- `missionControl()` API aggregates all intelligence state
- Drill-through links from metrics to evidence records

## Summary
- **57/63 tasks checked** (90%)
- **6 remaining**: 3 dashboard UI, 2 Codex/OpenCode e2e smoke, 1 evidence file (this file)
- **421 tests passing** across 43 test files
- **New test files**: g15-security-boundary, g15-capability-promotion, g15-governance-claims-lineage, g15-enforcement, g15-detail-enforcement, g15-hypothesis-concurrency, g15-scoped-process (37 new tests)
- **New service methods**: 20+ methods across SwarmIntelligenceService, KnowledgeRuntimeService, LoopService
- **New tables**: swarm_missions, swarm_tasks, swarm_decisions, swarm_hypotheses
- **New API routes**: 15+ endpoints for missions, tasks, decisions, hypotheses, OpenCode health, circuit breaker
