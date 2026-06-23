---
id: memory.software-brain-problem
type: Memory
title: "The Software-Brain Problem — architecture is domain-agnostic, implementations are code-shaped"
description: Core outcome of swarm-architecture discussion: djimitflo's LoopContract schema, OKB memory, evidence graph, specialist dissent, and hypothesis workbench already model process-as-truth, but all 7 loop contracts, all executors, and all verification gates default to code. The fix is four extensions, not a rewrite.
owner: djimit
status: active
confidence: reasoning
classification: internal
created_at: 2026-06-21T22:50:00Z
updated_at: 2026-06-21T22:50:00Z
timestamp: 2026-06-21T22:50:00Z
last_validated: 2026-06-21T22:50:00Z
review_cycle_days: 90
tags: [memory, architecture, knowledge-work, software-brain, loops, okb, evidence, specialists]
related:
  - openspec/changes/agentic-control-loop-fleet:RELATED_TO
  - openspec/changes/next-level-swarm-skills-specialists:RELATED_TO
  - openspec/changes/g15-enforced-swarm-intelligence:RELATED_TO
  - memory.okb-foundation-build:RELATED_TO
---

# The Software-Brain Problem

## Context

Discussion prompted by the observation that Codex/Cowork/Code tools remain
"software-brained": they treat the end product (the codebase) as the source of
truth, and code serves as a checkpoint. For knowledge work, the inquiry
trajectory — research, alternatives explored, dead ends, refinements — is at
least as valuable as the final deliverable. You cannot reconstruct it from the
deliverable + a to-do list the way you can reconstruct code history from git.

Additional software-brain symptoms: FE/BE divide, solving for the general case,
not exploring idea spaces, testing for technical correctness only.

## Core finding

**The architecture was never software-brained. The loop contracts, runtime
types, and gate implementations were.**

### What already models process-as-truth

1. **LoopContract schema is domain-agnostic** — every field is `string[]` with
   no enum constraint (`trigger`, `context_sources`, `actions_allowed`,
   `actions_forbidden`, `verification`, `state`, `escalation`,
   `stop_conditions`). A knowledge-work loop fits without schema change.
   Source: `packages/server/src/services/loop-service.ts:25`.

2. **OKB memory models epistemic state** — Concept/Relation schema with
   `confidence`, `classification`, `status`, `evidence_refs`. Claim ledger
   tracks proposed→supported→resolved with explicit contradictions. Evidence
   graph has typed edges (supports/refines/contradicts/sources).

3. **Specialist councils preserve dissent** — Phase 7 panels record
   support/oppose/uncertainty with `dissent_preserved`. Not "produce the
   answer" — "produce the reasoning, including disagreement."

4. **Hypothesis workbench is a learning loop** — question → evidence_plan →
   experiment → consensus+dissent → backlog_candidate. Exactly the
   "refining perspectives as you go" mechanism knowledge work needs.

5. **No-theater principle (G16)** — a claim is not true because it's on a
   dashboard; it's true because there's runtime evidence. Applied to knowledge
   work: a deliverable is not justified because it exists; it's justified
   because there's a provable inquiry trail.

### What is still code-shaped

| Layer | Current state | Software-brain assumption |
|-------|--------------|--------------------------|
| Executors | Codex, OpenCode, Pi, Claude, Gemini, Cline, editor | All coding agents |
| Verification gates | tests, lint, typecheck, security_scan, frontmatter_present, diff_threshold | Technical correctness only |
| Worktree isolation | git worktrees per agent/loop | Assumes codebase artifact |
| Acceptance criteria | "tests pass", "no git conflicts" | Artifact correctness, not understanding quality |
| All 7 existing loops | doc-drift, repo-maintenance, skill-quality, mcp-validation, security-regression, okf-sync, policy-drift | Every context_source is a code/ops artifact |
| `manual` runtime | command: null, no output, no events | Human-execution stub, not a knowledge-work executor |

## The four extensions needed (not a rewrite)

1. **Epistemic verification gates** — `source_coverage_min_N`,
   `alternative_exploration_min_K`, `dissent_preserved`,
   `evidence_chain_complete`, `perspective_refinement_shown`,
   `no_unresolved_contradictions_in_final_claims`. Checkable against the
   evidence graph and claim ledger that already exist in the Phase 7 design.

2. **A `research`/`deerflow` runtime** — DeerFlow already runs on `:2026` and
   turns research into OKF skill concepts. Wire it as a loop runtime that
   produces OKB artifacts (hypotheses, evidence nodes, claims) instead of code
   diffs, verified by epistemic gates instead of test gates.

3. **A `Trajectory` OKB concept type** — linked `Perspective` nodes with
   `refined_by` edges, each capturing the agent's understanding at a point in
   time and what evidence caused the shift. This is what makes post-compaction
   recovery possible for knowledge work: re-derive from trajectory, not from
   artifact.

4. **`okb:` state persistence adapters** — today only `sqlite:` and
   `markdown:` state adapters exist. Loop state needs to persist to the OKB
   graph, not just SQLite rows.

## Concrete proof: policy-analysis-loop

A knowledge-work loop contract that fits the existing `LoopContract` interface
without a single schema change:

```
name: policy-analysis-loop
context_sources: [okb_concepts, evidence_graph, claim_ledger, external_sources,
  specialist_panels, prior_analyses, regulatory_text]
actions_allowed: [read_okb, query_evidence_graph, spawn_specialist_panel,
  propose_hypothesis, design_evidence_plan, run_experiment, record_finding,
  record_dissent, refine_perspective, write_loop_state, submit_checker_verdict]
verification: [source_coverage_min_3, alternative_exploration_min_3,
  dissent_preserved, evidence_chain_complete, perspective_refinement_shown,
  no_unresolved_contradictions_in_final_claims, checker_verdict]
state: [sqlite:loop_runs, okb:trajectory, okb:evidence_nodes, okb:claims]
```

## The deeper point

Coding harnesses internalize: *truth is what passes tests.* Knowledge work
operates on: *truth is what survives sustained inquiry with dissent preserved.*
djimitflo's architecture — loops, evidence graphs, claim ledgers, specialist
dissent, no-theater proof — is built on the second epistemology. It just hasn't
realized it yet, because every executor and every gate defaults to the first.

Point the architecture at knowledge work, add the epistemic gates, and the
software brain dissolves — not because you fought the harness, but because the
harness was never the architecture. The harness was the executor. The
architecture was always bigger.

## Sandbox constraint

The canonical OKB memory path (`knowledge/memory/` → symlink to
`../djimitflo-knowledge/okf`) is outside the workspace write boundary. This
memory concept is saved to `notes/memory-software-brain-problem.md` instead.
To promote to canonical OKB: copy to `djimitflo-knowledge/okf/memory/` and
update `knowledge/memory/index.md`.

## Related artifacts

- `notes/software-brain-problem-discussion.md` — full two-part discussion with
  source-code evidence
- `openspec/changes/agentic-control-loop-fleet/proposal.md` — loop contract model
- `openspec/changes/next-level-swarm-skills-specialists/proposal.md` —
  specialist councils, hypothesis workbench, evidence graph, claim ledger
- `openspec/changes/g15-enforced-swarm-intelligence/proposal.md` — enforcement
- `memory/okb-foundation-build.md` — OKB schema and validator build status
