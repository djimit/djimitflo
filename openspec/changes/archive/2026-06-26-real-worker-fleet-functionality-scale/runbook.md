# Runbook

## Purpose

Register the Phase 12 functionality and scale work as ordered Djimitflo `/goals` in one operator action. This only creates goals and optionally decomposes them. It does not start loops, continue leases or spawn workers.

## Dry Run

```bash
node openspec/changes/real-worker-fleet-functionality-scale/run-goals-batch.mjs --dry-run
```

## Create Goals

```bash
export DJIMITFLO_API_BASE=http://127.0.0.1:3001/api
# Set DJIMITFLO_TOKEN in your shell from the authenticated operator session.
node openspec/changes/real-worker-fleet-functionality-scale/run-goals-batch.mjs
```

## Create And Decompose Goals

```bash
export DJIMITFLO_API_BASE=http://127.0.0.1:3001/api
# Set DJIMITFLO_TOKEN in your shell from the authenticated operator session.
node openspec/changes/real-worker-fleet-functionality-scale/run-goals-batch.mjs --decompose
```

## Safety

- `auto_spawn_workers` remains false.
- Every mutating loop `continue`, maker execution, checker execution, merge, push or deploy still requires the normal Djimitflo gates.
- Do not paste credentials into the batch file. Use environment variables for the operator token.
