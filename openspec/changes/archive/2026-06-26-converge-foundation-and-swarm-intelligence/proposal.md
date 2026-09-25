# Converge Foundation And Swarm Intelligence

## Why

Djimitflo's learning flywheel is functionally complete — `KnowledgeRuntimeService`,
OKF capability sync, learning closure, Mission Control panels and a passing
end-to-end smoke all exist. But three blockers prevent the next phase from
starting cleanly:

1. **4 failing tests** out of 360 block `npm run test` from exiting green. The
   primary failure is a 5000ms timeout in `swarm-resource-plan.test.ts` at the
   "reports swarm reality counts" case. The suite cannot be trusted as a
   regression baseline while it is red.
2. **Phase 7 of `knowledge-runtime-learning-flywheel`** has 6 unchecked smoke
   tasks, but the `learning-flywheel-smoke.test.ts` test already exercises the
   full path (validate OKF → sync → mock loop → close learning → no promotion).
   The tasks need verification and checkbox closure so the change is marked
   done.
3. **39 uncommitted files** (2993 insertions, 200 deletions) span server,
   dashboard, tests, migrations and OpenSpec. These must be reviewed and
   committed before new work begins, or the Swarm Intelligence phase inherits
   an unclean tree.

Once these three are resolved, the critical path advances to **Phase 7: Swarm
Intelligence** (G14) — the governed capability registry, specialist councils,
evidence graph, claim ledger, capacity governor v2, evaluation harness and
Mission Control dashboard views defined in
`next-level-swarm-skills-specialists`.

## What Changes

### Phase A — Stabilize

- Fix the 4 failing tests so `npm run test` exits green (360/360 or adjusted
  count with documented skips).
- Raise or restructure the `swarm-resource-plan.test.ts` timeout case to not
  flake under normal CI load.
- Confirm `npm run type-check` and `npm run lint` are clean across all
  workspaces.

### Phase B — Verify Learning Flywheel Closure

- Confirm `learning-flywheel-smoke.test.ts` covers all 6 Phase 7 tasks in
  `knowledge-runtime-learning-flywheel/tasks.md`.
- Check off the Phase 7 tasks with evidence (test name, endpoint, assertion).
- Run `openspec validate knowledge-runtime-learning-flywheel --strict` and
  `openspec validate prove-learning-flywheel-operator-loop --strict` to confirm
  both changes are complete.

### Phase C — Commit Clean Tree

- Review the 39 uncommitted files against the OpenSpec changes they belong to.
- Group commits by logical change (learning flywheel, fleet cockpit refactor,
  agent catalog, security upgrades, DB migration fix).
- Commit with traceable messages referencing the OpenSpec change IDs.
- Confirm `git diff --check` is clean (no whitespace errors).

### Phase D — Swarm Intelligence (G14)

- G14.1: Swarm intelligence kernel — mission, task and decision-state models
  linking goals, loop-runs, panels, claims, capabilities and worker leases.
- G14.2: Capability registry and skill contracts — typed contracts with
  allowed/forbidden actions, required evidence, eval thresholds, risk ceilings
  and status gates (draft → candidate → validated → deprecated).
- G14.3: Specialist council and hypothesis workbench — bounded specialist
  profiles, panel creation with required security reviewer for high/critical
  risk, independent review capture with support/oppose/uncertain/dissent,
  consensus-to-backlog projection.
- G14.4: Evidence graph and claim ledger — claim records with source refs,
  confidence, contradiction links, promotion status; evidence edges across all
  runtime entities; memory candidate classification.
- G14.5: Capacity governor v2 — queue classes, per-runtime fair-share
  scheduling, runner planning with budget/failure/kill handling.
- G14.6: Evaluation harness — deterministic scorecards for skills, specialists,
  memory retrieval, routing decisions and worker outcomes.
- G14.7: Mission Control dashboard — registry, active execution, queue depth,
  capacity, budgets, blocked reasons, specialist council view, evidence graph
  view.
- G14.8: End-to-end swarm scenario smoke Part 1 — evaluator quorum gate,
  split-decision rules, runner audit manifests, replay branches, risk-aware
  warning gates, fleet circuit breakers.
- G14.9: End-to-end swarm scenario smoke Part 2 — full mock-runtime scenario
  from question to specialist panel to backlog to goal to prepared leases to
  checker to evidence graph update.

## Guardrails

- No auto-merge, push or deploy.
- No unattended high-risk worker execution.
- No automatic policy, security or autonomy memory promotion.
- No new canonical store besides OKF files and SQLite runtime state.
- No claim that registry rows, prepared leases or `agentCount` are active
  execution without runtime evidence.
- No dependency on Ruflo as a runtime.
- Tests must be green before Phase D work begins.
- Uncommitted changes must be committed before Phase D work begins.

## Success Criteria

- `npm run test` exits green across all workspaces.
- `npm run type-check` and `npm run lint` are clean.
- `openspec validate knowledge-runtime-learning-flywheel --strict` passes.
- `openspec validate prove-learning-flywheel-operator-loop --strict` passes.
- `openspec validate converge-foundation-and-swarm-intelligence --strict` passes.
- `git status --short` is empty (clean tree) before Phase D begins.
- `openspec validate next-level-swarm-skills-specialists --strict` passes after
  G14 implementation.
- `/goals` dry-run emits ordered G14 goals with dependencies.
- Capability contracts exist for skills, specialist profiles and runtimes
  before they can route work.
- Specialist council output records support, oppose, uncertainty, dissent,
  evidence references and backlog projection.
- Capacity governor v2 can explain why work is eligible, blocked, queued,
  running or killed.
- Skill and specialist behavior is evaluated by deterministic harnesses before
  autonomy expands.
- Dashboard views make active execution provable from runtime evidence only.
- End-to-end mock-runtime smoke proves the full swarm scenario without merge,
  push, deploy or high-risk unattended execution.
