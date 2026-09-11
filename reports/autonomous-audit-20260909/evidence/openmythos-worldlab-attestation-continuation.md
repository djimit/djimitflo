# G78 — OpenMythos attestation and WorldLab retest intake

## Executed proof

- `OpenMythosAttestationService` validates the `djimit.openmythos.calibration.v1` schema, canonical SHA-256 attestation hash, completed evaluation-run identity, corpus hash and exact case counts before durable insert.
- The authenticated HTTP path proves anonymous rejection, admin import (`201`), persisted listing and tamper rejection (`400`) in `openmythos-attestation-http.test.ts`.
- `WorldLabEvidenceService` validates the retest envelope, goal/source-finding binding, four gate results and four evidence-reference namespaces, then records a deterministic retest and evidence-graph edges in one transaction.
- The authenticated WorldLab path proves a `PROMOTION_CANDIDATE` response with `promoted:false`; the goal remains unchanged (`created`). Promotion is deliberately not performed by intake.
- Route registration evidence is regenerated in [route-runtime-registration-g78.json](route-runtime-registration-g78.json): 614 instantiated API registrations, 608 auth-marked routes, 608/608 anonymous `401` denials, and no source/runtime drift.
- Contract evidence is regenerated in [contract-inventory-runtime-g78.json](contract-inventory-runtime-g78.json): 581 source routes, 251 contract-tested, 0 critical unclassified; 56 MCP tools, 28 tested.
- Regression evidence: server `2428 passed / 20 skipped`; integrated workspace `2715 passed / 20 skipped`; root build, type-check and lint pass; configured mutation scope `75/75` killed.

## Boundary and remaining truth gap

This closes the missing authenticated intake/integration seam; it does **not** certify OpenMythos. External producer identity, byte-level corpus/evidence resolution, independent repeatability, held-out evaluation, live deployment identity and promotion approval remain unavailable. `assurance:truth` therefore remains correctly `BLOCKED` until those prerequisites are supplied.

The retest endpoint is promotion-safe by construction: it records candidate evidence and graph provenance but cannot mutate a goal to promoted state or manufacture an assurance decision.
