# Production Pilot Runbook

## Preflight

1. Check runtime readiness for `codex` or `opencode`.
2. Stop if readiness is blocked.
3. Pick one low-risk work item or import one source event.
4. Confirm no deploy, merge or durable memory promotion is part of the run.

## Run

1. Import/select the source event into `work_items`.
2. Plan the selected item into goal and loop.
3. Prepare maker/checker leases with explicit runtime.
4. Confirm planning did not start workers.
5. Start/drain through the existing worker pool.
6. Run checker.
7. Stop on checker rejection unless the operator explicitly retries.

## Learn

1. Close the loop.
2. Confirm eval/reflection candidate exists.
3. Confirm memory remains candidate-only unless separately approved.
4. Record evidence ids.

## Demo

1. Open Mission Control.
2. Show source event, work item, goal, loop, leases, checker, closure and certification.
3. Record pilot metrics.

## Stop Conditions

- Runtime readiness blocked.
- Scheduler capacity blocked.
- Maker fails without useful evidence.
- Checker rejects and no retry is approved.
- Close-loop blocks on missing evidence.
- Any high-risk action is required.
