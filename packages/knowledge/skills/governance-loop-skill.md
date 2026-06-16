---
type: Skill
title: "Governance Loop Skill"
description: "Controls autonomy, approvals, risk gates, budgets and escalation for Djimitflo control loops."
tags: [skill, loop, governance, policy]
status: draft
trust_level: proposed
timestamp: 2026-06-16T00:00:00Z
actions_allowed: [classify_risk, enforce_budget, require_approval, stop_loop, escalate]
actions_forbidden: [auto_approve_high_risk, weaken_policy, deploy, modify_secrets, bypass_gate]
gates: [risk_classified, budget_checked, approval_required_when_high_risk, audit_event_written]
escalation: [high_risk_change, policy_change_requested, budget_exhausted, repeated_failure]
---

# Governance Loop Skill

## Purpose

Keep loop autonomy bounded and auditable.

## Procedure

1. Classify risk for each goal, loop and step.
2. Enforce action permissions and budgets.
3. Require human approval for high-risk scopes.
4. Stop or escalate loops that exceed thresholds.
5. Write audit events for governance decisions.

## Output Contract

```yaml
governance_decision:
  decision: allow | require_approval | deny | stop | escalate
  reason: ""
  risk_class: low | medium | high | critical
  budget_status: ok | exhausted | near_limit
  approval_required: false
```

## Stop Condition

The skill stops when it has issued an explicit decision for the proposed loop action.
