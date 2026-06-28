---
type: Skill
title: "Test Writing Procedure"
description: "Step-by-step procedure for writing tests: unit tests, integration tests, and edge case coverage."
tags: [skill, test, testing, vitest]
status: validated
trust_level: validated
timestamp: 2026-06-28T00:00:00Z
capability_id: test-write
actions_allowed: [spawn_runtime_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy]
precondition: "Finding mentions test, spec, or coverage"
expected_effect: "Test is written and passes"
evidence_schema: "Diff + test passes + coverage increases"
removal_strategy: "demote_on_fail"
---

# Test Writing Procedure

## Steps

1. **Read the finding** — understand what needs to be tested
2. **Identify the test framework** — check package.json for vitest, jest, etc.
3. **Write the test**:
   - Import the function/class to test
   - Set up the test environment (in-memory DB, mocks, etc.)
   - Write test cases: happy path, edge cases, error cases
   - Use descriptive test names (`it('does X when Y')`)
4. **Run the test** — `npm run test -- <test-file>`
5. **Verify it passes** — all test cases green
6. **Keep the diff focused** — only add the test file, don't change source code

## Rules

- Tests must be deterministic (no flaky tests)
- Use in-memory databases, not real ones
- Mock external services (API calls, file system when needed)
- Follow existing test patterns in the codebase
- One test file per feature
