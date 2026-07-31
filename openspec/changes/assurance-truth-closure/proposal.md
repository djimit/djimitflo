# Proposal: Assurance Truth Closure

## Goal

Turn the current local hardening result into a repeatable, autonomous certification pipeline whose claims never exceed its evidence.

The pipeline proves five independent layers:

1. source and dependency reproducibility;
2. route and function contract coverage;
3. Council, MCP and proof-run operational truth;
4. OpenMythos benchmark validity and provenance;
5. live integration and deployed-runtime identity.

## Problem

Local tests, type-check, lint and build pass, but ecosystem-wide certification is still blocked by facts outside those gates:

- the current shell uses unsupported Node 26 while the repository supports Node 20 through 24;
- live workstation integrations may be unavailable;
- the OpenMythos corpus has insufficient validated cases for a broad scientific claim;
- dependency audit findings can be reachable, unreachable or unfixable and need explicit adjudication;
- route registration count is not equivalent to executed contract coverage;
- a local checkout result does not prove which commit, database or configuration is deployed.

## Scope

- Add one read-only assurance command that emits a machine-readable report.
- Inventory every registered HTTP and MCP route/tool and link it to a contract test or explicit exception.
- Execute supported Node-version gates in CI.
- Validate OpenMythos corpus, oracle coverage, judge provenance, repeatability and held-out discrimination before accepting scores.
- Probe live integrations without starting, deploying or mutating them.
- Compare live runtime identity with the intended source revision and database identity.
- Make certification fail closed when required evidence is missing, stale or contradictory.

## Non-Goals

- No automatic deploy, merge, push or production restart.
- No automatic corpus promotion, durable-memory promotion or legal approval.
- No attempt to make unavailable external infrastructure look healthy.
- No new orchestration framework or duplicate health-check subsystem.
- No aggregate compliance score that hides failed mandatory gates.

## Acceptance

- One command produces `pass`, `fail` or `blocked`, never an ambiguous partial success.
- Every result contains source revision, timestamp, Node version, configuration hashes and evidence references.
- All registered routes and MCP tools are classified as tested, exempt with reason, or failing.
- OpenMythos scores are admissible only when corpus and judge gates pass.
- Live certification requires matching runtime identity and fresh probes.
- Human approval is requested only at deploy/restart, corpus promotion or other external mutation boundaries.
