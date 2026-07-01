# Proposal: Agentic OS Run Chain Proof

## Summary

Create OpenSpec change `agentic-os-run-chain-proof`.

Goal: finish the next functional Agentic OS slice by proving that an imported integration work item can become a deterministic, operator-controlled production run chain:

`integration event -> work_item -> goal -> loop -> maker/checker leases -> scheduler -> worker/checker evidence -> learning closure -> Mission Control truth`

This change does not create a new agent platform. It completes the open execution phases of `agentic-os-integration-spine` and fixes the current scheduler/runtime contract drift exposed by `swarm-resource-plan.test.ts`.

## Problem

Djimitflo already has the pieces:

- canonical integration inbox over `work_items`
- capability-gated connectors
- goals, loop runs and worker leases
- resource-aware worker pool scheduler
- checker and gate evidence
- learning closure with eval, reflection and memory candidates
- Mission Control and Fleet Cockpit

The missing product-level proof is the linked chain. Today the system can show strong modules, but the operator cannot yet prove one imported event moved through the full OS path without reading raw logs or stitching records manually.

The immediate engineering blocker is scheduler contract drift:

- old worker-resource tests expect deterministic `mock` runtime
- current planning can select `codex`
- downstream worker-pool smoke then sees no eligible starts
- high-risk checker/maker ordering assertions no longer match current decision order

## Scope

Implement the smallest run-chain proof that holds:

1. Reconcile runtime selection contract.
2. Plan and prepare an integration-origin work item into goal, loop and maker/checker leases.
3. Prove workers start only through the existing scheduler.
4. Prove maker/checker evidence links back to source work item.
5. Close the loop through existing learning closure.
6. Render the linked chain and next safe action in Mission Control.
7. Add one deterministic mock-runtime smoke that fails if the chain breaks.

## Non-Goals

- No new orchestration engine.
- No new integration task table.
- No new database table unless an existing table cannot represent the evidence link.
- No auto-merge, auto-deploy or unattended high-risk execution.
- No automatic OKF memory promotion.
- No broad dashboard redesign.
- No new dependency for markdown, queues, workflow graphs or state machines.

## Core Decisions

- `work_items` remains the integration inbox.
- Existing goal, loop and worker lease records remain the execution chain.
- Explicit operator/runtime selection wins for deterministic smoke and manual execution.
- Adaptive runtime selection applies only when no explicit runtime is requested.
- Worker starts stay behind the existing resource-aware scheduler.
- Mission Control shows OS chain truth; Fleet Cockpit remains pool/runtime truth.

## Acceptance Criteria

- `swarm-resource-plan.test.ts` passes with the intended runtime contract.
- A selected integration-origin work item prepares goal, loop and maker/checker leases without starting workers.
- The worker pool can drain an eligible low-risk integration run and persist maker/checker evidence.
- Learning closure creates eval and reflection, plus memory candidate only when reusable.
- Regression creates a repair work item.
- Mission Control shows source event through learning closure and next safe action.
- `openspec validate agentic-os-run-chain-proof --strict` passes.
