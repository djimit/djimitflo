# Proof Contract

## Minimum Passing Counts

The mock proof run must create at least:

| Record | Minimum |
| --- | ---: |
| goals | 1 |
| loop_runs | 1 |
| worker_leases | 2 |
| swarm_capabilities | 6 |
| swarm_claims | 3 |
| swarm_runner_manifests | 4 |
| specialist_panels | 1 |
| specialist_reviews | 3 |
| work_items | 1 |
| memory_candidates | 1 |
| agent_trace_spans | 4 |
| loop_checkpoints | 2 |

## Required Evidence

- Pre-run counts.
- Post-run counts.
- Proof-run id.
- Rollback group.
- Authenticated API response.
- Mission Control proof section.
- stdout/stderr refs for worker execution.
- Trace span refs.
- Checkpoint refs.
- Runner manifest refs.
- Memory candidate id and promotion status.

## Non-Theater Rules

- A registry agent is not a worker.
- A prepared lease is not active execution.
- A plan is not a run.
- A test harness pass is not live workstation output.
- A runtime-unavailable result is acceptable only when it is explicit and evidenced.
- A proof run is not sellable until rollback is proven.
