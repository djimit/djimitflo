---
type: Skill
title: "Planning Loop Skill"
description: "Decomposes goals into loop runs, task slices, agent roles, worktree strategy, gates and stop conditions."
tags: [skill, loop, planning, decomposition]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [read_goal, read_discovery, propose_plan, assign_roles, propose_gates]
actions_forbidden: [edit_files, spawn_workers_without_policy, merge, deploy, modify_policy]
gates: [stop_conditions_present, maker_checker_defined, deterministic_gates_defined]
escalation: [missing_done_criteria, high_risk_scope, unresolved_dependency]
---

# Planning Loop Skill

## Purpose

Convert a goal into executable loop runs with explicit roles and verification.

## Procedure

1. Decompose the goal into independent slices.
2. Choose loop mode for each slice.
3. Assign maker, checker, security, memory and governance roles.
4. Define worktree isolation and branch prefix.
5. Define deterministic gates and human gates.
6. Emit a loop plan for `/loop start`.

## Output Contract

```yaml
loop_plan:
  loop_name: ""
  mode: closed | open
  slices: []
  agents:
    makers: []
    checkers: []
    security_checkers: []
    memory_curator: ""
    governance_guard: ""
  workspace:
    isolation: git_worktree
    branch_prefix: agent/loop/
  gates: []
  stop_conditions: []
```

## Stop Condition

The skill stops when every slice has a role assignment, gate and stop condition.
