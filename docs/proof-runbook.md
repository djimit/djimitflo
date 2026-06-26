# Djimitflo Proof Run Runbook

## Pre-Conditions

- Server running on workstation (`npm run dev:server`)
- Dashboard running on MacBook (`npm run dev:dashboard`)
- Database migrated (`npm run build && npm run dev:server` auto-migrates)
- OpenSpec validates: `openspec validate complete-swarm-platform --strict`

## Step 1: Capture Pre-Run Zero-State

```bash
curl -s http://localhost:3001/api/swarms/intelligence/mission-control | jq '.swarm_truth'
```

Expected: `registry_agent_count > 0` but `running_leases: 0`, `prepared_leases: 0`.

```bash
curl -s http://localhost:3001/api/swarms/proof-runs/latest | jq '.'
```

Expected: `null` or `status: "no proof run yet"`.

## Step 2: Run Mock Proof Run

```bash
npm run swarm:proof
```

Or via API:
```bash
curl -s -X POST http://localhost:3001/api/swarms/proof-runs \
  -H 'Content-Type: application/json' \
  -d '{"runtime": "mock"}' | jq '.'
```

Expected output:
```json
{
  "id": "proof-...",
  "status": "completed",
  "runtime": "mock",
  "counts": {
    "capabilities": 6,
    "panels": 1,
    "claims": 3,
    "goals": 1,
    "loop_runs": 1,
    "worker_leases": 2,
    "trace_spans": 5,
    "checkpoints": 2,
    "manifests": 4,
    "memory_candidates": 1
  }
}
```

## Step 3: Verify Mission Control

```bash
curl -s http://localhost:3001/api/swarms/intelligence/mission-control | jq '.latest_proof_run'
```

Expected: nonzero proof run with all counts.

Open dashboard: http://localhost:5173 → Swarm Mission Control → Proof Run section.

## Step 4: Verify Evidence Graph

```bash
curl -s http://localhost:3001/api/swarms/intelligence/claims | jq '.claims[] | {id, status, subject_ref}'
```

Expected: ≥3 claims with `proposed`, `supported`, and `review_required` or `contradicted` statuses.

## Step 5: Rollback

```bash
npm run swarm:proof:rollback
```

Or via API:
```bash
curl -s -X POST http://localhost:3001/api/swarms/proof-runs/<proof-run-id>/rollback | jq '.'
```

Expected: all proof-scoped records deleted, production data untouched.

## Caveats

- **Ruflo is inspiration only** — not a runtime dependency
- **Registry is not execution** — agent count ≠ active workers
- **Mock proof precedes real runtime** — Codex/OpenCode smokes are optional follow-ups
- **No auto-merge/push/deploy** — all release actions are explicit operator commands
- **No automatic memory promotion** — all policy/security memory requires human review

## Go/No-Go Checklist for External Review

- [ ] Mock proof run creates nonzero output across all required tables
- [ ] Mission Control shows proof run with live counts vs required minimums
- [ ] Evidence graph has claims with typed statuses (proposed/supported/contradicted)
- [ ] Dashboard distinguishes registry count from active execution
- [ ] Rollback deletes only proof-scoped records
- [ ] No auto-merge/push/deploy/high-risk-unattended in the smoke
- [ ] `npm run test` exits 0
- [ ] `npm run type-check` exits 0
- [ ] `npm run lint` exits 0
- [ ] `openspec validate <change> --strict` exits 0 for all changes
