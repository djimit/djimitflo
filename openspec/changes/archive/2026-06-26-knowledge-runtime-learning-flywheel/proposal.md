# Knowledge Runtime Learning Flywheel

## Why

Djimitflo now has real worker leases, runtime contracts, checker gates, proof runs, memory candidates and evolution scoring. The remaining gap is that durable knowledge is still split across a canonical `djimitflo-knowledge/okf` bundle, local `packages/knowledge` skill drafts and runtime DB state. That makes skills, specialist agents and memory useful, but not yet a single production learning loop.

This change makes `djimitflo-knowledge/okf` the canonical durable knowledge source and treats SQLite as runtime state. Qdrant and UAMS remain projections that can be rebuilt from OKF and DB evidence.

## What Changes

- Add a `KnowledgeRuntimeService` that resolves one canonical OKF root, reports health and blocks ambiguous `packages/knowledge` production fallback.
- Add OKF capability sync from skills, agents and services into existing `swarm_capabilities`.
- Add a close-loop learning endpoint that turns a verified loop run into eval, reflection, memory candidate and follow-up work.
- Allow validated OKF-backed specialist profiles to override static fallback profiles.
- Add Mission Control visibility for OKF health, capability sync drift and loop learning closure.

## Guardrails

- No auto-merge, push or deploy.
- No unattended high-risk execution.
- No automatic policy, security or autonomy memory promotion.
- No new canonical store besides OKF files and SQLite runtime state.
- No Qdrant or UAMS writes from health or dry-run sync.

## Success Criteria

- OpenSpec validates strictly.
- `OKF_BASE` absent resolves repo `knowledge/` symlink, not `packages/knowledge`.
- OKF health is visible through API and dashboard.
- Capability sync dry-run performs zero writes.
- Capability sync apply upserts only `swarm_capabilities`.
- Completed loop closure creates eval, reflection and memory candidate.
- Regression creates a follow-up work item.
- Candidate/draft/below-threshold capabilities cannot route live workers.
