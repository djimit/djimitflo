# Evidence — Verified baseline + ship criteria

## Verified baseline (on `origin/main`, do not regress)

- **Real-runtime swarm**: codex specialists (maker, checker, planner, memory_curator) run
  headless, `production_passed=true`, `production_missing: []`.
- **Isolation**: worktrees outside the host repo + codex `--sandbox workspace-write`; host
  `tracked-changed: 0` across real runs (absolute-path residual is a G6 gap).
- **Parallel**: nested specialists run concurrently (verified overlapping windows;
  `runtimeSemaphoreLimit` default 4).
- **Knowledge injection**: Qdrant api-key wired; OKF (78 pts) + DjimitKBWiki + swarm memory
  injected into maker assignments (`## Context (Swarm + Knowledge)`).
- **Self-learning flywheel**: promoted memory embedded (ollama 768d) → `djimitflo_swarm`;
  verified write→retrieve→accumulate (`djimitflo_swarm` 0→1→2; proof B retrieved proof A).
- **Deterministic gate**: `proof-run-service.test.ts` 3/3 green (Phase 0; the djimitkb-mcp
  RAG-fetch deadlock fixed with `fetchWithTimeout`).
- **Efficiency lever**: `--ignore-user-config` cuts codex context ~73% (325k→87k).
- **Operability**: Mission Control, manifests/claims/lineage, rollback, OpenSpec maturation
  plan (Phase 0 done).

## Existing seams the Level-3 plan reuses (no greenfield)

- `LOOP_CONTRACTS` (roles + allowed/forbidden + gates + escalation) — the policy seed.
- `SwarmIntelligenceService` — `swarm_claims` (supported/contradicted/superseded),
  `swarm_evidence_edges`, `swarm_capabilities`, `swarm_runner_manifests` — the graph skeleton.
- `NestedSpawnService` — `spawn_trees`, `sub_agent_spawns`, depth/budget/cycle/concurrency gates.
- `MemoryCandidateService` — promote + `containsSecret` + writeSink (okf/qdrant).
- `ContextInjectionService` — retrieval (qdrant/ollama/djimitkb) — becomes the graph index.
- `SkillService` + OKF `skills/` — the (empty) skill store.
- `LoopService` — `continueLoopRun`, `executeWorker/Checker`, `executeNestedSpawnProof`,
  `evaluateTokenBudget`, `runtimeSemaphoreLimit`, `createWorktree`, the gates, the circuit
  breaker, the `split` action, `loop_checkpoints`.
- `ProofRunService` — the certificate seed; Mission Control; rollback.
- `swarm-status.fleetPools().recommended_concurrency` — the deferred scale coupling.

## Ship criteria (G7 — the gate that means "finished + delivered")

A **real, non-trivial djimitflo goal** (e.g., a real open issue) is resolved by the swarm:
- the planner emits a ≥3-capability DAG; specialists assigned by competence; parallel +
  scaled (G4); skills + memory injected with provenance/trust (G1/G2); handoff verified
  (G5); host untouched via OS sandbox (G6); learning written back (G2 flywheel).
- the run is **green** (the convergence certificate), observable in Mission Control,
  rollback-safe.
- the diff is real, tests green, merged via human approval; the OpenSpec change is archived
  with evidence.

## Security remediation already done (2026-06-27)

- 5 real API keys purged from public GitHub history (DeepGit OpenAI, DeepCode OpenRouter,
  claude-code-templates Google ×2, ChatDev + suna OpenAI) via `git filter-repo` + force-push
  (verified `REMOTE commits-with-secret = 0` each). Rotation still owed by the operator.
- djimitflo Qdrant key is NOT on GitHub (only in unpushed workstation history); rotate + purge.
- Private repos not scanned (need a GitHub PAT) — pending.
