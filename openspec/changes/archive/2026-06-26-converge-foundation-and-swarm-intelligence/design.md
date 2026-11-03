# Design

## Decision

This change is a convergence change: it closes three loose ends (failing tests,
unchecked flywheel tasks, uncommitted tree) and then implements the Swarm
Intelligence Layer (G14) from `next-level-swarm-skills-specialists`.

The design follows the three-option pattern already documented in the G14
design:

- **Option A (Swarm Kernel)** for worker lease lifecycle, queue classes,
  capacity and policy gates.
- **Option B (Skill Mesh)** for capability registry, skill routing, specialist
  profiles and eval scoring.
- **Option C (Specialist Council)** for hypothesis workbench, claim ledger,
  memory synthesis and strategic analysis.

All three coexist; the orchestrator selects the right pattern per work type.

## Phase A — Stabilize

### Failing test: swarm-resource-plan.test.ts timeout

The test at line 112 ("reports swarm reality counts") inserts agents, loop_runs
and worker_leases, then calls the swarm status endpoint. The 5000ms default
timeout is too tight when the test suite runs under load.

Fix options (in order of preference):

1. **Raise the test timeout** to 15000ms for this specific test — the
   assertions are correct, only the budget is too tight.
2. **Split the test** into smaller cases that each insert fewer rows.
3. **Mock the swarm status service** instead of exercising the full HTTP path.

Option 1 is the smallest change and doesn't sacrifice coverage.

### Other 3 failing tests

Identify by running `npx vitest run --reporter=verbose 2>&1 | grep FAIL`.
Fix each by inspecting the assertion vs. the actual error, not by deleting
the test. If a test is genuinely obsolete (testing removed functionality),
mark it with `it.skip` and a reason comment — do not delete.

## Phase B — Verify Flywheel Closure

The `learning-flywheel-smoke.test.ts` already exercises:

1. Validate OKF (calls `validate_okf.py`)
2. Sync capabilities dry-run (calls capability sync endpoint with `dry_run`)
3. Apply capability sync (calls capability sync endpoint with `apply`)
4. Prepare and drain a mock loop (creates goal, loop, maker/checker leases,
   runs mock workers)
5. Close loop learning (calls close-loop endpoint)
6. Confirm reflection and memory candidate without promotion (asserts no
   automatic promotion)

Map each Phase 7 task to the specific test assertion, then check off the
tasks in `knowledge-runtime-learning-flywheel/tasks.md`.

## Phase C — Commit Clean Tree

Group the 39 uncommitted files by logical change:

| Group | Files | OpenSpec change |
|-------|-------|-----------------|
| Learning flywheel | knowledge-runtime-service, capability-sync, learning-closure, smoke test | knowledge-runtime-learning-flywheel |
| Fleet cockpit refactor | FleetCockpitPage, swarm-status-service, swarm-resource-plan | real-worker-fleet-functionality-scale |
| Agent catalog | agent-registry-service, context-injection | (spec-kit adoption) |
| Security upgrades | package-lock, deps | (deps upgrade) |
| DB migration fix | migrate.ts, schema.ts | (db repair) |
| Dashboard | SwarmMissionControlPage, api.ts | prove-learning-flywheel-operator-loop |

Commit each group with a `feat:`/`fix:`/`refactor:` message referencing the
OpenSpec change ID. Run `git diff --check` before each commit to catch
whitespace errors.

## Phase D — Swarm Intelligence (G14)

### G14.1 Swarm Intelligence Kernel

New tables: `swarm_missions`, `swarm_tasks`, `swarm_decisions`.

State machine:
```
observed → hypothesized → planned → queued → prepared → running
→ checking → ready_for_human_merge → completed|blocked|rejected|escalated
```

Each transition requires runtime evidence (not just a DB row update).

### G14.2 Capability Registry

Reuses existing `swarm_capabilities` table (from learning flywheel). Adds:
- Contract validation: allowed_actions, forbidden_actions, required_evidence,
  eval_threshold, risk_ceiling, removal_strategy
- Status gates: draft and candidate are advisory; validated may route live
  workers within risk ceiling
- Tests for live routing refusal when draft/disabled/over-risk/below-eval

### G14.3 Specialist Council

New tables: `specialist_profiles`, `specialist_panels`, `specialist_reviews`.

Panel flow:
1. Create panel with question + evidence plan + risk class
2. Assign specialists (security reviewer required for high/critical)
3. Each specialist independently reviews: support/oppose/uncertain/dissent
4. Consensus + dissent → backlog projection (no workers started)

### G14.4 Evidence Graph And Claim Ledger

New tables: `swarm_claims`, `evidence_edges`.

Claim lifecycle: `proposed → supported → resolved` with explicit contradiction
links. Evidence edges connect: goal, loop_run, worker_lease, panel,
capability, source, claim, decision, memory_candidate, trace_span.

Memory candidate classification: operational, engineering_rule, policy_rule,
rejected_secret_like.

### G14.5 Capacity Governor V2

Extends existing `swarm_status_service` with:
- Queue classes: research, doc_fix, test_repair, security, memory, policy
- Per-runtime fair-share scheduling
- Budget enforcement: token, wall-clock, failure
- Kill/timeout handling with trace spans

### G14.6 Evaluation Harness

New table: `agent_eval_runs` (already exists from learning flywheel).

Adds deterministic scorecards for:
- Skill contracts (does the skill do what it claims?)
- Specialist outputs (is the reasoning sound?)
- Memory retrieval (are the right memories surfaced?)
- Routing decisions (was the right capability selected?)
- Worker outcomes (did the work pass gates?)

Advisory LLM evals cannot override deterministic gates.

### G14.7 Mission Control Dashboard

Extends `SwarmMissionControlPage.tsx` with:
- Registry view (capability status, eval score, risk ceiling)
- Active execution view (running workers from runtime evidence)
- Queue depth view (per queue class)
- Specialist council view (panel state, consensus, dissent)
- Evidence graph view (contradicted, review-required, promoted claims)

### G14.8-G14.9 End-to-End Smoke

Two-part smoke:
1. **Part 1**: evaluator quorum gate, split-decision rules, runner audit
   manifests, replay branches, warning gates, circuit breakers
2. **Part 2**: full mock-runtime scenario from question → specialist panel →
   backlog → goal → prepared leases → checker → evidence graph → no
   merge/push/deploy

## Runtime Model

No new canonical stores. OKF files remain canonical knowledge; SQLite
remains runtime state; Qdrant and UAMS remain projections.

## Dependency Order

```
Phase A (stabilize) → Phase B (verify flywheel) → Phase C (commit clean)
→ G14.1 (kernel) → G14.2 (registry) → G14.3 (council) → G14.4 (evidence)
→ G14.5 (capacity) → G14.6 (eval) → G14.7 (dashboard) → G14.8 (smoke 1)
→ G14.9 (smoke 2)
```

G14.2 depends on G14.1. G14.3 depends on G14.2. G14.4 depends on G14.3.
G14.5-G14.6 depend on G14.2. G14.7 depends on G14.1-G14.6. G14.8-G14.9 depend
on all prior.
