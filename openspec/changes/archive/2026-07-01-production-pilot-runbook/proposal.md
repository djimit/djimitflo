# Proposal: Production Pilot Runbook

## Summary

Create OpenSpec change `production-pilot-runbook`.

Goal: turn the certified real-runtime path into a repeatable, sellable operator workflow:

`real source event -> work_item -> goal -> loop -> codex/opencode maker -> checker -> eval -> reflection/memory candidate -> Mission Control evidence -> pilot metrics`

This is not another orchestration layer. Reuse:

- Integration Inbox
- Work items
- Goals and loop runs
- Worker leases and worker pool
- Runtime readiness
- Production proof certification
- Learning closure
- Mission Control Integration Spine

## Problem

Djimitflo can now prove that real Codex runtime execution works. The next product claim is different: an operator can run the same bounded workflow repeatedly on real backlog items and see whether outcomes improve.

The missing piece is a runbook-backed pilot that captures:

- source event identity
- selected work item
- requested and effective runtime
- maker/checker evidence
- close-loop result
- reflection/memory candidates
- production certification state
- success rate and intervention count across repeated runs

## Scope

1. Add a production pilot runbook.
2. Add a pilot metrics contract using existing DB state and evidence.
3. Add one operator-safe API/read-model if current Mission Control cannot expose pilot metrics.
4. Run three bounded low-risk pilot runs from real or imported backlog items.
5. Store evidence in OpenSpec.

## Non-Goals

- No new agent platform.
- No new queue framework.
- No automatic merge.
- No deploy.
- No unattended high-risk work.
- No automatic durable memory promotion.
- No broad dashboard rewrite.

## Acceptance Criteria

- Operator can follow one runbook without reading source code.
- Each pilot run links source event, work item, goal, loop, leases, checker verdict, eval and candidates.
- Pilot metrics report success rate, time to closure, checker rejection rate, memory/reflection candidate count and manual intervention count.
- Mission Control shows enough state to demo the flow without raw stdout.
- Three pilot runs produce comparable evidence.
- All validation gates pass.
