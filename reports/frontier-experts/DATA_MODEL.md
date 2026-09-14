# Frontier Expert Intelligence — Data model

Migration: `createFrontierExpertTables()` in `packages/server/src/database/migrate.ts` (idempotent `CREATE TABLE IF NOT EXISTS`, called from `runMigrations`). Service: `packages/server/src/services/frontier-expert-registry-service.ts`. Feature flag: `DJIMITFLO_FRONTIER_EXPERTS_ENABLED=true` (`frontierExpertsEnabled()`), default off.

## Why new tables (spec §37)

| Existing | Why not reused as-is |
|---|---|
| `swarm_capabilities` | `kind` CHECK is limited to executable capabilities (skill, runtime_adapter, …) with schema refs and eval thresholds; expert capabilities are knowledge domains with evidence lineage. Different semantics, kept separate; the taxonomy can later be mirrored into `swarm_capabilities` for dispatch. |
| `knowledge_claims` | flat `agent_id/topic/claim/votes`; no subject/relation/object, polarity, temporal scope or claim relations (§17). |
| `agents` | operational agents, not people; mixing them would let an expert become an executing principal (zero-trust §49). |
| `memory_candidates` | reused unchanged as the governed promotion queue for swarm output (see EXPERT_SWARM_VERIFICATION_FIX.md). |

## Tables (ontology §5)

- **expert_capability_taxonomy** `id, label, description, parent_id, aliases_json` — §7 list seeded by `seedTaxonomy()`; hierarchy via `parent_id`; `resolveCapability()` matches id, label or alias.
- **expert_identities** `id, canonical_name, aliases_json, lifecycle_state (CHECK §9 states), identity_confidence [0..1], provenance_json, version` — one row per public professional identity.
- **expert_affiliations** `expert_id, organization, role, valid_from, valid_to, source_ref, retrieved_at, confidence` — temporal (§29); `affiliationsAsOf(expertId, at)`.
- **expert_evidence** `id = evidence:sha256(expert|kind|canonical_origin)[:32]` (deterministic, re-ingestion never duplicates), `kind (paper | institutional_page | technical_report | repository | presentation | profile | scholarly_metadata | secondary | signature | other)`, `tier (1..4)` derived from kind (§10), `source_family` (hostname) and `canonical_origin` for independence (§24), `lifecycle (active | superseded | retracted | challenged)` (§31). Rows are never updated except `lifecycle`.
- **expert_capabilities** `expert_id, capability_id, confidence, evidence_refs_json (CHECK non-empty), derived_by, status (inferred | checked | approved | revoked)`, unique per expert × capability. `inferCapability()` additionally requires every ref to exist for that expert, be `active`, and be of a kind in `CAPABILITY_EVIDENCE_KINDS` (never `signature`/`secondary`/`other`) — I01, I02.
- **expert_claims** `subject, relation, object, conditions, scope, polarity (asserts | denies | qualifies), temporal_scope, evidence_refs_json (CHECK non-empty), confidence, source_independence (distinct source families), support_status, criticality (normal | critical)` — §17.
- **expert_claim_relations** `from_claim_id, to_claim_id, relation (SUPPORTS | CONTRADICTS | QUALIFIES | ORTHOGONAL | UNDETERMINED), rationale, resolved_at, resolved_by` — unresolved CONTRADICTS on a critical claim blocks APPROVED/ACTIVE (I08).
- **expert_versions** `expert_id, version, snapshot_json, change_summary, created_at (ISO)` — a snapshot after every substantive change; `asOf(expertId, instant)` (I12, §30).
- **expert_lifecycle_events** `from_state, to_state, actor, reason, evidence_refs_json` — every transition, plus an `audit_events` record (`frontier_expert_<state>`).

## Lifecycle guards (`transition()`)

| Target | Guard |
|---|---|
| IDENTITY_RESOLVED / EVIDENCE_COLLECTED | `identity_confidence ≥ 0.8`, else `EXPERT_IDENTITY_AMBIGUOUS` (I03); EVIDENCE_COLLECTED needs ≥1 active evidence row |
| CAPABILITY_INFERRED / CHECKED / APPROVED / ACTIVE | ≥1 non-revoked capability whose refs still include active Tier-1/2 evidence (I01, I02) |
| APPROVED / ACTIVE | no unresolved critical contradiction (I08); approver ≠ last CHECKED actor (I06); actor not `system|ingestion|swarm|autopilot*` |
| any | only edges in the §9 state graph; REJECTED and REVOKED are terminal |

Retraction (`markEvidence(id, 'retracted' | 'superseded' | 'challenged')`) propagates: an ACTIVE/APPROVED expert with no remaining qualifying evidence becomes STALE; history stays.

## Evidence

`packages/server/src/__tests__/frontier-expert-invariants.test.ts` — 5 tests, all passing (`npx vitest run src/__tests__/frontier-expert-invariants.test.ts`), covering flag default, taxonomy + aliases, I01, I02, I03, I06, I07, I08, I12, §29 temporal affiliations, §31 retraction propagation, invalid transitions. Capability status: **PROVEN** for the data model and lifecycle guards; resolver, ingestion and enrichment are NOT_PROVEN yet (next goals).
