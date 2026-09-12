# G286 assurance recheck

- `assurance:integrations`: PASS.
- `assurance:truth`: FAIL / fail-closed (exit 1) because `openmythos_evidence`, `live_identity` and `browser_session` remain unavailable.
- Runtime route inventory was regenerated after the memory relation validation fix; 619 registrations and 610 anonymous auth probes pass.
- No production authentication, provider execution, merge or deployment was performed.

Evidence: [truth log](assurance-truth-g286.log), [route inventory](route-inventory-runtime-g286.json), [memory proof](memory-routes-chain-g285.md).
