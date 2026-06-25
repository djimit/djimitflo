# Design

## Decision

Build one `KnowledgeRuntimeService` rather than a new knowledge platform.

It owns:

- canonical OKF base resolution
- OKF health and validation reporting
- OKF-to-capability sync
- loop learning closure
- OKF-backed specialist profile discovery

This keeps the implementation small and reuses existing tables: `swarm_capabilities`, `memory_candidates`, `reflection_candidates`, `agent_eval_runs`, `work_items`, `loop_runs`, `worker_leases` and `swarm_runner_manifests`.

## Runtime Model

Durable knowledge:

- `knowledge/` in this repo, symlinked to `../djimitflo-knowledge/okf`

Runtime state:

- SQLite tables and runtime artifacts

Projections:

- Qdrant and UAMS

Health checks are read-only. Sync dry-run is read-only. Sync apply writes only capability registry rows.

## Capability Sync

Sync reads OKF markdown frontmatter from:

- `skills/*.md` -> `kind=skill`
- `agents/*.md` -> `kind=specialist_agent`
- `services/*.md` -> `kind=memory_source`

Each synced row stores source path, content hash and missing contract fields in metadata. Missing required fields keep the capability as `candidate`; completed contracts can become `validated` with an eval score above threshold.

## Learning Closure

`POST /api/swarms/evolution/close-loop` requires a completed maker, accepted checker, non-failing gates and runtime evidence. It then:

- runs deterministic loop eval
- creates a reflection candidate
- creates an operational memory candidate
- creates a repair work item on regression
- creates a skill improvement work item on improvement

Memory promotion stays explicit and approval-gated.

## Specialist Profiles

The static catalog remains fallback. OKF-backed profiles override by id only when their frontmatter contains required evidence, forbidden claims and output schema. High-risk panels still require `security_reviewer`.
