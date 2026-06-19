---
type: Skill
title: "Execution Loop Skill"
description: "Coordinates bounded Codex/OpenCode maker workers in isolated worktrees under an approved loop plan."
tags: [skill, loop, execution, workers]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [spawn_approved_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy, delete_data]
gates: [approved_loop_plan, budget_available, worktree_isolated, policy_allows_action]
escalation: [budget_exhausted, policy_denied, repeated_failure, unexpected_diff_scope]
---

# Execution Loop Skill

## Purpose

Run maker workers for bounded tasks while preserving isolation, budget and auditability.

## Procedure

1. Confirm the loop plan is approved for execution.
2. Lease maker workers within concurrency and budget limits.
3. Allocate one worktree per mutating maker task.
4. Run only allowed commands.
5. Capture outputs, diffs, artifacts and errors.
6. Hand off to verification.

## Output Contract

```yaml
execution_result:
  worker_id: ""
  task_id: ""
  worktree: ""
  branch: ""
  artifacts: []
  diff_summary: ""
  status: completed | failed | cancelled
  next_required_step: verify | retry | escalate
```

## Stop Condition

The skill stops when maker output is ready for independent verification, fails within retry budget, or escalates.
