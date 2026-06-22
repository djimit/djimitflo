---

## Per-Task Governance Fields (Djimit Preset)

Every task in the generated tasks.md MUST include these three fields after the
task description:

- **Validation**: How to verify this task succeeded (command, test, or manual check)
- **Rollback**: Command to undo this task's changes
- **Execution Surface**: Where this task runs — one of:
  - `host:macbook` — local execution on the MacBook cockpit (default for code edits, tests, linting)
  - `ssh:<device>` — remote execution via SSH (e.g., `ssh:workstation`, `ssh:macmini`)
  - `docker:sandbox` — execution inside a Docker container (approval-gated)

### Example task with governance fields:

```markdown
- [ ] T001 [P] [US1] Create User model in src/models/user.ts
  - **Validation**: `npm test -- --run src/models/user.test.ts` passes
  - **Rollback**: `git checkout -- src/models/user.ts`
  - **Execution Surface**: host:macbook
```

### Approval gating

Tasks with Execution Surface `ssh:*` or `docker:sandbox` MUST NOT be executed
without explicit user approval. The implement command wrapper enforces this gate.
Tasks touching production MUST NOT be executed without explicit user approval
regardless of Execution Surface.
