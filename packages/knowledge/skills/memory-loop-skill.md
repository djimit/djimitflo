---
type: Skill
title: "Memory Loop Skill"
description: "Writes loop state, decisions, risks, failures, lessons and next steps to durable project memory."
tags: [skill, loop, memory, okf]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [write_loop_state, write_decision, write_risk, propose_lesson, update_okf_draft]
actions_forbidden: [approve_policy_rule, overwrite_audit, delete_memory, store_secrets]
gates: [no_secrets, provenance_present, trust_level_assigned]
escalation: [policy_rule_requested, secret_detected, conflicting_memory]
---

# Memory Loop Skill

## Purpose

Persist loop state outside chat so long-running runs can resume and be audited.

## Procedure

1. Record current loop state and step status.
2. Record decisions and evidence paths.
3. Record risks, blockers and next actions.
4. Propose operational lessons with `trust_level: proposed`.
5. Escalate engineering or policy rules for review.

## Output Contract

```yaml
memory_update:
  loop_id: ""
  state_file: ""
  decisions: []
  risks: []
  lessons_proposed: []
  next_actions: []
  trust_level: proposed | validated | approved
```

## Stop Condition

The skill stops when loop state is durable and no secrets or unreviewed policy changes were stored.
