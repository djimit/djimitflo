---

## Security Impact

What attack surface does this feature introduce or expand? Consider:
- New endpoints or inputs that could be abused
- Authentication/authorization changes
- Data exposure or leakage paths
- Dependency on external services that could be compromised

[Describe the security impact. If none, state "No new attack surface" with rationale.]

## Privacy Impact

What user, engagement, or operational data is generated, stored, or exposed by
this feature?

[Describe privacy impact. If none, state "No new data exposure" with rationale.]

## Threat Model Delta

What new threat vectors does this feature introduce? How are they mitigated?

| Vector | Mitigation |
|--------|------------|
| [e.g., unauthenticated endpoint] | [e.g., JWT middleware + rate limiting] |

If no new vectors: "No threat model delta — feature operates within existing
trust boundaries."

## Rollback Strategy

How to undo this feature's changes if needed:

- **Code rollback**: `git revert <commit> && git clean -fd`
- **Data rollback**: [e.g., migration down, SQLite restore, etc. or N/A]
- **Config rollback**: [e.g., revert config changes, etc. or N/A]
- **Full rollback command**: [single command that restores pre-feature state]
