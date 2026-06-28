---
type: Skill
title: "Documentation Update Procedure"
description: "Step-by-step procedure for updating documentation: README, JSDoc, inline comments, and API docs."
tags: [skill, documentation, docs, update]
status: validated
trust_level: validated
timestamp: 2026-06-28T00:00:00Z
capability_id: docs-update
actions_allowed: [spawn_runtime_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy]
precondition: "Finding mentions documentation, README, comment, or JSDoc"
expected_effect: "Documentation is updated or added"
evidence_schema: "Diff + docs render correctly"
removal_strategy: "demote_on_fail"
---

# Documentation Update Procedure

## Steps

1. **Read the finding** — understand what documentation is missing or outdated
2. **Locate the target** — find the file that needs documentation
3. **Write the documentation**:
   - JSDoc → add `/** ... */` above the function/class
   - README → update the relevant section
   - Inline comment → add `//` explanation for complex logic
   - API docs → document the endpoint, parameters, and response
4. **Keep it accurate** — the docs must match the actual code behavior
5. **Keep the diff small** — only add documentation, don't change code

## Rules

- Documentation must be accurate (matches code behavior)
- Use clear, concise language
- Follow existing documentation style
- Do not change code logic — only add documentation
