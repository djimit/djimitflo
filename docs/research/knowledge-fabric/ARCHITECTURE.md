# DKF-EVOLUTION-001: architecture (Phases B–D, design only)

This is a design document. Nothing here has been built, flagged, migrated or deployed. Every component below maps onto
something that already exists, using the dispositions **REUSE / EXTEND / RETIRE / FREEZE / NEW**. Rule: only add NEW
when no existing component can carry the job, and only after a caller or test proves the need (Ponytail layer,
`.github/copilot-instructions.md`).

`S/` = `packages/server/src/`. Evidence for every "exists" claim is in CURRENT_STATE.md and `capability-graph.json`.

## 1. Six planes mapped onto what exists

| Plane | Job | Existing component(s) | Disposition | Smallest change that closes the gap |
|---|---|---|---|---|
| **P1 Source** | Where knowledge lives, who owns it | DjimitKBWiki vault (workstation, git); NAS `workstation-backup/wiki` (stale copy); prod OKF bundle (machine exhaust); Frontier Experts; OpenWiki | REUSE the vault as the curated corpus. FREEZE the experts and OpenWiki. RETIRE `agent-shared` as a corpus | A **corpus registry**: one small JSON file on the workstation that lists corpus id, root, allow and deny globs, classification and owner. No DB table until a second corpus exists. |
| **P2 Ingestion** | Bytes → admitted, screened, versioned units | `kb-sync.mjs` (workstation push, host token) → `POST /api/gym-worker/kb` → `ingestKbPages` (`S/services/kb-corpus.ts:25-50`) | EXTEND | Add the explicit state machine (§2), a corpus prefix on `path`, retry of unverdicted pages, and a path allow-list on both sides. |
| **P3 Representation** | A portable, inspectable unit format | Djimitflo "OKF" (flat parser, strict validator) and DjimitKBWiki (OpenKB frontmatter) | ADOPT **Google OKF v0.2** as the interchange format. EXTEND the KB ingest to keep frontmatter. FREEZE Djimitflo-OKF for operational memory (its 413 docs are run exhaust, not knowledge) | §3: field mapping, a `djimit:` extension map, round-trip of unknown keys. |
| **P4 Retrieval** | Query → ranked, filtered, cited context | `kbContext` (`kb-corpus.ts:55-94`) plus the jev gate; `context-injection-service.ts` (multi-source, raw scores); harness `retrieval-eval.ts` (RRF) | REUSE B as the baseline. EXTEND to C (lexical + RRF + metadata filters). FREEZE context-injection's Qdrant legs | §4. |
| **P5 Decision** | Decisions, their rationale, evidence and supersession over time | ADRs (docs), `approvals`, `authority_events`, `judgments.provenance_json`, `swarm_claims` (CHECK already allows `claim_type='decision'`/`'policy'`), `swarm_evidence_edges` (from_ref, to_ref, relation) | EXTEND the existing claim and edge tables; no new store | §5 and TEMPORAL_DECISIONS.md. |
| **P6 Governance** | Who may write, what is trusted, what may leave the house | `content_safety`, P1 seal, host token, fleet signatures (enforce), `write:claim` on publish, outbound denylist, `DataClassification` (tests only), NE registry, experiment registry | REUSE. EXTEND classification to knowledge units | Six separate trust assessments (SECURITY.md §2) and controls C1–C6. |

Evolution is not a plane. It is a loop across P2–P5, described in EVOLUTION.md.

## 2. Ingestion state machine (P2)

Today a page is in one of two implicit states: present in `kb_pages`, or deleted as unsafe. Two concrete defects follow
from that:

- **Unverdicted pages are never rechecked.** The server would re-check an unchanged page that has no verdict
  (`kb-corpus.ts:36-38`). But it treats a safety *error* as a pass and embeds and accepts the page (`kb-corpus.ts:40`
  acts only on `'unsafe'`). `kb-sync.mjs` then records the accepted page's sha, and its next run sends only changed
  pages (`if (state[path] === sha) continue`). The page never comes back to the server. The result is that 456 of 1 313
  pages stay unverdicted, and the plan's "re-checked by every daily sync" never happens. This is a client-side defect:
  VERIFIED_CODE, plus runtime evidence (0 pages sent 20–22 Oct).
- **Paths have no corpus namespace.** `path` is `concepts/x.md`. A second corpus with the same layout would overwrite
  the first.

