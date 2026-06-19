---
type: Skill
title: "Goal Intake Loop Skill"
description: "Normalizes broad operator goals into measurable Djimitflo goals with constraints, acceptance criteria, budget and risk class."
tags: [skill, loop, goals, planning]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [read_context, propose_goal, classify_risk]
actions_forbidden: [spawn_workers, edit_files, merge, deploy, modify_policy]
gates: [acceptance_criteria_present, risk_class_assigned, budget_assigned]
escalation: [ambiguous_goal, missing_acceptance_criteria, high_risk_scope]
---

# Goal Intake Loop Skill

## Purpose

Turn a broad request into a Djimitflo goal that can be decomposed and verified.

## Procedure

1. Extract the operator objective.
2. Identify constraints, repositories, context sources and risk areas.
3. Require measurable acceptance criteria.
4. Assign initial risk class and budget.
5. Emit a goal draft for `/goals`.

## Output Contract

```yaml
goal:
  objective: ""
  constraints: []
  acceptance_criteria: []
  risk_class: low | medium | high | critical
  budget:
    max_workers: 0
    max_runtime_minutes: 0
    max_retries: 0
  recommended_loop: ""
  escalation_required: false
```

## Stop Condition

The skill stops when the goal is measurable enough for decomposition or escalates because the objective is too ambiguous.
