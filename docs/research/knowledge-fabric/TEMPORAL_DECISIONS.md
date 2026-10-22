# DKF-EVOLUTION-001: temporal knowledge and decisions (Phase D, design only)

This is a design document. No schema change, migration or backfill has been made. Causal attribution (why an outcome
happened) belongs to `causal-evolution-003`, which a sibling agent is working on. This file covers only *what was known,
claimed and decided, and when*.

## 1. What exists today (evidence in CURRENT_STATE.md §2.2)

| Table | Temporal columns | Relations | Rows (prod 2026-10-22) |
|---|---|---|---|
| `swarm_claims` (`S/database/migrate.ts:1089-1110`) | `created_at`, `updated_at`, **`valid_until`**, **`invalidated_by`** (self FK) | `supports_ref`, `contradicts_ref`; `claim_type` CHECK already includes `'decision'` and `'policy'` | 400, last written 2026-09-13 |
| `expert_claims` (`migrate.ts:2077`) | `created_at`; free-text `temporal_scope` (empty on all 2 265 rows) | SPO + `polarity` (asserts / qualifies / denies) + `support_status` | 2 265 (2 263 `undetermined`) |
| `expert_claim_relations` (`migrate.ts:2096`) | `created_at`, `resolved_at`, `resolved_by` | `relation` (SUPPORTS / CONTRADICTS / …), `rationale` | 1 (CONTRADICTS, unresolved since 2026-09-27) |
| `expert_affiliations` (`migrate.ts:2031-2041`) | **`valid_from`**, **`valid_to`**, `retrieved_at`, plus the codebase's only as-of query, `affiliationsAsOf` (`frontier-expert-registry-service.ts:176`) | — | 0 since persons → areas |
| `expert_evidence` (`migrate.ts:2045-2057`) | `lifecycle` active / superseded / retracted / challenged, `retrieved_at` | — | 15 197 |
| `swarm_evidence_edges` (`migrate.ts:1119`) | `created_at` | `from_ref`, `to_ref`, `relation`, `metadata` | 13 589 (6 942 in 30 d) |
| `approvals` (`S/database/schema.ts:266`) | `decided_at`, `approved_at`, `denied_at`, `expires_at` | — | 509 |
| `authority_events` (`migrate.ts:1290`) | `occurred_at`, append-only | actor_type human / agent / service / ci | 1 246 |
| `judgments` | `created_at`, `provenance_json` (policy, prompt and evaluator version, input digest) | `subject_type` / `subject_id` | 19 924 |
| `kb_pages`, `memory_candidates`, OKF files, `knowledge_claims`, `central_memories` | none (only created / updated) | — | — |

Conclusion: the pieces of a bitemporal model already exist, scattered across four tables:

- valid-time intervals: `expert_affiliations`;
- invalidation chains: `swarm_claims`;
- lifecycle states: `expert_evidence`;
- typed relations with resolution: `expert_claim_relations`;
- an append-only transaction log: `authority_events`.

No knowledge unit carries all of them, and nothing joins a decision to its rationale.

## 2. Bitemporal claim model (reuse `swarm_claims`; no new table)

There are two time axes, as in the SQL:2011 bitemporal pattern:

- **Valid time** `[valid_from, valid_to)`: when the claim is true in the world. For example, "Paperclip is the work
  control plane" was valid until 2026-09-21.
- **Transaction time** `[recorded_from, recorded_to)`: when Djimitflo believed it. `recorded_from` = `created_at`.
  `recorded_to` = the `created_at` of the row that invalidated it (`invalidated_by`).

Mapping onto `swarm_claims`. Columns marked + are new, nullable and flag-gated. A first version can keep them inside
`metadata` JSON with no migration at all.

| Concept | Column |
|---|---|
| claim id, text | `id`, `claim` |
| subject / predicate / object | `subject_ref`, `predicate`, `object` (same SPO shape as `expert_claims`) |
| kind | `claim_type`: observation / decision / policy / hypothesis / … (already in the CHECK) |
| valid_from | + `valid_from` (first version: `metadata.valid_from`) |
| valid_to | `valid_until` (exists) |
| recorded_from | `created_at` (exists) |
| recorded_to | derived: `created_at` of the row in `invalidated_by` (exists) |
| supersession | `invalidated_by` = the newer claim (exists). The edge `supersedes` sits in `swarm_evidence_edges` |
| evidence | `evidence_refs_json` (exists): ADR path#section, PR number, commit, plan anchor, judgment ids, NE id |
| confidence / status | `confidence`, `status` (exist). `status` follows a lifecycle, not a trust score |
| link to knowledge | + `metadata.okf_concept_id` (the OKF concept that states the claim) |

**Rules:**

1. **Append-only.** Never UPDATE `claim`, `object` or `valid_*` in place. A correction is a new row plus `invalidated_by`
   on the old one. This is the only way transaction time stays reconstructible.
