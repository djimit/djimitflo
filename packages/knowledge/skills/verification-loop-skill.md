---
type: Skill
title: "Verification Loop Skill"
description: "Runs maker/checker review plus deterministic gates for loop outputs."
tags: [skill, loop, verification, maker-checker]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [run_tests, run_lint, run_typecheck, run_security_scan, review_diff, emit_verdict]
actions_forbidden: [edit_maker_output_without_new_task, self_approve, merge, deploy, modify_policy]
gates: [tests_pass_when_applicable, lint_pass_when_applicable, no_secret_leak, diff_under_threshold, checker_verdict]
escalation: [high_security_finding, auth_sensitive_change, repeated_gate_failure, uncertain_verdict]
---

# Verification Loop Skill

## Purpose

Validate loop output with deterministic gates and independent checker review.

## Procedure

1. Confirm checker lease is different from maker lease.
2. Run deterministic gates required by the loop contract.
3. Review diff and artifacts against acceptance criteria.
4. Emit verdict: accepted, needs_revision, rejected or insufficient_evidence.
5. Block continuation if required gates fail.

## Output Contract

```yaml
verification:
  verdict: accepted | needs_revision | rejected | insufficient_evidence
  gates:
    - name: ""
      status: pass | fail | skipped
      evidence: ""
  checker_notes: ""
  required_next_action: stop | retry | revise | escalate
```

## Stop Condition

The skill stops when a verdict is emitted and all gate evidence is attached.