```
             ┌─────────── REJECTED (path not allowed, too big, binary, deny-glob)  [terminal, logged]
             │
DISCOVERED ──┴─► ADMITTED ──► FETCHED ──► NORMALISED ──► SCREENED ──┬─► EMBEDDED ──► INDEXED ──► SERVED
 (pusher walk)   (allowlist) (sha256 of   (OKF v0.2      (secret scan │   (model id    (kb_pages   (eligible for
                             bytes)       frontmatter,   + content    │    + dim        row, FTS)   retrieval)
                                          unknown keys   safety)      │    recorded)
                                          kept)                       ├─► QUARANTINED (unsafe or secret hit; not stored)
                                                                      └─► PENDING_VERDICT (safety error; stored, NOT served
                                                                           for new corpora; retried with backoff)
SERVED ──► STALE (now ≥ stale_after: served only with a "stale" marker)
SERVED ──► SUPERSEDED (newer version of the same concept_id, or an explicit superseded_by: kept for as-of queries)
SERVED ──► TOMBSTONED (source file deleted: recorded_to set, never served, kept for audit)
```

**Idempotency key:** `(corpus_id, concept_id, content_sha256, normaliser_version, embed_model)`.

- If an identical key arrives again, nothing happens. This is already true for the sha alone (`unchanged = free`,
  `kb-corpus.ts:35-38`).
- If the sha changes, a new version is written and the previous version gets `recorded_to = now`. That is the bitemporal
  "transaction time" (TEMPORAL_DECISIONS.md §2).
- If `normaliser_version` or `embed_model` changes, the page is re-normalised or re-embedded. Its content stays the same
  and no new knowledge version is created.
- `PENDING_VERDICT` is keyed separately, so the pusher re-sends a page until it has a yes/no verdict. This is the one-line
  fix to the defect above: the server answers `pending` instead of `accepted`, and the client does not remember the
  sha.

**Where the state lives (no new service):**

- Workstation side: the existing `~/.djimit/kb-sync.state.json`, extended to `{sha, state, attempts, last_error}`.
- Server side: new nullable columns on `kb_pages` (`corpus`, `concept_id`, `okf_json`, `status`, `stale_after`,
  `classification`, `safety_state`, `recorded_from`, `recorded_to`, `normaliser_version`). They follow the existing
  `addDimColumn` pattern, behind a flag, default off.
- A `kb_page_versions` table only becomes necessary when the first real supersession happens. Until then
  `recorded_to` plus the old row kept under a versioned key is enough. Mark this shortcut with `ponytail:` in the code,
  and upgrade it when the version count exceeds 2 on any concept.

**Direction of calls:** unchanged. The workstation pushes to the VPS. The VPS never calls the workstation or the NAS
(operator rule; `OUTBOUND_DENY_HOSTS`).

## 3. OKF v0.2 representation (P3)

The source is `GoogleCloudPlatform/open-knowledge-format` SPEC.md v0.2 at `ad30107c`. The full comparison with
Djimitflo-OKF and DjimitKBWiki is in CURRENT_STATE.md §2.1.

### 3.1 Field classes

| Class | Fields | Rule in the fabric |
|---|---|---|
| **Required (v0.2)** | `type` | Must be present and non-empty. All 1 313 KBWiki pages already comply. |
| **Recommended (v0.2)** | `title`, `description`, `resource`, `tags` | Carried if present. `title` is derived from the filename or first heading when absent (§4.1), as kb-sync already does. |
| **Optional families (v0.2)** | `sources[]` {`resource` (required in entry), `id`, `title`, `author`, `usage_count`, `last_modified`}, `usage_window`; `generated` {`by` required, `at`}; `verified` (list or bare map, which must be treated as a one-element list); `status` (absent ⇒ `stable`); `stale_after` | Parsed and stored in `okf_json`. They drive the trust-tier display (unverified / machine-confirmed / human-reviewed) and staleness. Never reject when absent (§11). |
| **Attested Computation (v0.2)** | `runtime`, `parameters`, `computation`, `executor`, `attester` | Not used by the first slice. It is a natural future fit for "how is metric X computed" knowledge (cost and verified-rate definitions). |
| **Djimit extension** (one namespaced map `djimit:` so names never collide with future OKF keys) | `djimit.corpus`, `djimit.concept_version`, `djimit.source_commit` (vault git sha), `djimit.classification` (public/internal/confidential/restricted), `djimit.valid_from`, `djimit.valid_to` (validity time), `djimit.supersedes` / `djimit.superseded_by` (concept ids), `djimit.decision_refs` (ADR, PR or decision ids), `djimit.claims` (claim ids) | Written by the normaliser or by humans. **Classification can only be raised by a producer.** The server applies `max(producer value, path-rule value)`. |
| **Runtime-only** (never written into a bundle, the same principle as v0.2 receipts, §10) | content-safety verdict, embedding vector and model, retrieval hits and scores, jev passage scores, fitness, labels, `recorded_from` / `recorded_to` | Stored in `kb_pages` and `judgments`. Exported only as reports. |
| **Security-sensitive** | `sources[].resource` (can reveal NAS paths or internal URLs), `author` and `generated.by` / `verified[].by` with `human:<id>` (a personal identifier), `usage_count` (behavioural), `djimit.classification` | `resource` is rewritten to a corpus-relative path at ingest; absolute host paths are never stored. `human:<id>` uses the operator's handle only. A restricted unit is not served to non-admin principals (C5). |