2. A row with `valid_from` unknown keeps `valid_from = NULL` with `metadata.valid_from_reason`. **Unknown is never "now"
   and never 0** (builder preamble).
3. **As-of queries** follow the `affiliationsAsOf` pattern:
   - "what did we believe at T": `created_at ≤ T AND (invalidator.created_at IS NULL OR invalidator.created_at > T)`;
   - "what was true at T": `valid_from ≤ T AND (valid_until IS NULL OR valid_until > T)`.

   Arm D (EVALUATION_PROTOCOL.md) needs only these two predicates.
4. **OKF side.** A knowledge page states validity in `djimit.valid_from` / `djimit.valid_to` and supersession in
   `djimit.supersedes`. The claim row is derived from the page, never the reverse. The vault stays the system of record
   for knowledge; `swarm_claims` stays the system of record for decisions.

## 3. Contradiction classes

A contradiction is **surfaced, never auto-resolved**. Each one gets a `contradicts` edge with `metadata.class`. Resolution
needs a human: `resolved_by` must be `human:<id>`, following OKF v0.2's actor convention and the S14/S17 lessons.

| Class | Definition | Detection (deterministic first) | Real example found in this audit |
|---|---|---|---|
| **K1 Direct** | Same subject and predicate, incompatible objects, overlapping valid time | SPO match plus interval overlap | `expert_claim_relations`: 1 CONTRADICTS, "opposite polarity on the same subject and object from a different source" (2026-09-27, unresolved) |
| **K2 Succession** | Same subject and predicate, different objects, **non-overlapping** validity | Interval check. Not a contradiction: record `supersedes` | Paperclip → Djimitflo as work plane (§4.1) |
| **K3 Policy vs practice** | A documented rule versus the observed runtime configuration or behaviour | Compare policy claims with flag and runtime observations | ADR 0002 rule 1 ("promotion to enforce needs measured agreement") vs `TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=enforce` with 0 labels (§4.2) |
| **K4 Doc vs runtime drift** | A doc or inventory claims a state that the runtime contradicts | A probe result against the documented claim | L3 graph `ws.kbwiki_maintenance` ACTIVE, while the crons never start (CURRENT_STATE §1.2). AGENTS.md (roborev) still maps events to Paperclip agents after ADR 0001 |
| **K5 Replica divergence** | Two copies of one store disagree | Count or hash comparison | Qdrant `djimit_okf` 25 581 (workstation) vs 30 575 (agenticservices). NAS wiki snapshot (2026-07-01) vs vault (2026-09-12) |
| **K6 Conditional / scope** | Both are true under different conditions | `polarity = qualifies`, or a differing `scope` | 122 `expert_claims` with `qualifies` |
| **K7 Measurement disagreement** | Two measurements of one quantity differ beyond noise | Same metric id, different value, same window | Plan 27-09 "prod OKF 129 docs" vs 413 today. That is K2 (growth), not an error, which shows why `as_of` is mandatory on every measurement claim |

Detection order: K5, K4, K3, K2, K1, K6, K7. The first four are mechanical (counts, flags, intervals). K1 and K6 need
claim extraction, which is out of scope for the first slice.

## 4. Decision reconstruction from real artefacts

Each decision is reconstructed only from cited artefacts. Every field that no artefact states is **UNKNOWN**, not
inferred.

### 4.1 D-0001: Djimitflo replaces Paperclip as the work control plane

| Field | Value | Source |
|---|---|---|
| Question | Which system owns work intake, approvals, execution and audit? | ADR 0001 §Context |
| Options considered | (a) keep Paperclip as the work plane and Djimitflo as the execution plane; (b) retire Paperclip and make Djimitflo the core | ADR 0001 §Context/§Decision. Other options: UNKNOWN (not recorded) |
| Chosen | (b), in 4 phases: freeze intake → archive → read-only 14–30 days → remove | ADR 0001 §Decision |
| Decided by / at | operator, accepted 2026-09-21 | ADR 0001 status line |
| Implemented by | PR #305 (`1f14fa98`, merged 2026-09-21 11:52Z): phase 1 | `gh pr view 305`; `git log docs/adr` |
| Rationale (as recorded) | idle: 1 issue in 24 h, bridge timer dead since 2026-09-14. Fragile: Postgres on `100.77.58.72:5433`, 10 306 `CONNECT_TIMEOUT` in 24 h. Duplicated: two task ledgers and two approval gates, so an approval lapsed unseen | ADR 0001 §Context |
| Evidence artefacts | NAS `vps-backups/paperclip-retirement-20260921/` (3.1 G, listing only); Phase L3 aggregates (930 issues, 33 human approvals) | CURRENT_STATE §1.1; plan Phase L |
| Valid time | from 2026-09-21 | ADR status line; AGENTS.md "op 2026-09-21 uitgezet" |
| Supersedes | "Paperclip is the work control plane" (roborev → Paperclip → Djimitflo) | ADR 0001 §Context |
| Exit criteria for phases 3–4 | one verified end-to-end run; daily approval review; operator inspection of agents; no unknown consumer during 14–30 days read-only | ADR 0001 §Exit criteria |
| **Were the exit criteria met before removal?** | **UNKNOWN.** The archive directory is dated 2026-09-21, and AGENTS.md states the service was switched off and removed on 2026-09-21. That is the same day as acceptance, so the 14–30 day read-only period of phase 3 cannot have passed. Why the phases were compressed is **UNKNOWN**: no artefact found | K3 candidate (decision vs practice) |
| Open contradiction | roborev AGENTS.md still maps events to "Paperclip agents" (CodexEngineer, CTO, FleetMaintainer) | K4 |

