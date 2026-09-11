# G284 assurance recheck

- `audit:ci`: PASS (no unaccepted high/critical production advisories).
- `assurance:integrations`: PASS.
- `assurance:truth`: FAIL / fail-closed (exit 1) because `openmythos_evidence`, `live_identity` and `browser_session` remain unavailable.
- No production authentication, provider execution, merge or deployment was performed.

Evidence: [truth log](assurance-truth-g284.log), [route proof](task-approval-cancel-route-g284.md).
