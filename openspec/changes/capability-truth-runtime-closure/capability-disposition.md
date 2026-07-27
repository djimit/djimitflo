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

- OpenMythos evaluation: `openmythos-real-evaluator`,
  `openmythos-eval-service-circuit-breaker`, `hallucination-detection-service`,
  `value-alignment-service`, `contradiction-detection-service`,
  `overthinking-detection-service`, `cross-lingual-service`,
  `temporal-reasoning-service`, and `calibration-service`.
- Governance analysis: `governance-history-service`,
  `governance-agent-service`, `governance-enhancement-service`,
  `risk-prediction-service`, `early-warning-service`, `claim-service`,
  `safety-service`, and `root-cause-analysis-service`.
- Capability evolution: `code-analysis-service`,
  `refactoring-proposal-service`, `capability-service`,
  `swarm-capability-ops-service`, and `agent-lifecycle-service`.

These modules overlap reachable OpenMythos, governance, lifecycle, or
self-improvement services. They remain dormant until a behavior-level merge is
proved by a consumer and tests.

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

## Retire

No module is deleted in this change. Static non-reachability is insufficient
evidence for destructive retirement; final retirement remains a human gate.
