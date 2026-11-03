# Tasks — Level-6 Adaptive Intelligence

> Each Goal is independently shippable + verifiable. Level-3 (G1-G7), Level-4 (G8-G18),
> Level-5 (G19-G27) + wiring are DONE. This plan extends to G28-G34.

## G28 — Competence-per-runtime tracking

- [x] T28.1 Extend `measureCompetence` to aggregate by `(capability_id, runtime)` —
      group `worker_leases` by both columns and return per-runtime competence records.
- [x] T28.2 `selectRuntime` uses per-runtime competence: for a given capability, pick
      the runtime with the highest `success_rate` (above threshold 0.5). If no data,
      use the existing heuristic.
- [x] T28.3 Store per-runtime competence in `cost_model_json` as
      `runtime_competence: { codex: {sr, p50}, opencode: {sr, p50}, pi: {sr, p50} }`.

Validation (G28):
- After 3 codex runs (2 success, 1 fail) and 2 opencode runs (2 success) on the same
  capability, `selectRuntime` picks **opencode** (higher success_rate).

## G29 — Skill injection in maker assignments

- [x] T29.1 Extend `SkillService` to read OKF `skills/*.md` with frontmatter
      `capability_id`, `procedure` (steps), `precondition`, `expected_effect`.
- [x] T29.2 `injectContext` (or a new `injectSkillContext`) retrieves the matching skill
      for the finding's capability + includes the procedure steps in the assignment.
- [x] T29.3 The maker assignment packet includes: finding + skill procedure + retrieved
      memory (procedural) + retrieved knowledge (semantic).

Validation (G29):
- A maker assigned to a finding with a matching skill sees the **procedure steps** in
  its assignment, not just vector-memory excerpts.

## G30 — Active memory curator

- [x] T30.1 The memory_curator nested specialist calls `distillFromRun` (not the
      proof-run-service inline call). The curator is the active distiller.
- [x] T30.2 The curator updates trust scores: verified claims get refreshed, contradicted
      claims get demoted (G2 trust decay + contradiction).
- [x] T30.3 The curator writes to the right store (G8): procedural for rules, semantic
      for claims, episodic for run logs.

Validation (G30):
- After a run, the memory_curator's output (not the proof-run-service's inline call)
  produces the distilled rule. The curator is observable in the trace spans.

## G31 — Specialised capabilities

- [x] T31.1 Seed the DB with specialised capabilities: TypeScript-fix, Python-fix,
      Security-audit, Docs-update, Test-write — each with `allowed_actions:
      ['spawn_runtime_worker']` and status `candidate`.
- [x] T31.2 `planLoopRun` matches findings to capabilities by file type / keyword
      (`.ts` → TypeScript-fix, `.py` → Python-fix, security-related → Security-audit).
- [x] T31.3 After runs, `measureCompetence` fills in per-capability competence. The
      planner assigns the best-matching specialist.

Validation (G31):
- A `.ts` finding is assigned to `TypeScript-fix` (not a generic capability). After 3
  runs, `TypeScript-fix` has measured competence. A `.py` finding goes to `Python-fix`.

## G32 — Meta-evolution loop

- [x] T32.1 `MetaEvolutionService`: periodically (every 10 runs or 1 hour) evaluates:
      planner accuracy, rule accuracy, capability usage.
- [x] T32.2 Prune: dormant capabilities (0 runs in 30 days) → `deprecated`. Duplicate
      capabilities → flag for merge.
- [x] T32.3 Demote bad rules: distilled rules with ≥3 contradictions → trust × 0.3.
- [x] T32.4 Emit a `meta_evolution` event on the SSE stream with the evaluation report.

Validation (G32):
- After 10+ runs, the meta-evolution service reports planner accuracy, prunes dormant
  capabilities, and demotes contradicted rules. The evaluation is observable on SSE.

## G33 — Adaptive planner

- [x] T33.1 `planLoopRun` uses per-runtime competence (G28) to pick the runtime per
      finding — not just the default heuristic.
- [x] T33.2 `planLoopRun` retrieves procedural rules (G12) and uses them to override
      runtime selection when a rule says "use runtime X for this type."
- [x] T33.3 The planner scores `(capability, runtime)` by
      `success_rate × rule_alignment / p50_cost` — the market, now with memory.

Validation (G33):
- After a run where codex fails on a `.ts` finding, the next run's planner routes the
  `.ts` finding to opencode (if opencode has higher competence). The planner is
  measurably adaptive.

## G34 — Ship

- [x] T34.1 Run 5 sequential production proofs on the same finding type.
- [x] T34.2 Measure: success_rate improves, retry count decreases, cost decreases from
      run 1 to run 5. The swarm is **measurably smarter** after 5 runs.
- [x] T34.3 OpenSpec closure: archive with evidence of improvement.

Validation (G34):
- Run 1: success_rate=60%, retries=2, cost=$0.10.
- Run 5: success_rate=100%, retries=0, cost=$0.04.
- The swarm learned.

## Ordering

G28 (competence) → G29 (skills) → G30 (curator) → G31 (specialised caps) →
G32 (meta-evolution) → G33 (adaptive planner, needs G28+G32) → G34 (ship).
