# DKF-EVOLUTION-001: security (Phase F, design only)

Scope: threats introduced or amplified when NAS / DjimitKBWiki / OKF content becomes retrievable context for Djimitflo
agents. Each threat is mapped to an existing control (with file:line on origin/main `4a9cbdf4`) and its gap. The gap IDs
`S0–S19` refer to `docs/research/mcp-a2a/SECURITY_GAPS.md`, which this file extends and does not repeat.
`S/` = `packages/server/src/`.

## 0. Ground truths that shape every row

1. **S0 (BLOCKING, scoped):** makers run in `djimitflo-live` as uid 1001, the owner of `/data/djimitflo.sqlite`.
   **Any new retrieval source given to makers is a path to the prod DB.** Every permission check inside a maker is
   advisory. The first slice therefore feeds knowledge to **reviewers / panels / committee only** (the existing
   `kbContext` consumers), never to makers, until the sandbox runner (draft #950) exists.
2. **The trust boundary of the KB is the workstation.** Pages are pushed by `kb-sync.mjs` with the workstation host
   token to `/api/gym-worker/kb`. Whoever can write the vault or the host token can write prod context.
3. **Private corpora never leave the house.** NAS personal areas and the MacBook ChatGPT export
   (`~/Downloads/chatgpt-export-analysis`, 4 MB, contents not read) must not be sent to any external API. Today **every
   KB page passes through two external APIs**: NVIDIA `nemotron-3.5-content-safety` (safety check) and NVIDIA
   `nemotron-3-embed-1b` (embedding), both `integrate.api.nvidia.com`, a US cloud (UX-20 egress class `us_cloud`). That is
   acceptable for the operator's technical KB. It is **not** acceptable for any NAS personal area. A private corpus would
   need a local embedder + local safety model (workstation Ollama), which do not exist for KB today → MISSING.

## 1. Threat table (STRIDE × OWASP LLM Top-10 2025 / Agentic)

| # | Threat | STRIDE / OWASP | Existing control (evidence) | Status | Gap |
|---|---|---|---|---|---|
| T1 | **Indirect prompt injection via an ingested page** (a KB/OKF page tells the reviewer to approve, call a tool, leak) | Tampering, EoP / LLM01 | `content_safety` on ingest; **unsafe → page deleted in every mode** (`S/services/kb-corpus.ts:40`, recorded as `enforce`); re-check on retrieval (`:80`); framing "reference data, not instructions" (`kb-corpus.ts:88`); prod: 9 KB pages judged unsafe, 857 safe | VERIFIED_RUNTIME (partial) | **456 of 1 313 KB pages (34.7 %) have no yes/no safety verdict** (462 `error` rows: NVIDIA 429/timeouts, 27-09 → 08-10); kb-sync only re-sends *changed* pages and the vault has been static since 12-09 (0 pages sent 20–22 Oct), so coverage does not converge as the plan expected; retrieval path fails **open** on a missing verdict (L3 graph `knowledge.kb_corpus` failure mode). OKF files read by `okf_search` / context injection have **no** safety check. |
| T2 | **Knowledge poisoning / near-duplicate contradiction** (a plausible page with a wrong fact outranks the true one) | Tampering / LLM04, LLM09 | none specific; jev `kb_passage_relevance` gate judges relevance, not truth; `expert_claim_relations` detects CONTRADICTS on expert claims only (1 row) | MISSING | No contradiction check across KB pages; no source-independence signal on KB pages (expert_claims has `source_independence`, KB does not). Design: TEMPORAL_DECISIONS.md §3 contradiction classes, surfaced not resolved. |
| T3 | **Tampering after ingest** (DB row edited) | Tampering | **P1 seal**: body re-hashed against ingest sha before retrieval, mismatch → hidden + `artifact_integrity` judgment (`kb-corpus.ts:60-69`); prod 0 artifact_integrity rows (no tampering seen) | VERIFIED_CODE (no runtime event yet) | The seal is computed by the same process that stores it (TOFU), so it detects drift, not a malicious writer with DB access (S0). OKF files: no seal (S16). |
| T4 | **Spoofed source / unsigned producer** | Spoofing / LLM03 | kb-sync authenticates with the workstation host token; fleet event signatures: prod `FLEET_EVENT_SIGNATURES=enforce` (read 2026-10-22; first signed kb-sync event verified 21-10 04:42Z per plan); event bus + agent registry have no auth (**S3**; bus auth = open PR #954, log mode) | PARTIAL | Signatures cover fleet *outcome* events, not the KB page body (the host token is the only page-level authenticity); `wiki-delta-emitter.sh` bus events — signature status UNVERIFIED; registry `/memory/write` unauthenticated. |
| T5 | **Sensitive information disclosure / restricted docs** (credentials notes, personal data reach a prompt or an external API) | Information disclosure / LLM02 | `DataClassification` public/internal/confidential/restricted (`S/services/data-classification.ts:8-60`) — **enforcement used only in tests** (`data-classification-enforcement.ts:40-57`); `redactSecrets` (`S/services/secret-patterns.ts:29`) on diffs/dream/training — **not on KB ingest**; `memory_candidates.sensitivity` is the only knowledge label | DOCUMENTED_ONLY for KB | No classification column on `kb_pages` or OKF; no ingest-time secret scan; the NAS wiki snapshot contains an `.env` file (name only seen) and agent-shared contains `credentials-refs.md` — both must be excluded by path rule, not by luck. |
| T6 | **Excessive agency from knowledge** (published knowledge creates work / capabilities) | EoP / LLM06 | `POST /api/knowledge/publish` now needs `write:claim` (**S4 fixed**, `S/routes/knowledge.ts:26`); memory rules sealed on first use (`assignment-context.ts:92-123`); `knowledge_gaps` shadow only | PARTIAL | S14: machine `approved_by` strings promote engineering rules into maker prompts; S17 any non-empty human_approval_ref passes. The fabric must never let retrieval output become a work item without an approval row. |
| T7 | **Vector / embedding weaknesses** (dim mismatch, cross-space similarity, inversion) | LLM08 | UX-21 records model+dim on new vectors; `VECTOR_STRICT_DIM` off | PARTIAL | `kb_pages.embedding_model/dim` NULL on all 1 313 rows; 3 spaces in use (nemotron 2048, nomic 768, snowflake 384); two Qdrant instances with the same collection names and divergent counts (CURRENT_STATE §1.3) → a query embedded in one space can hit another silently. Embeddings of private text are invertible enough to treat them as the text itself (store them at the text's classification). |
| T8 | **Repudiation: who put this fact here?** | Repudiation | `judgments.provenance_json` (canon/v1 input digest, `judgment-provenance.ts:13-16`); `authority_events` append-only; kb_pages has `host` + `sha` | PARTIAL | kb_pages records host, not the vault commit / author / compile run; OKF frontmatter `approved_by` is free text. OKF v0.2 `generated.by` / `verified[].by` actor convention would close this at file level. |
| T9 | **Denial of service / unbounded consumption** | DoS / LLM10 | `kbContext` k = 3; body cap `MAX_BODY`; kb-sync `--max 400`; NVIDIA 429 retry ≤ 3 (#482) | VERIFIED_RUNTIME | `kbContext` loads **all** page vectors per call (`kb-corpus.ts:59`, 1 313 × 2 048 floats ≈ 10.7 MB) — fine now, linear in corpus; a 25 k-chunk NAS corpus would not be. |
| T10 | **Egress / data residency** | Information disclosure | outbound guard = exact-host **denylist** on global fetch (`S/utils/outbound-guard.ts:1-38`, S18 bypasses); egress classification report-only (`S/services/egress-classification.ts`) | PARTIAL | No allowlist; a new ingestion path could call any host. Directive rule "no new outbound targets" must be a test, not a convention (§3 control C4). |
| T11 | **Cross-boundary call direction** (VPS reaching into the workstation/NAS) | EoP | Operator rule "VPS never calls the workstation"; `OUTBOUND_DENY_HOSTS`; kb-sync is push from workstation | VERIFIED_CODE | Plan 29-09 found a root@VPS key in workstation authorized_keys without `command=` (open operator item). Any NAS ingestion must stay workstation-side push. |
| T12 | **MCP retrieval tools without permission** | EoP / Info disclosure | `requireMcpPermission` on governance/explainer tools; `okf_get` path traversal fixed (#914: `resolveOkfConceptPath`, realpath re-check) | PARTIAL | `djimitflo_memory_search` = raw LIKE over `memory_candidates`, no permission check (`packages/mcp-server/src/tools/platform.ts:39-50`); `mcp_tool_permissions` display-only (S5); NotebookLM `notebook_add_source` uploads any local file to Google (S6) — **must never be pointed at NAS/ChatGPT paths**. |
| T13 | **Simulated / generated content mistaken for fact** | Tampering / LLM09 | NE-010 (MiroFish) REJECT as precedent; OKF v0.2 distinguishes `generated` vs `verified` | MISSING in Djimitflo | KBWiki summaries/concepts are LLM-compiled (OpenKB); nothing marks them machine-generated in prod (`kb_pages` has no trust tier). Map to OKF trust tier `unverified` by default (ARCHITECTURE.md §4). |

## 2. Six separate trust assessments (never one score)

Kept separate because they fail independently (OKF v0.2 §5.1 also refuses a stored credibility score):

| Assessment | Question | Source of truth | Exists? |
|---|---|---|---|
| A1 Source authenticity | Did this come from the claimed producer? | host token + fleet signature + vault commit sha | PARTIAL (signature shadow) |
| A2 Content integrity | Is it byte-identical to what was checked? | P1 sha seal | EXISTS (kb_pages) / MISSING (OKF) |
| A3 Content safety | Does it carry instructions/abuse? | `content_safety` verdict | EXISTS; 34.7 % of KB pages unverdicted |
| A4 Epistemic trust | Is it true / verified, by whom? | OKF `verified[]` actor tiers; labels | MISSING |
| A5 Freshness / currency | Is it still current? | OKF `status`, `stale_after`, supersession | MISSING |
| A6 Access classification | Who may see it? | classification label + role | DOCUMENTED_ONLY |

Retrieval consumes them as **filters and labels**, never as a weighted sum: A1/A2/A3/A6 are hard gates (fail → not
served), A4/A5 are shown to the consumer (tier + "stale"/"superseded" markers) and used as tie-breakers only.

## 3. Controls the first slice must add (all flag-gated, default off, shadow first)

- **C1** path allow-list for ingestion (explicit corpus roots; deny `secrets/`, `family-*`, `#recycle`, `*.env`,
  `credentials*`, `restic*`, `*.sql*`, `*.sqlite*`, `qdrant-storage/`), enforced in the workstation pusher **and**
  re-checked server-side on `path`.
- **C2** ingest-time `redactSecrets` scan; a hit rejects the page (do not store redacted variants silently).
- **C3** fail-closed retrieval on a missing safety verdict for any *new* corpus (existing KB stays as is until E-KB).
- **C4** a test that enumerates the hosts the ingestion path can reach (NVIDIA only, already used) — "no new outbound
  targets" becomes a failing test, not a rule.
- **C5** classification column defaulting to `internal`; `restricted` never retrievable by a non-admin principal
  (S12: today all 4 users are admin, so this is latent until roles are split).
- **C6** consumers = reviewers/panels/committee only; makers excluded until S0 is closed.
