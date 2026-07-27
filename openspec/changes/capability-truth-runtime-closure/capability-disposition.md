# Capability disposition

The runtime profiles prove the canonical integration paths:

- `api`: HTTP, authentication, WebSocket, execution, memory.
- `operator`: `api` plus PromptIntel, retention, cognitive loop closure, and the
  background worker.
- `autonomous`: `operator` plus negotiation, capability acquisition,
  meta-evolution, and meta-orchestration.

The 31 service modules with no production importer are not started merely to
increase a capability count. Their disposition is:

## Merge into an existing canonical path before use

- OpenMythos evaluation: `openmythos-eval-service-circuit-breaker`,
  `hallucination-detection-service`,
  `value-alignment-service`, `contradiction-detection-service`,
  `overthinking-detection-service`, `cross-lingual-service`,
  `temporal-reasoning-service`, and `calibration-service`.
- Governance analysis: `governance-history-service`,
  `governance-agent-service`, `governance-enhancement-service`,
  `risk-prediction-service`, `early-warning-service`, `safety-service`, and
  `root-cause-analysis-service`.
- Capability evolution: `code-analysis-service`,
  `refactoring-proposal-service`, `capability-service`,
  and `swarm-capability-ops-service`.

These modules overlap reachable OpenMythos, governance, lifecycle, or
self-improvement services. They remain dormant until a behavior-level merge is
proved by a consumer and tests.

`openmythos-real-evaluator` and `claim-service` were retired in
`execution-attempt-runtime-closure`: both had no callers and duplicated
canonical, tested behavior.

## On-demand only

- `canary-deployment-service`
- `swarm-mission-service`
- `memory-evolution-scheduler`
- `memory-evolution-observability`
- `indexing-experiment-service`
- `federated-intelligence-service`
- `hypothesis-service`
- `pipeline-stage`
- `agent-adapters`

These are job, experiment, observability, or adapter building blocks. They must
be constructed by a concrete route or job, not at server startup.

## Retired after functional-closure approval

- `agent-lifecycle-service`: deleted after approval because it had no production
  importer and duplicated the reachable, tested `AgentRetirementService`.
- `emergent-specialization-service`: deleted after approval because no
  production path recorded performance, while its only route could merely read
  synthetic or manually seeded state.

## Runtime truth follow-up

Autonomous bootstrap no longer constructs and discards `RsiSafetyGuard`,
`ServiceRefactoringAnalyzer`, `EmergentSpecializationService`, `WorkerPool`,
or `OkfKnowledgeUpdater`. Constructors without invocation do not constitute an
active capability. The real callers remain on demand:

- OpenMythos owns its actual `WorkerPool`;
- the autonomous-cycle script invokes `OkfKnowledgeUpdater`;
- swarm routes invoke refactoring analysis and RSI status operations;
- ExpertSwarm is constructed when a dispatch or history request needs it.

`LoopRecoveryService` remains intentionally limited to interrupted process and
lease recovery. Content and patch quality stay in the existing
maker/checker/deterministic `LoopVerificationService` gates; the expert-answer
`JudgeService` is not reused across that incompatible boundary.
