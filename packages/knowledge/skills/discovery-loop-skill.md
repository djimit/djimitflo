---
type: Skill
title: "Discovery Loop Skill"
description: "Finds candidate work from repositories, docs, tests, logs, issues and memory without making mutations."
tags: [skill, loop, discovery, read-only]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [read_repo, read_docs, read_tests, read_logs, search_memory, propose_tasks]
actions_forbidden: [edit_files, spawn_mutating_workers, merge, deploy, modify_policy]
gates: [read_only_only, evidence_paths_present, candidate_tasks_bounded]
escalation: [secret_boundary_detected, auth_boundary_detected, excessive_scope]
---

# Discovery Loop Skill

## Purpose

Discover small, bounded work items without changing code or state.

## Procedure

1. Read declared context sources only.
2. Collect evidence paths and exact failure signals.
3. Group findings by loop suitability: closed-loop, open-loop research, human-only.
4. Rank candidates by risk, reproducibility and verification cost.
5. Emit candidate tasks for planning.

## Output Contract

```yaml
discovery:
  candidates:
    - title: ""
      evidence: []
      suggested_loop_mode: closed | open | human_only
      risk_class: low | medium | high | critical
      verification_hint: []
```

## Stop Condition

The skill stops after producing bounded candidates or when the search budget is exhausted.
