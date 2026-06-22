## Djimit Governance Gate — Approval Check (Pre-Execution)

Before executing any tasks, you MUST perform the following approval gate check:

1. **Read tasks.md** and scan every task for an `Execution Surface` field.

2. **Categorize tasks**:
   - `host:macbook` — safe to execute locally without additional approval
   - `ssh:<device>` — REQUIRES explicit user approval before execution
   - `docker:sandbox` — REQUIRES explicit user approval before execution
   - Any task that touches production (even with `host:macbook`) — REQUIRES
     explicit user approval before execution
   - Tasks without an Execution Surface field — treat as `host:macbook` (default)

3. **If any task requires approval**:
   - List the approval-gated tasks with their Execution Surface
   - STOP and ask: "The following tasks require approval before execution:
     [list]. Do you approve execution of these tasks? (yes/no)"
   - Wait for explicit user response
   - If user says "no" or "wait" or "stop": skip those tasks, proceed with
     only the approved tasks
   - If user says "yes" or "proceed" or "approve": proceed with all tasks

4. **Security baseline check**:
   - Verify no task will log API keys, tokens, or credentials
   - Verify no task will read `auth.json`, `.env`, or private keys
   - Verify `trash` is used instead of `rm` for any file removal
   - If any violation is detected, STOP and warn the user

5. **After the gate passes**, proceed to the core implement workflow below.

---

{CORE_TEMPLATE}
