# Design: Assurance Truth Closure

## Principle

Certification is a conjunction of mandatory gates, not an average. One failed mandatory gate makes the result `fail`; unavailable required external infrastructure makes it `blocked`. Informational findings cannot compensate for either state.

## Reuse

The implementation SHALL compose existing mechanisms:

- npm workspace test, type-check, lint and build scripts;
- Express router registration and existing route tests;
- MCP tool registration and server tests;
- runtime readiness and contract probes;
- `ProofRunService` and MCP doctor provenance;
- `OpenMythosEvalService`, corpus validator and oracle sidecar;
- existing Mission Control assurance payloads.

Only a thin report composer and missing contract checks may be added.

## Result Model

The report contains:

- `status`: `pass | fail | blocked`;
- `source`: commit, dirty-state digest and dependency-lock hash;
- `environment`: supported Node verdict and relevant tool versions;
- `gates[]`: id, mandatory, status, started/finished timestamps and evidence refs;
- `routes`: registered, tested, exempt and failing identities;
- `openmythos`: corpus/oracle hashes, case maturity, judge identity, repeatability and discrimination;
- `integrations`: requested endpoint, observed identity, freshness and blocked reason;
- `limitations[]` and `next_safe_action`.

Secrets, raw authorization headers and unrestricted model output SHALL NOT enter the report.

## Phases

### 1. Reproducible local baseline

Run install-from-lock, tests, type-check, lint, build and diff checks on Node 20, 22 and 24. Node 26 may run diagnostic checks but cannot certify the supported-runtime gate.

### 2. Contract inventory

Derive route and MCP identities from the actual registration surfaces. A route counts as covered only if a test executes its middleware/handler contract or it has a narrow documented exception. File import alone is not coverage.

### 3. Internal truth invariants

Verify stale MCP status handling, unbounded latest-proof selection, Council fail-closed review parsing, persistent aggregation, fast-mode semantics and OpenMythos fail-closed scoring.

### 4. OpenMythos scientific validity

Run corpus-schema validation and deterministic oracle gates first. Then run repeated subject evaluations only for cases meeting maturity requirements. Reject numeric claims when judge calls time out, provenance is incomplete, repeatability exceeds tolerance or held-out discrimination is absent.

### 5. External integration proof

Probe configured services read-only with bounded timeouts. Required integrations must return fresh contract evidence. Optional integrations may be reported as unavailable without being silently treated as passed.

### 6. Deployment identity

Compare intended commit and config hashes with live MCP doctor/health provenance, database identity and integrity check. A healthy endpoint with mismatching identity fails certification.

## Autonomy Boundary

The agent may autonomously inspect, test, build, create temporary repositories, query read-only endpoints and write local evidence. It SHALL pause for approval before deploy, restart, push, merge, changing secrets, promoting benchmark cases or mutating production data.

## Removal Strategy

When the general proof-run service exposes all report fields and route coverage, delete the thin composer and retain only the contracts and tests.
