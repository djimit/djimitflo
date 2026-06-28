---
type: Skill
title: "Security Audit Procedure"
description: "Step-by-step procedure for auditing and fixing security issues: hardcoded secrets, injection vulnerabilities, and access control gaps."
tags: [skill, security, audit, fix]
status: validated
trust_level: validated
timestamp: 2026-06-28T00:00:00Z
capability_id: security-audit
actions_allowed: [spawn_runtime_worker, create_worktree, run_allowed_commands, collect_artifacts]
actions_forbidden: [self_approve, direct_merge, deploy, modify_secrets, modify_policy]
precondition: "Finding mentions security, auth, secret, or vulnerability"
expected_effect: "Security issue is resolved or mitigated"
evidence_schema: "Diff + secret scan passes + security checker verdict"
removal_strategy: "demote_on_fail"
---

# Security Audit Procedure

## Steps

1. **Read the finding** — understand the security issue (hardcoded secret, injection, access control)
2. **Open the file** — locate the vulnerable code
3. **Assess the severity** — determine if it's critical, high, medium, or low
4. **Apply the fix**:
   - Hardcoded secret → replace with environment variable
   - Injection → sanitize input, use parameterized queries
   - Access control → add authentication/authorization check
5. **Verify** — run secret scan (gitleaks) and confirm the secret is gone
6. **Keep the diff small** — fix only the security issue, nothing else

## Rules

- Never commit secrets in the diff
- Never disable security checks
- Always use environment variables for secrets
- Report the severity in the checker verdict
