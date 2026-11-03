# G16 Proof Run Runbook

## Purpose

Show that Djimitflo can produce real, inspectable swarm output on the workstation. The run is successful only when live DB counts, authenticated API output and Mission Control agree. The mock proof path is allowed to auto-start and create rollback-scoped demo records.

## Preflight

Run:

```sh
npm run type-check --workspace=@djimitflo/server
npm run type-check --workspace=@djimitflo/dashboard
npm test --workspace=@djimitflo/server -- src/__tests__/swarm-intelligence-service.test.ts src/__tests__/swarm-resource-plan.test.ts
openspec validate g16-no-theater-swarm-proof --strict
```

Capture current live counts:

```sh
node scripts/swarm-proof-counts.mjs
```

Expected starting evidence may include existing registry agents, but the proof must explicitly report counts for goals, loop runs, leases, capabilities, claims, manifests and panels.

## Mock Proof

Run:

```sh
npm run swarm:proof -- --runtime=mock
```

Required output shape:

```json
{
  "proof_run_id": "proof_...",
  "status": "passed",
  "runtime": "mock",
  "counts": {
    "goals": 1,
    "loop_runs": 1,
    "worker_leases": 2,
    "swarm_capabilities": 6,
    "swarm_claims": 3,
    "swarm_runner_manifests": 4,
    "specialist_panels": 1,
    "specialist_reviews": 3,
    "work_items": 1,
    "memory_candidates": 1,
    "agent_trace_spans": 4,
    "loop_checkpoints": 2
  },
  "missing_evidence": []
}
```

## API Proof

Run an authenticated request:

```sh
curl -sS -H "Authorization: Bearer $DJIMITFLO_TOKEN" \
  http://127.0.0.1:3001/api/swarms/proof-runs/$PROOF_RUN_ID
```

The response must include proof run id, status, counts, evidence refs and rollback group.

## Mission Control Proof

Open Mission Control and verify:

- proof run id is visible
- live counts match API
- active execution is separate from registry agents
- missing evidence is empty for a passed proof
- rollback action or command is visible

## Real Runtime Smokes

Only after mock proof passes:

```sh
npm run swarm:proof -- --runtime=codex
npm run swarm:proof -- --runtime=opencode
```

If a runtime is unavailable, the output must be `blocked` with runtime contract evidence.

## Rollback

Run:

```sh
npm run swarm:proof:rollback -- --proof-run-id=$PROOF_RUN_ID
```

Rollback must delete only records marked with the proof run rollback group and demo-record marker. It must not touch unrelated user work, production records, memory, approvals or audit logs.

## Go/No-Go

Go:

- Mock proof passed.
- Dashboard and API counts agree.
- Rollback proved scoped cleanup.
- Codex/OpenCode smokes passed or blocked with exact reasons.

No-go:

- Any proof record lacks rollback group.
- Any policy memory is promoted through the operational demo-memory path.
- Any release action such as merge, push or deploy occurs without an explicit operator command.
- Dashboard claims active execution from registry rows or prepared leases.
