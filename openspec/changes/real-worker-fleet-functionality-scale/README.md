# Real Worker Fleet Functionality And Scale

This OpenSpec change captures the next work after the real Codex worker smoke: full worker fleet functionality, scale visibility and controlled throughput.

## Artifacts

- `proposal.md`: rationale, scope and success criteria from the real worker run.
- `design.md`: runtime contract harness, token-budget reduction, checker bridge, artifact isolation, warning gates, auto-verify closure, worker pools and fleet cockpit.
- `tasks.md`: Phase 12.1 through 12.12 implementation roadmap.
- `specs/runtime-worker-contracts/spec.md`: strict requirements for Codex/OpenCode contracts, artifacts, warnings and token efficiency.
- `specs/closed-loop-verification/spec.md`: strict requirements for checker execution, closure gates, dashboard flow and batch goals.
- `goals.batch.json`: ordered `/api/goals` payloads.
- `run-goals-batch.mjs`: safe batch runner for goal registration and optional decomposition.
- `runbook.md`: operator commands and safety notes.

## Safe Batch Command

```bash
export DJIMITFLO_API_BASE=http://127.0.0.1:3001/api
# Set DJIMITFLO_TOKEN in your shell from the authenticated operator session.
node openspec/changes/real-worker-fleet-functionality-scale/run-goals-batch.mjs --decompose
```

The batch does not start loops or spawn workers. Mutating loop actions remain behind the normal Djimitflo gates and future resource-aware capacity controls.
