# Proposal: Production Runtime Integration Certification

## Summary

Create OpenSpec change `production-runtime-integration-certification`.

Goal: move Djimitflo from a proven mock integration spine to a certified real production runtime path:

`real external event -> work_item -> goal -> loop -> codex/opencode maker -> codex/opencode checker -> eval -> reflection/memory candidate -> Mission Control production evidence`

This change does not add a new agent platform. It reuses:

- Integration inbox
- Work items
- Goals and loop runs
- Worker leases
- Resource-aware worker pool
- Runtime contracts
- Proof-run service
- Learning closure
- Mission Control Integration Spine

## Problem

The current Agentic OS run chain is proven with `mock`. That proves orchestration and evidence linking, but not production runtime execution.

The next claim must be stricter:

- non-mock runtime was selected intentionally
- runtime contract was checked before execution
- maker and checker executed as real child processes
- stdout/stderr, usage, gates, checkpoints and runner manifests were persisted
- close-loop created eval, reflection and memory candidate
- Mission Control shows production evidence without raw stdout inspection

## Scope

Implement one bounded certification path for `codex` and/or `opencode`.

1. Add real-runtime readiness checks.
2. Add opt-in real-runtime integration smoke.
3. Reuse existing scheduler and worker pool for maker/checker execution.
4. Certify production proof by eliminating `production_missing` for one bounded run.
5. Expose production certification state in Mission Control.
6. Capture evidence in OpenSpec.

## Non-Goals

- No auto-merge.
- No auto-deploy.
- No unattended high-risk execution.
- No automatic durable memory promotion.
- No new queue/orchestration framework.
- No new database table unless existing metadata cannot express the evidence.
- No replacement of the mock smoke; mock remains the fast deterministic CI proof.

## Core Decisions

- Real-runtime smoke is opt-in with `RUN_REAL_RUNTIME_SMOKE=1`.
- Default test suite remains deterministic and does not spawn real agents.
- Production certification requires `codex` or `opencode`, never `mock`.
- If runtime readiness fails, Djimitflo records blocked reasons and starts no worker.
- The first production run is low risk, bounded, local-repo only and operator-approved.
- Mission Control must distinguish mock proof from production runtime proof.

## Acceptance Criteria

- Existing mock run-chain proof still passes.
- Real-runtime readiness reports supported runtime, command, version/status and blocked reasons.
- Real-runtime smoke is skipped by default and runnable explicitly.
- One opt-in real-runtime smoke can execute maker/checker and close learning.
- Proof-run `production_missing` is empty for the certified run.
- Mission Control shows production certification status and next safe action.
- No memory is promoted automatically.
- All OpenSpec, server, dashboard, type-check, build and diff gates pass.
