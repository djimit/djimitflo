# F. Observability and diagnostic journey analysis

## Current evidence surfaces

- Cockpit: health, guardrails, services, stalls, deploys, throughput, resource use and worker/species state.
- Observability: risk assessments, policy decisions, recent errors and SSE event feed.
- Audit: audited domain events and logs.
- Authority: who/what authorized a decision.
- Task/run/proof details: execution-specific events and evidence.
- Usage: provider/consumer volume and last failures.
- Decisions: PR settlement, requeues and human labels.

These are useful primitives but they are page-centric rather than investigation-centric.

## Correlation coverage

The schema contains `run_id`, `goal_id`, `panel_id`, proposal/improvement IDs, task IDs, experiment IDs, provider/model, policy/audit events and agent trace spans. Coverage is uneven: there is no universal trace spine linking proposal → panel → goal → loop run → task/lease → model/tool calls → artifact/PR → deployment → verification/survival. Existing identifiers should be propagated before inventing a new logging product.

| Operator question | Current answerability | Missing link |
|---|---|---|
| What happened? | Usually | One chronological entity timeline |
| Why? | Sometimes | Decision reason, policy version and evidence beside outcome |
| Responsible component? | Sometimes | Runtime/agent/provider attribution normalized across events |
| Supporting evidence? | Fragmented | Direct evidence links from decision and status rows |
| Before and after? | Weak | Immutable transitions rather than mutable current rows |
| What next? | Inconsistent | Recovery action/owner/SLA on degraded states |
| Reproducible? | Rare | Artifact SHA, config snapshot, model/prompt version and inputs |

## Required contextual drill-down

Add one reusable `ContextTrail`/entity-links component and one backend resolver over existing IDs. Starting from any goal, run, task, proposal, panel, experiment, PR or integration, show:

1. identity and current state with freshness;
2. parent/origin and downstream children;
3. ordered immutable transitions;
4. decisions/policies with actor and version;
5. executions, tool/model calls and resource use;
6. evidence/artifacts and deployment identity;
7. failure/retry/recovery events;
8. next safe action.

This is a navigation/query composition feature, not another log store.

## Runtime evidence

The running container was `healthy`, restart count 0, exact image `main-be0b3ab`, with deploy `done` and later `verdict_ok`. These prove process/deploy health, not platform correctness. Logs repeatedly emitted the memory-holdout stall and showed ordinary public probing plus a request-aborted error. Asset 404s and the persistent module-import error explain the observed Federation failure. Public scanner requests to WordPress-looking paths received the SPA shell (HTTP 200); this is not compromise evidence, but access logs should distinguish SPA fallback from a real resource success to reduce misleading telemetry.
