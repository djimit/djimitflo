---
description: Validate that plan.md and tasks.md contain required governance fields
  from the djimit preset
---


<!-- Extension: djimit-governance -->
<!-- Config: .specify/extensions/djimit-governance/ -->
# Governance Check

Validates that the feature's plan.md and tasks.md contain the governance fields
required by the djimit preset. Run after `/speckit.plan` or `/speckit.tasks` to
catch missing governance fields before implementation.

## User Input

```text
$ARGUMENTS
```

## Steps

1. **Locate the feature directory**: Read `.specify/feature.json` to find the
   active feature directory. If not found, scan `specs/` for the most recent
   feature directory.

2. **Check plan.md governance fields** (if plan.md exists):

   Verify these sections are present:
   - `## Security Impact` — describes attack surface introduced or expanded
   - `## Privacy Impact` — describes user/engagement data generated or exposed
   - `## Threat Model Delta` — lists new threat vectors and mitigations
   - `## Rollback Strategy` — describes how to undo the feature's changes

   For each section:
   - ✅ PASS if the section heading exists AND contains substantive content
     (not just the template placeholder text)
   - ❌ FAIL if the section is missing or contains only placeholder text

3. **Check tasks.md governance fields** (if tasks.md exists):

   Verify that EVERY task entry includes:
   - `**Validation**:` — how to verify the task succeeded
   - `**Rollback**:` — command to undo the task's changes
   - `**Execution Surface**:` — `host:macbook`, `ssh:<device>`, or `docker:sandbox`

   Count:
   - Total tasks (lines matching `- [ ] T` or `- [X] T`)
   - Tasks with Validation field
   - Tasks with Rollback field
   - Tasks with Execution Surface field

   A task is compliant only if ALL three fields are present.

4. **Check constitution compliance** (if constitution.md exists):

   Verify:
   - Contains "Runtime Awareness" section
   - Contains "Security Baseline" section
   - Does NOT contain "Library-First" as a mandatory/hard rule
   - Contains "approval" in the context of gating

5. **Generate report**:

   ```text
   ═══════════════════════════════════════════════════════
   GOVERNANCE CHECK REPORT
   Feature: [feature directory]
   Date: [today]
   ═══════════════════════════════════════════════════════

   Plan.md:
     Security Impact:     ✅ PASS / ❌ FAIL
     Privacy Impact:      ✅ PASS / ❌ FAIL
     Threat Model Delta:  ✅ PASS / ❌ FAIL
     Rollback Strategy:   ✅ PASS / ❌ FAIL

   Tasks.md:
     Total tasks:         [N]
     Tasks with Validation:      [N] / [N]
     Tasks with Rollback:         [N] / [N]
     Tasks with Execution Surface: [N] / [N]
     Compliance:          ✅ ALL COMPLIANT / ❌ [N] NON-COMPLIANT

   Constitution:
     Runtime Awareness:   ✅ PASS / ❌ FAIL
     Security Baseline:   ✅ PASS / ❌ FAIL
     Library-First relaxed: ✅ PASS / ❌ FAIL
     Approval gates:      ✅ PASS / ❌ FAIL

   ═══════════════════════════════════════════════════════
   OVERALL: ✅ ALL CHECKS PASS / ❌ [N] CHECKS FAILED
   ═══════════════════════════════════════════════════════
   ```

6. **If any checks fail**:
   - List the specific failures with file and section
   - Suggest the corrective action (e.g., "Add ## Security Impact section to
     plan.md" or "Add **Validation**: field to task T003")
   - Ask the user whether to auto-fix or proceed manually

## Done When

- [ ] Plan.md governance sections verified (or plan.md doesn't exist yet)
- [ ] Tasks.md per-task fields verified (or tasks.md doesn't exist yet)
- [ ] Constitution compliance verified
- [ ] Report generated and shown to user
- [ ] Failures (if any) listed with corrective actions