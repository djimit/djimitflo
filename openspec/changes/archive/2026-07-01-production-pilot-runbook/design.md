# Design

## Shape

Keep this as a thin certification/readiness layer over the existing Agentic OS spine.

The pilot workflow is:

1. Select source event: GitHub issue, dashboard action or imported fixture.
2. Normalize into `work_items`.
3. Plan selected work item into goal and loop.
4. Prepare maker/checker leases with explicit runtime.
5. Start workers only through existing scheduler.
6. Run checker.
7. Close learning.
8. Read Mission Control chain truth.
9. Record pilot metrics.

## Pilot Runbook

The runbook should be executable by an operator:

- preflight runtime readiness
- choose a low-risk item
- import or select the item
- plan and prepare
- start/drain worker pool
- verify checker verdict
- close learning
- inspect Mission Control
- record metrics

Do not hide failures. The runbook should tell the operator where to stop when readiness, capacity, checker or close-loop gates fail.

## Metrics

Use existing state first.

Minimum metrics:

- `pilot_run_id`
- `source`
- `source_ref`
- `work_item_id`
- `goal_id`
- `loop_run_id`
- requested runtime
- effective runtime
- started_at/completed_at
- closure status
- checker verdict
- retry count
- manual intervention count
- eval score
- reflection candidate id
- memory candidate id
- next safe action

No new table for v1 unless existing metadata cannot represent the run id and links.

## Mission Control

Mission Control is the demo surface. It should show:

- latest pilot run chain
- production certification status
- pilot metrics summary
- next safe action

Fleet Cockpit remains runtime/pool truth. Mission Control remains OS-level chain truth.

## Boundaries

- Low-risk pilot items only.
- Real runtime execution is opt-in.
- Worker starts use the existing scheduler.
- Memory promotion remains explicit and approval-gated.
- Failed runs create evidence; they are not hidden.

## Removal Strategy

If pilot metrics later become part of general Mission Control history, remove any dedicated pilot read-model and keep the runbook plus tests.
