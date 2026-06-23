---
id: notes.software-brain-problem-discussion
type: Note
title: "The Software-Brain Problem — process vs. product in agentic knowledge work"
description: Swarm-architecture discussion mapping the 'software-brained' critique of Codex/Cowork/Code to djimitflo's loop/memory/evidence/specialist design, identifying what already addresses it and what doesn't.
owner: djimit
status: active
confidence: reasoning
classification: internal
created_at: 2026-06-21T22:45:00Z
tags: [notes, architecture, knowledge-work, software-brain, loops, okb, evidence]
related: [openspec/changes/agentic-control-loop-fleet:RELATED_TO, openspec/changes/next-level-swarm-skills-specialists:RELATED_TO, openspec/changes/g15-enforced-swarm-intelligence:RELATED_TO]
---

# The Software-Brain Problem

## Process vs. product in agentic knowledge work

See the full discussion in the conversation thread. Key claims preserved here
for swarm continuity:

1. The core mismatch: coding harnesses treat the artifact (codebase) as the
   source of truth. Knowledge work treats the *inquiry trajectory* — research,
   alternatives explored, dead ends, refinements — as at least as valuable as
   the final deliverable.

2. djimitflo's loop model (goal → decompose → assign → execute → verify →
   memory-update → next) is structurally process-aware, but its executors
   (Codex, OpenCode, Pi, Claude, Gemini, Cline), verification gates (tests,
   lint, typecheck, security scan), and worktree isolation (git branches) are
   all code-shaped. The architecture is domain-agnostic; the runtime is not.

3. The OKB memory + evidence graph + claim ledger + specialist-council dissent
   preservation already model process-as-truth. The hypothesis workbench
   (question → evidence plan → experiment → dissent → backlog) is exactly the
   "learning loop" the critique asks for. But these are design-complete, not
   production-wired to non-code executors.

4. Four concrete gaps to close: (a) epistemic verification gates alongside
   technical ones, (b) non-code executors with process-artifact outputs, (c)
   trajectory as first-class memory (not just claims/outcomes), (d) acceptance
   criteria that measure understanding quality, not just artifact correctness.

5. The "no-theater" principle (G16) is the right enforcement mechanism: a
   knowledge-work deliverable must be backed by a provable inquiry trail, just
   as a code claim must be backed by a passing test.

---

## Part 2: Concrete evidence from the source code

After inspecting `packages/server/src/services/loop-service.ts`, the picture
sharpens considerably.

### The LoopContract schema is already domain-agnostic

```typescript
interface LoopContract {
  name: LoopName;
  title: string;
  description: string;
  mode: 'closed';
  risk_class: RiskClass;
  trigger: string[];          // any string
  context_sources: string[];  // any string
  actions_allowed: string[];  // any string
  actions_forbidden: string[];// any string
  verification: string[];     // any string
  state: string[];            // any string
  escalation: string[];       // any string
  stop_conditions: string[];  // any string
}
```

Every field is `string[]` with no enum constraint at the type level. The schema
imposes NO domain assumption. A knowledge-work loop contract fits this interface
without a single line of code change.

### The 7 existing loops are all code/ops-shaped

| Loop | context_sources | verification gates |
|------|-----------------|-------------------|
| doc-drift-and-small-fix | markdown, package_scripts, loop_skills | read_only_discovery, diff_threshold, tests_lint_typecheck, checker_verdict, no_automatic_merge |
| repo-maintenance | package_json, markdown, source_comments | package_scripts_exist_or_skipped, diff_threshold, tests_lint_typecheck |
| skill-quality | packages/knowledge/skills, skill_frontmatter | frontmatter_present, allowed_actions_present, gates_present |
| mcp-connector-validation | mcp_seed_config, mcp_routes | inventory_present, permission_policy_present, no_secret_capture |
| security-regression | package_scripts, security_docs, auth_policy_files | security_checker_verdict, no_secret_leak, tests_lint_typecheck |
| okf-synchronization | packages/knowledge, okf_agents, okf_skills | frontmatter_present, index_present, no_secret_capture |
| overwatch-policy-drift | approval_policies, policy_routes, risk_classifier | security_checker_verdict, approval_gate_preserved, audit_event_written |

Every `context_sources` entry is a code/ops artifact. Every `verification` gate
checks structural or technical correctness. Zero loops model inquiry, exploration,
or epistemic quality.

### The `manual` runtime is a placeholder, not a knowledge-work executor

```typescript
if (runtime === 'manual') {
  return { runtime: 'manual', available: true, command: null,
    status: 'ok', supports_json_events: false,
    evidence: ['manual runtime requires human execution'] };
}
```