### 3.2 Mapping today's corpora to v0.2 (normaliser, design)

- **DjimitKBWiki.** Keep `type` and `description`. Map `sources: ["summaries/x.md"]` to
  `sources: [{id: <stem>, resource: "/summaries/x.md"}]`. Map the OpenKB compile to
  `generated: {by: "openkb/<version>", at: <commit time>}`. Leave `verified` absent, which makes the tier `unverified`:
  correct, because the pages are LLM-compiled. Map `[[wikilinks]]` to markdown links in a derived copy; the vault itself
  is never rewritten. Set `djimit.source_commit` to the vault HEAD.
- **Djimitflo-OKF.** Map `timestamp` to `generated.at`, the v0.2 §13.1 fallback, and `trust_level` to
  `djimit.trust_level`. That field is kept, but it is not a v0.2 tier. `approved_by` becomes `verified[{by: …}]` only if
  it matches `human:`; otherwise it stays an extension. This mapping is for interchange only. The bundle stays as it is.

### 3.3 Round-trip of unknown extensions

v0.2 §4.1 says consumers SHOULD preserve unknown keys and MUST NOT reject them. Djimitflo today fails both. Its flat
parser loses nested values, and `OkfKnowledgeUpdater` rewrites whole files. Design:

- Store the **original frontmatter text** and its parsed map (`okf_json`). Never regenerate a source file. The vault
  stays the system of record. The fabric only ever writes derived exports.
- When exporting, merge Djimit runtime facts into `djimit:` and emit all other keys byte-identical. This needs a test
  fixture with an unknown nested key, e.g. Google's own `not:` list in `acme_retail/metrics/gross-margin.md`: parse it,
  export it, diff it, expect zero changes outside `djimit:`.
- Parser choice: no YAML library is in the dependency tree today. YAML 1.2 is a superset of JSON, so the normaliser
  **writes** every top-level value in JSON flow style (`generated: {"by": "openkb/x", "at": "…"}`). Those lines parse
  with `JSON.parse` per value, and OpenKB's frontmatter already has that shape (`type: "Concept"`,
  `sources: ["…"]`). `ponytail:` this ceiling cannot read block-style YAML from third-party bundles. The upgrade
  trigger is the first external bundle: then add one pinned YAML parser.

## 4. Retrieval options (P4)

| Option | What | Fits | Verdict for the first slice |
|---|---|---|---|
| R0 = arm B | `kbContext` cosine full scan, k = 3, cos ≥ 0.3, jev gate | 1.3 k pages (code note: "move to Qdrant at ~20 k") | Baseline, unchanged |
| R1 lexical | SQLite **FTS5** virtual table over title and body. It is built into SQLite, so no dependency. No FTS5 exists in the codebase today | Exact identifiers (PR numbers, flag names, file paths), which dense retrieval misses | **Add** as the second list for RRF |
| R2 fusion | RRF k = 60 (`retrieval-eval.ts:50`, harness-only today) over R0 and R1 | Fixes the UX-24 cross-source score problem without score normalisation | **Add**, after E1 says so (E1 needs only 30 labels) |
| R3 metadata filters | `status`, `stale_after`, `djimit.classification`, `djimit.valid_to`; trust tier as tie-break | Superseded and stale knowledge | **Add** (deterministic, cheap) |
| R4 Qdrant | Existing instances | Larger corpora | **Not for the slice**: two diverged instances, three embedding spaces, the nomic path dead (L3 F5). Consolidation is a separate operator decision |
| R5 graph expansion | Follow OKF links and `djimit.supersedes` one hop (`okf_related` BFS exists for wikilinks) | "What replaced X" | Arm D only |
| R6 cross-encoder or LLM rerank | — | — | **No.** The jev gate already reranks; E-KB decides whether it stays |
| R7 chunking and contextual prefix | Plan item | Long pages (max 12.9 k chars) | After C is measured; a separate ablation |

Embedding model: keep `nvidia/nemotron-3-embed-1b` (2048) for the KB. **Write `embedding_model` / `embedding_dim` on
every row**; all 1 313 are NULL today. Changing the model is an experiment, not a refactor (EVOLUTION.md §4). Private
corpora would need a local embedder (SECURITY.md §0.3).

## 5. Decision-plane relations (P5): a Djimit domain model, not OKF predicates

