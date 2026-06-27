## ADDED Requirements

### Requirement: The deterministic-checks gate is deterministic

The proof-run bridge tests (`packages/server/src/__tests__/proof-run-service.test.ts`) SHALL pass deterministically (≥3 consecutive runs) so that a real-runtime proof's `deterministic_checks` gate is not flaky. The bridge tests SHALL NOT make real ollama/qdrant network calls (gated by `PROOF_RUN_MEMORY_FLYWHEEL`), SHALL have a timeout margin matching their git-worktree + multi-spawn workload, and SHALL not leak handles that hang `afterEach` `server.close`.

#### Scenario: Bridge tests pass repeatedly

- **WHEN** `npm run test --workspace=@djimitflo/server -- proof-run-service.test.ts` is run 3 times consecutively
- **THEN** all runs pass with no `timed out` failures
- **AND** no `afterEach` hook timeout occurs

#### Scenario: Bridge tests do no network I/O

- **WHEN** the bridge tests run
- **THEN** `upsertToSwarmMemory` returns early (`PROOF_RUN_MEMORY_FLYWHEEL=false`)
- **AND** no ollama or qdrant fetch is issued

### Requirement: Promoted swarm memory is transferred to the wiki

When a real-runtime proof promotes a memory candidate, the system SHALL write it to BOTH the OKF memory markdown wiki (`knowledge/memory/<id>.md`) AND the swarm vector store (`djimitflo_swarm`), so the human-readable wiki accumulates the swarm's learnings alongside the retrievable vectors. The wiki write SHALL be best-effort and never fail the promote.

#### Scenario: A proof grows the wiki and the vector store

- **WHEN** a real-runtime proof completes and promotes its memory candidate
- **THEN** a new `knowledge/memory/<id>.md` file is created
- **AND** a new point is upserted into `djimitflo_swarm`
- **AND** the proof remains `production_passed=true`

#### Scenario: Wiki write failure does not fail the proof

- **WHEN** the OKF memory directory is unwritable or missing
- **THEN** `writeSink('okf')` returns `skipped`
- **AND** the promote and the proof still succeed

### Requirement: Specialists operate with injected skills

The system SHALL author real skill definitions in OKF `skills/` and inject skill content relevant to the finding into the specialist assignment packet, so agents act with explicit capabilities in addition to retrieved memory and vector knowledge.

#### Scenario: A specialist assignment includes skill content

- **WHEN** a specialist assignment packet is written for a finding
- **THEN** the packet includes a skills block with real skill content
- **AND** the proof remains `production_passed=true`

### Requirement: opencode runs as a sandboxed, headless, knowledge-injected runtime

The system SHALL run opencode with a sandboxed, headless invocation (mirroring codex's `--sandbox workspace-write` + approval bypass + minimal-context treatment) and SHALL configure the LiteLLM proxy API key so the opencode maker lease completes. A real opencode proof SHALL reach `production_passed=true` without mutating the host.

#### Scenario: opencode proof is green and isolated

- **WHEN** `swarm:proof -- create opencode --skip-permissions` runs with the LiteLLM API key configured
- **THEN** the proof reaches `production_passed=true`
- **AND** the host repo `tracked-changed` remains 0

### Requirement: The swarm runs >2 concurrent specialists

The system SHALL orchestrate more than two nested specialist agents concurrently (bounded by the runtime permit semaphore) and the depth/budget/concurrency gates SHALL hold at that scale.

#### Scenario: Three+ specialists run concurrently

- **WHEN** a proof orchestrates ≥3 nested specialist roles
- **THEN** their execution windows overlap
- **AND** all concurrency/budget/depth gates pass
- **AND** the proof is `production_passed=true`

### Requirement: The swarm accumulates distilled rules, not only run-summaries

The memory-curator SHALL distill an actionable engineering/operational rule from the run (bounded diff), persisted via the flywheel + wiki sinks, so subsequent runs retrieve useful knowledge.

#### Scenario: A later run retrieves an actionable rule

- **WHEN** a subsequent run retrieves swarm memory
- **THEN** the injected context contains a distilled rule
- **AND** not only a run-summary

## MODIFIED Requirements

### Requirement: vitest timeouts match integration-test workload

`packages/server/vitest.config.ts` SHALL set `testTimeout` and `hookTimeout` sufficient for loop-integration tests (git worktree add + `applySourceWorkingTreeDiff` + multiple runtime spawns + deterministic checks). The configured timeouts SHALL be verified to load (the per-test and describe-options forms are not relied upon).

#### Scenario: Configured timeouts take effect

- **WHEN** a bridge test exceeds the 5s default but completes within the configured margin
- **THEN** the test passes (no `timed out` failure)
- **AND** the configured `testTimeout`/`hookTimeout` are confirmed applied