The `manual` runtime produces no output, captures no events, parses no usage.
It's a "human does the work" stub. Knowledge work needs a `research` or
`deerflow` runtime that produces structured inquiry artifacts (OKB concepts,
evidence nodes, claims) as its output, verifiable by epistemic gates.

### Concrete knowledge-work loop contract (fits the existing schema)

```
name: policy-analysis-loop
title: Policy Analysis
description: Research a policy question, explore alternatives, preserve dissent,
  and produce an evidence-backed analysis with a provable inquiry trail.
mode: closed
risk_class: medium
trigger: [manual, policy_question]
context_sources: [okb_concepts, evidence_graph, claim_ledger, external_sources,
  specialist_panels, prior_analyses, regulatory_text]
actions_allowed: [read_okb, query_evidence_graph, spawn_specialist_panel,
  propose_hypothesis, design_evidence_plan, run_experiment, record_finding,
  record_dissent, refine_perspective, write_loop_state, submit_checker_verdict]
actions_forbidden: [merge, deploy, modify_policy, delete_evidence,
  suppress_dissent, auto_promote_claim_to_truth]
verification: [source_coverage_min_3, alternative_exploration_min_3,
  dissent_preserved, evidence_chain_complete, perspective_refinement_shown,
  no_unresolved_contradictions_in_final_claims, checker_verdict]
state: [sqlite:loop_runs, sqlite:loop_events, okb:trajectory,
  okb:evidence_nodes, okb:claims, markdown:LOOP_STATE.md]
escalation: [unresolvable_contradiction, source_conflict,
  insufficient_evidence, human_judgment_required, budget_exhausted]
stop_conditions: [acceptance_criteria_met, inquiry_budget_exhausted,
  human_judgment_required, all_epistemic_gates_passed]
```

This contract uses the EXISTING `LoopContract` interface. No schema change
needed. What's missing is:
1. Gate implementations for the epistemic verification types
2. A `research`/`deerflow` runtime that produces OKB artifacts
3. A `Trajectory` OKB concept type for perspective-refinement state
4. `okb:` state persistence adapters (today only `sqlite:` and `markdown:` exist)

### The additional "software brain" problems, mapped

The user flagged four more software-brain symptoms beyond process-vs-product:

1. **Front-end/back-end divide**: The coding harnesses split work into FE/BE
   because that's how codebases are structured. Knowledge work doesn't divide
   this way — a policy analysis has "sources" and "synthesis," not "frontend"
   and "backend." djimitflo's loop model doesn't impose FE/BE (the
   `actions_allowed` field is domain-free), but the fleet roles
   (maker/checker/security/memory/governance) are still code-shaped. A
   knowledge-work fleet needs roles like researcher/synthesist/critic/editor,
   not maker/checker.

2. **Solving for the general case in a repeatable way**: Code tools optimize for
   reusable, general solutions. Knowledge work often needs the *specific* case
   deeply understood, not the general pattern. The specialist council design
   (Phase 7) actually helps here — a specialist panel can reason about a
   specific situation without generalizing. But the capability registry
   (draft→candidate→validated→deprecated) is optimized for reusable skills, not
   one-off inquiry patterns.

3. **Not testing or exploring idea spaces**: Code tools test implementations,
   not ideas. The hypothesis workbench (question → evidence plan → experiment →
   dissent → backlog) is the right mechanism, but it's design-complete, not
   wired to a runtime that can actually run experiments and record results as
   OKB evidence nodes.

4. **Testing for technical correctness but not other aspects**: The existing
   gates check structural correctness (frontmatter present, scripts exist,
   no secrets). Epistemic gates would check: Is the reasoning sound? Are
   sources credible? Is the uncertainty bounded? Is the strongest
   counterargument addressed? These are checkable against the evidence graph
   and claim ledger — the data structures already exist.

### The bottom line, updated with source evidence

The `LoopContract` interface is domain-agnostic by construction. The OKB schema
models epistemic state, not just artifacts. The evidence graph tracks
contradictions and provenance. The specialist councils preserve dissent. The
hypothesis workbench models learning loops. The "no-theater" principle demands
provable evidence.

**The architecture was never software-brained. The loop contracts, runtime
types, and gate implementations were.** The fix is to populate the
domain-agnostic schema with knowledge-work content: new loop contracts, a
research runtime, epistemic gate implementations, and a Trajectory concept type.
No foundational rewrite needed — just extension of existing foundations to
non-code domains.
