---
type: Skill
title: "Python Fix Procedure"
description: "Step-by-step procedure for fixing Python code issues: type errors, import errors, syntax issues, and lint violations."
tags: [skill, python, fix, code]
status: validated
trust_level: validated
timestamp: 2026-06-28T00:00:00Z
capability_id: python-fix
actions_allowed: [spawn_runtime_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy]
precondition: "Finding is in a .py file"
expected_effect: "Python error or lint violation is resolved"
evidence_schema: "Diff + python -m py_compile passes + lint passes"
removal_strategy: "demote_on_fail"
---

# Python Fix Procedure

## Steps

1. **Read the finding** — understand what error or violation is reported
2. **Open the file** — locate the exact line from the finding
3. **Analyse the error** — determine the root cause (type, import, syntax, logic)
4. **Apply the minimal fix**:
   - Import error → add the import
   - Type error → add type hint or fix the type
   - Syntax error → fix the syntax
   - Lint violation → fix according to the lint rule (flake8, pylint)
5. **Verify locally** — run `python -m py_compile <file>` to confirm
6. **Keep the diff small** — one change, one file, minimal lines

## Rules

- Do not refactor unrelated code
- Do not change the public API
- Do not add new dependencies
- Keep the diff under 10 lines
