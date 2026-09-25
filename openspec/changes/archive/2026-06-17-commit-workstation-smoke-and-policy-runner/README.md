# Commit, Workstation Smoke And Policy Runner

This OpenSpec change is the execution plan after `real-worker-fleet-functionality-scale`.

It separates three gates:

1. Commit the validated control-plane/fleet work without accidentally staging unrelated env drift.
2. Prove the committed code live on the workstation with real dashboard/API surfaces.
3. Prove real Codex/OpenCode worker execution, then build the policy-gated worker pool runner.

The plan is intentionally sequential. The runner is not built until commit hygiene and live runtime evidence are proven.

## Safe Batch Command

```bash
export DJIMITFLO_API_BASE=http://127.0.0.1:3001/api
# Set DJIMITFLO_TOKEN in your shell from the authenticated operator session.
node openspec/changes/commit-workstation-smoke-and-policy-runner/run-goals-batch.mjs --decompose
```

The batch creates `/goals`; it does not commit, restart services, spawn workers, merge, push or deploy.