### 4.2 D-0002: `kb_passage_relevance` acts (enforce) on KB passages before the panel

| Field | Value | Source |
|---|---|---|
| Question | Should a jev relevance judgment drop retrieved KB pages before they reach the kimi-k3 panel? | plan R2 / PR #520 |
| Options | shadow (record only) / enforce (drop < 0.5) | `S/services/kb-corpus.ts:98-112`; `judgment-service.ts:26` |
| Chosen | enforce | prod env `TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=enforce` (read 2026-10-22) |
| Implemented by | PR #520 "jev reads retrieved KB pages before they reach the panel" (merged 2026-09-28 19:11Z). Flag set at deploy `64344ad8` (28-09 21:22Z, backup `.bak-20260928d`) | `gh pr view 520`; plan 0b |
| Decided by / at | The operator approved "Phase S" and its "cost levers" (#518, #519, #520 with enforce) on 2026-09-28 at about 21:0x | plan "Phase S approved (28-09 21:0x)" |
| Effective (valid time) | first enforce row 2026-09-29T12:45:08Z | prod `judgments` (min created_at) |
| Rationale (as recorded) | "kb_retrieval hits are weak (cos 0.31–0.33); shorter, better panel prompts", filed as a **cost** lever | plan R2 row |
| Governing policy | ADR 0002 rule 1: "Promotion to enforce needs measured agreement against real outcomes and an operator decision" | ADR 0002 §Decision |
| Measured agreement at the time | none. Today: 0 labels, 88 of 452 page verdicts dropped | prod; draft #961 |
| **Did the operator knowingly waive rule 1?** | **UNKNOWN.** The approval covered "cost levers", and no artefact says rule 1 was waived | K3 (policy vs practice) |
| Pending evidence | E-KB (#961): ≈ 188 labels, retain or retire by a pre-stated rule | `docs/research/jev-evolution/DECISION_EXPERIMENT_PLAN.md` (draft) |
| Rollback | one env line: `…_MODE=shadow` (`gatePassages` then keeps every page) | #961 O1 |

### 4.3 D-0003: Frontier Experts model areas, not people

| Field | Value | Source |
|---|---|---|
| Question | Should Frontier Experts represent individual people? | plan FE row |
| Chosen | fields or areas of interest; remove people together with their history | plan "Operator 06-10"; PR #669 title |
| Decided by / at | operator, 2026-10-06 ("rewrite the Frontier Experts to fields/areas of interest so no people are offended; fix all history"). It supersedes the earlier FE1 "park persons" decision | plan FE row |
| Implemented by | PR #669 (merged 2026-10-06 09:34Z) behind `FRONTIER_EXPERT_PERSONS_ENABLED` (default false); migration applied 2026-10-14 17:13Z with backup `/data/fe-areas-backup-20261014T171323Z.sqlite` | `gh pr view 669`; plan |
| Valid time vs transaction time | decided 2026-10-06, effective in data 2026-10-14. **This is the bitemporal case in miniature**: between the two dates the decision was in force while the data still said "persons" | plan |
| Rationale (as recorded) | avoid offending people | plan quote |
| Measured effect | prod `expert_identities` now has area 29, paper 4 401, repository 138, person 0. Persons 1 094 → 0; evidence moved 1 942 / dropped 1 278; 0 dangling references | prod probe; plan |
| Alternatives considered | park persons (FE1, superseded). Others: UNKNOWN | plan |
| Downstream consumer impact | UNKNOWN in the decision. L3 separately found 0 proposals cite expert units | L3 v2 |

### 4.4 How these become rows (design)

Each decision becomes one `swarm_claims` row:

- `claim_type='decision'`
- `subject_ref='topic:<question-slug>'`
- `object` = the chosen option
- `evidence_refs_json` = the source column above
- `metadata.valid_from` set where it is known
- `metadata.unknowns` = the list of UNKNOWN fields

Each superseded belief becomes an `observation` or `policy` row with `invalidated_by`. The relations (`supersedes`,
`implemented_by`, `motivated_by`, `constrained_by`, `contradicts`) become `swarm_evidence_edges` rows (ARCHITECTURE.md
§5).

Importing these three is the decision part of the vertical slice. They are written by hand, and nothing writes them
automatically.
