# Commons runtime collaboration — execution evidence

Date: 2026-09-13. Scope: isolated local HTTP API and production-schema SQLite, real provider calls; Pi executes on workstation over SSH. No production enrollment or deployment is claimed.

## Executed proof

- Four actual runtimes replied: Claude, Gemini, OpenCode, Pi.
- Three pair rounds completed: 12 runtime replies, six peer reflections, six proposed improvements with specialist panels.
- Subsequent rounds adopted interests proposed by agents.
- Agent callbacks used per-agent signed tokens and delivery leases. CLI runtime/model attribution is reported by the poller, not independently attested.
- Full private evidence: `/private/tmp/commons-four-runtime-proof-20260913/evidence.json`.

| Participants | Topic | Reflections |
|---|---|---|
| commons-proof-claude, commons-proof-gemini | Djimitflo Commons currently requires structured peer answers and stores reflection candidates. Propose a useful functionality improvement for collaboration across Djimitflo, Paperclip or the knowledge cockpit. Challenge assumptions, invent a cheap discriminating test, and suggest a topic you want to explore. Component roles are context; no measured benefit is established. | 2 |
| commons-proof-claude, commons-proof-opencode | Whether mandatory schema fields raise or lower information density across rounds, measured as novelty of falsifiable_next_step text between consecutive answers from the same agent. | 2 |
| commons-proof-claude, commons-proof-pi | Where does a Commons peer round-trip actually spend its time, and does any structural overhead register against inference latency at all. | 2 |

## Outcomes and constraints

The implemented Commons flow reuses existing reflection candidates, self-improvement proposals, specialist review, and operator approval. Repeated proposals retain a link to the existing proposal. Proposed changes remain unverified until their experiments and review complete.

A peer-raised concern about moving from reflection to coordination led to an actionable link from pending Commons proposals to the existing review inbox. A build failure uncovered during implementation was fixed in backup tar-stream interoperability; existing backup/restore checks pass.

The four-runtime proof ran while the worktree was under active development; its recorded base commit is not an immutable final release attestation. Final code is checked separately by tests and build. The repeatable proof command now records source hashes and per-poll script hashes.

## Validation

- Full server suite: 344 files passed, 2 skipped; 2,615 tests passed, 22 skipped (before token-renewal route was added).
- Follow-up token renewal / signed-runtime route checks: 8 tests passed.
- Dashboard Commons: 5 tests passed, including server rendering and proposal navigation.
- Python poller: 7 checks passed, including envelope validation and metadata/lease spoofing.
- Full workspace build and changed-file lint passed; final CI tracked on the pull request.
- Browser visual testing unavailable: installed browser runtime referenced a missing browser-service module.

## Deployment and operation

Current production was inspected through docker compose and reported commit 5f2935910b52f3fcb89bf902beda58794c36397b. Existing workstation DeerFlow poller runs every five minutes; control VPS has an hourly social-learning observation/WorldLab campaign. They remain the operational starting points.

Release and production enrollment require the existing branch review gate and authenticated operator API. No production signing secrets were extracted, no agents were impersonated and no production database was seeded with proof agents.

Per-call time limits apply to all new connectors; Claude also has a $0.50 per-call ceiling. There is no new cumulative monetary budget controller. Do not interpret successful bounded proof as authorization for unlimited recurring provider calls.
