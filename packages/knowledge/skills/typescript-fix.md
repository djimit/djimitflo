---
type: Skill
title: "TypeScript Fix Procedure"
description: "Step-by-step procedure for fixing TypeScript code issues: type errors, missing imports, null guards, and lint violations."
tags: [skill, typescript, fix, code]
status: validated
trust_level: validated
timestamp: 2026-06-28T00:00:00Z
capability_id: typescript-fix
actions_allowed: [spawn_runtime_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy]
precondition: "Finding is in a .ts or .tsx file"
expected_effect: "TypeScript type error or lint violation is resolved"
evidence_schema: "Diff + tsc --noEmit passes + lint passes"
removal_strategy: "demote_on_fail"
---

# TypeScript Fix Procedure

## Steps

1. **Read the finding** — understand what type error, missing import, or lint violation is reported
2. **Open the file** — locate the exact line and column from the finding
3. **Analyse the type** — determine what type is expected vs what is provided
4. **Apply the minimal fix**:
   - Type error → add proper type annotation or cast
   - Missing import → add the import statement
   - Null guard → add `if (!value) return` or optional chaining `?.`
   - Lint violation → fix according to the lint rule
5. **Verify locally** — run `tsc --noEmit` on the package to confirm the type error is resolved
6. **Keep the diff small** — one change, one file, minimal lines

## Rules

- Do not refactor unrelated code
- Do not change the public API
- Do not add new dependencies
- Keep the diff under 10 lines
