# G287 assurance recheck

- `assurance:integrations`: PASS.
- `assurance:truth`: FAIL / fail-closed (exit 1) because `openmythos_evidence`, `live_identity` and `browser_session` remain unavailable.
- Fresh runtime route registration remains 619/619 with 610/610 anonymous auth probes.
- No production authentication, provider execution, merge or deployment was performed.

Evidence: [truth log](assurance-truth-g287.log), [observability proof](observability-route-g287.md).