OKF v0.2 links are deliberately **untyped** (§6.1: "the kind is conveyed by the surrounding prose"). Decision semantics
must therefore live in Djimitflo's own model, linked to OKF concepts by id. They must not be smuggled into link syntax.

**Entities.** These reuse `swarm_claims`. Its CHECK already allows `claim_type IN ('decision','policy','observation',
'hypothesis',…)`, and the table has `subject_ref, predicate, object, scope, evidence_refs_json, valid_until,
invalidated_by, supports_ref, contradicts_ref, status`.

- **Decision**: `claim_type='decision'`; `subject_ref` = the question (e.g. `topic:work-control-plane`); `object` = the
  chosen option; `evidence_refs_json` = ADR, PR, plan line or measurement ids; `status` ∈ proposed / supported /
  contradicted / resolved / rejected / promoted / review_required.
- **Policy**: `claim_type='policy'`. These are standing rules, e.g. "jev never for approval/promotion/code/risk/fitness".
- **Observation**: `claim_type='observation'`. These are measured facts that motivate decisions, e.g. "Paperclip: 1
  issue in 24 h on 2026-09-21".

**Relations.** These reuse `swarm_evidence_edges(from_ref, to_ref, relation, metadata)`, which has 13 589 rows and is
already written in prod. The vocabulary is closed and validated in code, never free text:

| Relation | From → to | Example |
|---|---|---|
| `decides` | decision → question | ADR 0001 → work-control-plane |
| `supersedes` | decision → decision | ADR 0001 → "Paperclip is the work control plane" (AGENTS.md era) |
| `motivated_by` | decision → observation / evidence | ADR 0001 → "10 306 CONNECT_TIMEOUT in 24 h" |
| `implemented_by` | decision → PR / commit | ADR 0001 → #305 (1f14fa98) |
| `measured_by` | decision → experiment / judgment set | kb_passage_relevance enforce → E-KB |
| `constrained_by` | decision → policy | promotion rules → NE-001 policy |
| `contradicts` | claim ↔ claim | ADR 0002 rule 1 ↔ the enforce flip of 28-09 (TEMPORAL_DECISIONS.md §4.2) |
| `reverts` | decision → decision | rollback of a flag |
| `cites` | decision → OKF concept id | link into the knowledge plane |

Validity is not a relation. It goes on the claim row (TEMPORAL_DECISIONS.md §2).

## 6. Governance (P6): six separate trust assessments

These are summarised from SECURITY.md §2 and kept separate on purpose. They are **never combined into one score**. OKF
v0.2 also refuses a stored credibility score (§5.1).

1. **Source authenticity**: host token plus fleet signature plus vault commit. Hard gate.
2. **Content integrity**: P1 sha seal. Hard gate.
3. **Content safety**: `content_safety` yes/no; `PENDING_VERDICT` is not served for new corpora. Hard gate.
4. **Access classification**: `djimit.classification` against the principal. Hard gate.
5. **Epistemic trust**: OKF `verified[]` tiers and human labels. Shown, used as a tie-break, never a gate.
6. **Currency**: `status`, `stale_after`, validity, supersession. A filter for "current" questions; shown otherwise.

Who can change what:

- Corpus registry and allow-lists: operator (`manage:config`).
- Ingestion: host token.
- Classification downgrade: operator only.
- Decisions: `write:claim` plus an `approvals` row for anything with `status='promoted'`.
- Labels: operator via `/decisions`.

Nothing in the fabric creates work items, capabilities or memory rules by itself. Retrieval output is context only (T6).

## 7. Reuse / extend / retire summary

| Component | Disposition |
|---|---|
| kb-sync push, `kb_pages`, P1 seal, `content_safety`, `kbContext` call sites, `judgments`, E1 and #835 labelling, `retrieval-eval.ts`, knowledge-fitness, outcome-attribution, NE registry, `swarm_claims`, `swarm_evidence_edges`, ADRs | **REUSE** |
| `ingestKbPages` (state machine, metadata columns), kb-sync client (pending retry, corpus prefix), `knowledge-maintenance` (`okf_lint` → OKF v0.2 conformance report) | **EXTEND** |
| Djimitflo-OKF bundle and tools (as operational memory), both Qdrant instances, context-injection Qdrant legs, Frontier Experts, explainer, OpenWiki | **FREEZE**: no new writers; consolidation is a separate decision |
| `OkfKnowledgeUpdater`; `proactive_memories`, `vector_memories`, `segml_fleet_memory`, `knowledge_claims`, `research_*` (all 0 rows or last written in July); `reasoning-loop.ts`; `bootstrap/core-services.ts`; `agent-shared` as a corpus | **RETIRE candidates**, each needing its own W8-style tranche with operator OK |
| FTS5 index, `djimit:` extension normaliser, corpus registry file | **NEW** (small), only within the vertical slice |
