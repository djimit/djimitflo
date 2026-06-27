# Design — Self-Learning Swarm Maturation

## Context

The verified baseline (see `evidence.md`) is a single-runtime (codex), 2-specialist,
vector-only learning swarm. Maturation targets: deterministic green, wiki knowledge
growth, skills, multi-runtime, scale, and memory quality — without disturbing the
verified loop/lineage/usage/isolation contracts.

## Decisions

### D1: Test hardening before feature additions
The bridge tests are the deterministic-checks gate for every real proof. A flaky gate
makes the whole swarm non-deterministic. Phase 0 hardens the gate (real timeout config +
handle-leak fix + flywheel network gating) BEFORE re-adding the wiki transfer that broke
it. Rationale: a green gate is the foundation; everything else is unverifiable without it.

### D2: Wiki transfer via the OKF markdown sink + optional vector index
`writeSink('okf')` already writes `knowledge/memory/<id>.md` (the human-readable wiki).
Re-adding `sinks: ['okf','qdrant']` accumulates wiki markdown AND the swarm vector.
Optionally index that markdown into `djimit_okf` so wiki knowledge is retrievable via the
existing `searchOkfMcp` path (OKF-compatible payload). The vector flywheel
(`djimitflo_swarm`) remains the primary retrievable store; the wiki is the curated,
human-readable projection.

### D3: Skills as authored OKF content + packet injection
Skills are markdown in OKF `skills/` (the existing `SkillService` reads them). Inject
relevant skill content into the assignment packet (alongside the capability manifest) so
specialists act with explicit capabilities. No new skill runtime; reuse the OKF seam.

### D4: opencode parity via the codex pattern
Apply the same three levers to opencode: sandboxed headless invocation (opencode's
`--sandbox`/approval equivalent), `--ignore-user-config` equivalent (minimal context), and
the LiteLLM proxy API key. This yields a heterogeneous fleet without a new abstraction —
both runtimes use the existing `buildRuntimeCommand` + `executeRuntimeCommand` seam.

### D5: Scale via the existing semaphore
`executeNestedSpawnProof` already runs specialists via `Promise.all`, bounded by the
runtime permit semaphore (`runtimeSemaphoreLimit`, default 4). Scale >2 = more specialist
roles in the nested spawn, same concurrency primitive. No new scheduler.

### D6: Memory quality via the curator task, not a new distillation service
The memory-curator is already a specialist agent. Evolve its task prompt to distill an
actionable rule (bounded diff) rather than emit a run-summary. The flywheel + wiki sinks
persist the rule; future runs retrieve it. No new distillation subsystem.

## Risks

- **R1 — vitest config loading mystery**: per-test and describe-options timeout forms did
  not take effect previously; the `vitest.config.ts` `testTimeout` must be verified to
  load. Mitigation: T0.2 verifies; fallback set `testTimeout` via the `vitest` CLI or a
  `beforeAll` `ctx.setConfig`.
- **R2 — handle leak**: the `afterEach` `server.close` hang suggests an open handle
  (un-reaped child, pending timer, or a fetch connection). Mitigation: T0.3 audits
  `executeRuntimeCommand`/`executeNestedSpawnProof`/`upsertToSwarmMemory`; ensure all
  children are reaped and all fetches are timeout-guarded (already added) + not leaked.
- **R3 — absolute-path escape**: codex `--sandbox workspace-write` confines writes to the
  worktree + `/tmp` + `$TMPDIR`; the host repo is protected. A determined runtime could
  still write via absolute paths to other writable locations. Out of scope here (separate
  sandbox hardening change); documented as a residual risk.
- **R4 — concurrent edits**: the operator is co-editing the same files on the workstation.
  Mitigation: Phase 0 T0.1 reconciles before any deploy; never force-over uncommitted work.

## Non-Abstractions

No new orchestration layer, scheduler, distillation service, or MCP server. Every
maturation reuses an existing seam (`buildRuntimeCommand`, `executeNestedSpawnProof`,
`writeSink`, `writeAssignmentPacket`, `SkillService`, `ContextInjectionService`).
