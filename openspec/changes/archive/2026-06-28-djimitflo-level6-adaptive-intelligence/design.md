# Design — DjimFlo Level-6 Adaptive Intelligence

## 1. The cognitive framing (the spine)

Level-5 modelled the swarm as a coordinated team (parallel, negotiating, federated).
Level-6 models it as a **learning organism**: it adapts its runtime choices from
evidence, follows explicit procedures, curates its own memory, and evaluates its own
performance over time.

```
┌─────────────────────────────────────────────────────────────┐
│                DjimFlo Level-6 Cognitive Loop                 │
│                                                               │
│  Run N:                                                        │
│    Planner assigns (capability, runtime) per finding           │
│    Maker executes WITH skill procedure + retrieved memory      │
│    Checker verifies                                            │
│    Memory curator distills rules + updates trust               │
│    measureCompetence records (capability, runtime) outcome     │
│                                                               │
│  Between runs (meta-evolution):                               │
│    Evaluate planner accuracy (did assignments succeed?)        │
│    Evaluate rule accuracy (were distilled rules confirmed?)    │
│    Evaluate capability usage (which are dead weight?)          │
│    Prune dead capabilities, demote bad rules                  │
│    Update selectRuntime with per-runtime competence           │
│                                                               │
│  Run N+1:                                                      │
│    Planner uses updated competence + confirmed rules           │
│    → Better assignments → Higher success rate → Smarter       │
└─────────────────────────────────────────────────────────────┘
```

## 2. Competence-per-runtime tracking (G28)

Extend `measureCompetence` to track per-runtime:

```
CompetenceRecord := {
  capability_id: string,
  runtime: string,
  n_runs: number,
  n_completed: number,
  success_rate: number,
  p50_cost: number,
  p95_cost: number,
}
```

The `worker_leases` table already has `capability_id` + `runtime`. The query groups by
both: `SELECT runtime, status, metadata FROM worker_leases WHERE capability_id = ?`
→ aggregate per runtime.

`selectRuntime` uses this: for a given capability, it picks the runtime with the
highest `success_rate` (above a threshold). If no data exists, it uses the default
heuristic (sovereign→pi, lightweight→opencode, complex→codex).

## 3. Skill injection (G29)

`SkillService` reads OKF `skills/*.md` files. Each skill has a frontmatter with
`capability_id`, `procedure` (array of steps), `precondition`, and `expected_effect`.

The maker assignment packet includes:
1. The finding description (what to fix)
2. The skill procedure (how to fix it — steps 1...N)
3. The retrieved memory (what the swarm learned from prior runs — procedural store)
4. The retrieved knowledge (OKF + DjimitKB — semantic store)

This gives the maker **procedure + experience + knowledge**, not just experience.

## 4. Active memory curator (G30)

The memory_curator nested specialist evolves from "adds a comment" to "curates memory":

After a run completes, the curator:
1. Reads the run's evidence (claims, manifests, trace spans, checker verdicts).
2. Distills an actionable rule (G12 `distillFromRun`) — the curator does this, not the
   proof-run-service.
3. Updates trust scores: if a claim was verified by the checker, refresh its trust. If
   a claim was contradicted, demote it.
4. Detects contradictions: if the run's evidence contradicts an existing claim, create a
   `contradicts_ref` edge.
5. Writes to the right store (G8): procedural for rules, semantic for claims, episodic
   for run logs.

The proof-run-service delegates to the curator instead of doing distillation inline.

## 5. Specialised capabilities (G31)

Seed the DB with real specialised capabilities:

```
TypeScript-fix:   allowed_actions: ['spawn_runtime_worker'], competence on TS findings
Python-fix:        allowed_actions: ['spawn_runtime_worker'], competence on Python findings
Security-audit:    allowed_actions: ['spawn_runtime_worker'], competence on security findings
Docs-update:       allowed_actions: ['spawn_runtime_worker'], competence on doc findings
Test-write:        allowed_actions: ['spawn_runtime_worker'], competence on test findings
```

Each starts as `candidate` with no competence data. After runs, `measureCompetence`
fills in per-runtime success rates. The planner assigns the specialist with the best
competence for each finding type.

Finding-to-capability matching: the planner matches findings to capabilities by
keyword (e.g., a finding in a `.ts` file → TypeScript-fix, a finding about security →
Security-audit). This is the `planLoopRun` extension.

## 6. Meta-evolution loop (G32)

A `MetaEvolutionService` runs periodically (default: every 10 runs or 1 hour):

1. **Planner accuracy**: how many planner assignments (capability + runtime) resulted
   in success vs failure? Trend over time.
2. **Rule accuracy**: for each distilled rule in the procedural store, was it confirmed
   (the same approach succeeded again) or contradicted (it failed)? Demote rules with
   ≥3 contradictions.
3. **Capability usage**: which capabilities have 0 runs in the last N? Mark as `dormant`.
   Dormant capabilities with 0 runs in the last 30 days → `deprecated`.
4. **Capability duplicates**: are there two capabilities with the same `allowed_actions`
   and overlapping competence? Flag for merge.
5. **Prune**: delete or deprecate dead capabilities. Demote bad rules.
6. **Report**: emit a `meta_evolution` event on the SSE stream with the evaluation.

## 7. Adaptive planner (G33)

The planner (`planLoopRun`) evolves:

```
planLoopRun(id):
  findings = run.findings
  caps = listCapabilities(status=validated|candidate)
  for each finding:
    // G31: match finding to capability by keyword/type
    matched_caps = matchFindingToCapability(finding, caps)
    // G28: for each matched capability, pick the runtime with best competence
    for each cap in matched_caps:
      competence = measureCompetencePerRuntime(cap.id)
      best_runtime = pickBestRuntime(competence)
    // G33: also check distilled rules — have we learned anything about this finding type?
    rules = retrieveProceduralRules(finding)
    if rules contain "use runtime X for this type":
      override best_runtime with the rule's recommendation
    // Score: competence * rule_alignment / cost
    assign(best_cap, best_runtime)
```

The planner is now **evidence-driven**: it uses per-runtime competence (G28) +
distilled rules (G33) to make assignments. The same error doesn't recur because the
planner has learned.

## 8. Invariants (extended)

- **I14-I21**: (unchanged from Level-5)
- **I22 Runtime-evidence-bound**: the runtime is selected by observed per-capability
  per-runtime competence, not by static rules.
- **I23 Procedural**: the maker follows an explicit skill procedure, not just retrieved
  memory.
- **I24 Self-curating**: the memory curator actively distills, updates trust, and
  detects contradictions.
- **I25 Self-evaluating**: the meta-evolution loop periodically evaluates and prunes.
- **I26 Self-evolving**: the planner improves from run to run — measurably smarter.

## 9. Risks

- **R1 Over-fitting**: the planner might over-fit to recent runs (recency bias).
  Mitigation: competence is a rolling window (last N runs), not all history.
- **R2 Skill procedure stale**: a skill procedure might be wrong after a codebase
  change. Mitigation: skills go through the same evidence-gated promotion as
  capabilities — a skill that produces failures is auto-deprecated.
- **R3 Meta-evolution overhead**: the periodic evaluation adds processing. Mitigation:
  it runs in a timer (not in the hot path) and is bounded (max 1 min).
- **R4 Complexity**: per-runtime competence + skill injection + meta-evolution is more
  moving parts. Mitigation: each is a separate service with a clear seam; the
  integration is additive, not architectural.
