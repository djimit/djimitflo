# Leviathan forensics (read-only)

Status: research note. Nothing was built, run, deployed or merged. Leviathan was not compiled or executed and no
`cargo` command ran. Prod was not queried. Evidence comes only from reading code, from `gh`, and from docs already in this
repo or the plan file.

## 0. Pins

| Item | Value |
|---|---|
| Upstream | `github.com/elstongun/leviathan`, cloned shallow into a scratchpad and deleted after reading |
| Requested base | `f1070fe525527eec8ed52bfaf014b9e927224889` ("Add memory, remote serving and agent setup for 0.2.0", 2026-10-09) |
| Upstream HEAD (`main`, 2026-10-26) | `f1070fe525527eec8ed52bfaf014b9e927224889`, the same commit. **Diff vs base: empty.** All 6 commits are by one author (d8b8bf5 0.1.0 on 2026-10-05 → f1070fe 0.2.0) |
| Open upstream work | 13 external PRs (#13–#25, all opened 2026-10-20 and unmerged), dependabot #12, issue #26 (2026-10-22). Nothing was merged after 0.2.0 |
| Licence | Apache-2.0 (`LICENSE`, `Cargo.toml` `license`). `NOTICE`: © 2026 Joshua Baker, bundles SQLite (public domain) |
| Crate / binary | crate `leviathan-index` 0.2.0 (lib `leviathan`, bin `leviathan`); workspace member `bench/synth` (publish = false). Edition 2024, MSRV 1.88, `unsafe_code = "forbid"` |
| `Cargo.lock` | present: 133 packages; CI and release build with `--locked` |
| Default features | `default = ["remote"]`, which pulls in `tiny_http`, `ureq` (rustls + webpki-roots → `ring`), `sha2` and `base64`. `--no-default-features` drops all network code |
| `build.rs` in the repo | none. Build scripts run in dependencies: `libsqlite3-sys` 0.38.2 (`bundled`: cc-compiles the SQLite C amalgamation) and `ring` 0.17.14 (cc-compiles C/asm), plus the usual probe scripts of common crates. These were not enumerated by download |
| Direct deps | anyhow, clap, csv, flate2, getrandom 0.3, regex, rusqlite 0.40.2 (bundled), serde, serde_json, strsim, toml; optional base64, sha2, tiny_http 0.12, ureq 3.4.2 |
| Network / telemetry | No telemetry, analytics or phone-home code found by grep. Network code exists only in `src/http/mod.rs` (tiny_http server: `/mcp`, `/v1/<tool>`, `/openapi.json`, OAuth), `src/http/client.rs` (ureq client for `mcp --remote`) and `src/oauth.rs`. `wrap --apply` writes MCP entries and hooks into agent configs (`~/.claude/settings.json`, `~/.codex/config.toml`, Cursor, Copilot, Kiro, Cline) |
| Release provenance | `release.yml` builds 5 targets on GitHub runners and publishes tarballs with `.sha256` files. There is no signing, no SLSA or attestation, and actions are pinned by tag, not by SHA. `cargo install` from crates.io builds from source |
| DjimitFlo reference | requested `38be63d5` (#1021). Current `origin/main` is `56ba3395` (#1024). The only difference is one test file, `__tests__/resource-scheduler.exports.test.ts`, which does not matter here |

## 1. What Leviathan does (phase 1, upstream at f1070fe5)

| Question | Answer (file:line) |
|---|---|
| Retrieval | **Lexical only.** It uses one contentless SQLite FTS5 table, `record_fts(title, body, names, tags)` with `tokenize='porter unicode61'` and rank `bm25(title_weight, 1.0, 0.5, 0.0)` (`index.rs:68-73`). The score is BM25 × the configured boost, with recency as the tie-break (`query.rs:442-508`). A query without words lists records newest first (`query.rs:513-558`). **No vectors, no embeddings, no hybrid, no RRF**: there is no embedding dependency in `Cargo.lock` |
| Query safety | User text is re-quoted into FTS5 phrases (`text.rs:32-34`). SQL values are bound parameters. Indexes open `SQLITE_OPEN_READ_ONLY` (`index.rs:536-538`) |
| Scoping | A "group" (a configured field such as customer or machine) is resolved by tier: exact, case-insensitive, normalised name, substring, then fuzzy Sørensen-Dice ≥ 0.6. If the tier is ambiguous, the candidates are returned (`query.rs:240-294`). Scope and filters are synthetic FTS tokens (`g<fnv>`, `f<fnv>`) intersected in the MATCH (`query.rs:651-670`, `text.rs:115-122`). **The group is a relevance scope, not a tenancy boundary**: the caller picks `scope` = group/others/all (`query.rs:311`) |
| Tenancy / authz | One index per process. HTTP uses one static bearer token or OAuth 2.1 (PKCE S256), and every token gets the whole index and the whole memory store (`http/mod.rs:342-353`). There is no per-token group or namespace binding |
| MCP surface | Data tools `search`, `resolve_group`, `get` and `describe` (`mcp.rs:99-153`). Memory tools `recall`, `remember`, `forget` and `memory_describe` (`mcp.rs:160-231`); `--memory-tools recall` makes memory read-only (`mcp.rs:386-388`). Transport is stdio JSON-RPC (`mcp.rs:611-630`) or Streamable HTTP plus REST (`http/mod.rs:436-535`). Protocol versions 2024-11-05 … 2025-11-25 |
| Memory write | `remember` (`memory/write.rs:127-253`). With a `key`, the slot's current row is closed (`valid_to`, `superseded_by`) and a new row is inserted, unless the word sets are equal (Jaccard = 1.0, same kind), in which case it merges (`write.rs:175-224`). Without a key, Jaccard ≥ 0.8 against FTS-similar current rows merges into the old row, and ≥ 0.3 is reported as `related` (`write.rs:21-25, 225-249`). A merge raises importance by 1 for each restatement (`write.rs:327`). The secret guard is a regex list (`memory/guard.rs:27-46`) |
| Memory recall | FTS5 or the current set, filtered by namespace, subject (alias-resolved), kind, dates and `as_of` (bitemporal). The score combines relevance, a per-kind recency half-life, importance, pin and confidence, and results are packed into a token budget, 800 by default (`memory/recall.rs:183-420`). `with_records` follows memory `refs` into the data index (`recall.rs:396-418`) |
| Tests | ≈ 55 `#[test]`: `tests/integration.rs` 13, `tests/memory.rs` 13, `tests/http.rs` 5, `tests/wrap.rs` 5, the rest are unit tests. None of them sends a wrongly typed MCP argument. `namespaces_are_isolated_unless_asked` (`tests/memory.rs:94`) asserts that `ns: "*"` reads across namespaces |
| Benchmarks | **Reproducible from the repo, but self-designed and synthetic.** `bench/synth` is a deterministic maintenance-log generator with 200 gold questions per scale; `bench/run_bench.py` runs it (needs tiktoken and ripgrep). The baselines are `rg` keyword and history dumps, never BM25 vs dense vs hybrid. The memory benchmark compares against MEMORY.md variants. The numbers in `bench/results/*` (99.0 % hit@5 at 1 M, 436 tokens median) come from the vendor's own run on one Ryzen 2700X. No third-party or real-corpus result exists |

## 2. What DjimitFlo has (origin/main 56ba3395)

| Component | What it does (file:line) | Data owner / authz / lifecycle / filters |
|---|---|---|
| `ContextInjectionService` | Fans out to Qdrant `djimitflo_swarm`, Qdrant `djimit_okf` (+ related), DjimitKB `/search` and experience retrieval (`services/context-injection-service.ts:135-158`). Each query is embedded with `nomic-embed-text:latest` (`:165`, `:219`), MIN_SCORE 0.5, limit 3 per source. Then `rankContextResults` (trust tier, then raw score; `RETRIEVAL_NORMALISE_SCORES` min-max, off by default; `:57-67`), a 1 500-token budget (`:31, :98, :307-316`) and the sanitiser (`:119-121`). Trust decays on a 30-day half-life, with ×0.3 if `swarm_claims.contradicts_ref` matches (`:182-191`) | Server-internal (task intake `routes/tasks.ts:178`, proof-run). Store filter via the Qdrant payload (`:174-175`). The plan (L2/K2, 21-10) records the Qdrant path as UNREACHABLE and nomic-embed as retired |
| `ContextSanitizer` | 9 regex injection patterns, matches replaced (`services/context-sanitizer.ts:13-22, 38-70`) | Applied to all injected context |
| `KnowledgeAdapterRegistry` / `KnowledgeSourceAdapter` | `search/fetch/isAvailable` interface (`knowledge-adapters/types.ts:11-16`). Registry with a SQLite cache: wikipedia, arxiv, okf, djimitkb (`knowledge-adapters/index.ts:9-67`). Used by `expert-swarm-orchestrator.ts:64` | Results cached per query hash, with TTL |
| `kbContext` (KB corpus) | `kb_pages` is a SQLite table with a nemotron-3-embed-1b vector BLOB (`services/kb-corpus.ts:22, 85-86`). It is a **dense-only full scan** with cosine ≥ 0.3 and top-k = 3 (`:97, :118-124`). Pages are served only if their sha matches what was ingested (`:98-107`) and, since #972, **only pages with a `safe` content_safety verdict for their current text** (`:108-116`). Then come the B19 prompt gate (`:126`), the jev passage gate `kb_passage_relevance` (`:128, :142-160`), and each hit is logged as a `kb_retrieval` judgment (mode shadow) with the pool and exclusion counts (`:131-135`) | Workstation push with a host token. Unsafe pages are deleted; pages without a verdict stay `pending` and are re-sent (`:59-91`). Gated by `KB_CONTEXT_ENABLED` + `NVIDIA_API_KEY` (`:16`) |
| `VectorMemoryService` | The header says "dense + sparse BM25 with RRF". The code computes a **weighted sum** 0.6·cosine + 0.2·pseudo-BM25 + 0.2·bandit (`services/vector-memory-service.ts:122-126`). The BM25 uses substring tf, a doc-local idf and avgDocLen = 100 (`:294-311`). It is a full in-memory scan with TTL (`:100-138`) | L6 item 11: 0 `vector_memories` rows sampled. Callers: `bootstrap/core-services.ts:58`, `routes/apex.ts:29`, reasoning bank |
| `MemoryCandidateService` | Candidates have type, store (episodic/procedural/semantic/working), status, promotion_status, sensitivity, and are refused when a secret is detected (`services/memory-candidate-service.ts:63-150, :83`). The human gate needs `human_approved` + `approver_user_id` (`:229-231`). Unattended promotion only for non-sensitive candidates (`:174-179`). Promotion fans out to sinks (`:221-262`) | Human-gated lifecycle. **No keyed slot, no `valid_from/valid_to`, no `as_of`** |
| `memory-store` | `SqliteMemoryStore` over `central_memories` with `content LIKE %q%` (`services/memory-store.ts:48, :73`). Used by the curator and the SEGML bridge | L6 item 11: 927 rows, 0 relations, SEGML dormant |
| MCP memory / OKF | `djimitflo_memory_search` runs LIKE over `memory_candidates` (`packages/mcp-server/src/tools/platform.ts:39-51`), ordered promoted first, with no filter on status or sensitivity. `okf_search` is an unranked substring scan of the OKF files (`tools/okf.ts:116-162`). zod schemas reject wrongly typed arguments | MCP server auth not re-audited here |
| Retrieval eval | `evaluateRetrieval` recall@k/MRR (`services/retrieval-eval.ts:13-28`). RRF k = 60 runs **only in the harness** (`:50-59`), along with `rankE1Arm` (`:62-72`), the paired bootstrap (`:78-86`) and `scoreE1`, which returns INSUFFICIENT below 30 (`:88, :100-118`). Scorer: `scripts/e1-rrf-score.mjs` | Offline only; no prod path reads it |
| E1 / #922 | `docs/research/eco/E1-RRF_PROTOCOL.md` (registered dcad1ed9) → `E1-RRF_RESULT.md`: **INSUFFICIENT, 0 eligible queries** | — |
| E1 labelling UI | **This is #933, not #835.** `services/e1-retrieval-labels.ts:25-28` (≤ 40 tasks, target 30, seed 20261021) freezes the candidates from `collectCandidates` (`:110-124`). Routes `routes/self-improvement.ts:166-187` (generate needs manage:config, a label needs write:governance). **#835** is blind discovery-relevance labelling (paper vs scope, yes/no), which E1 declared ineligible | Labels are `operator_label` / `e1_retrieval` judgments |
| L6 audit item 11 (`docs/audits/djimitflo-l6/11-memory-knowledge.md`) | "The system cannot infer useful retrieval from successful injection." It requires an immutable query set, relevance labels and recall@k/nDCG, then paired on/off. **"No new memory database is justified"** | — |
| L6 audit item 18 (`18-controlled-experiments.md`, E3) | Offline baseline: annotate query→relevant on a held-out corpus. A 50-query pilot first; ≈ 385 queries for ±5 pp | — |
| DKF knowledge fabric (#971, **draft, unmerged**, head 50e38ccf) | `EVALUATION_PROTOCOL.md` proposes arm C = B's dense + **SQLite FTS5 lexical, fused by RRF k = 60**, plus OKF metadata filters (marked MISSING). `VERTICAL_SLICE.md` step 6 builds FTS5 **in the offline scorer** from a `kb_pages` export. It records 0 `e1_retrieval_task` and 0 `operator_label` rows in prod (as of 22-10) | Docs only |

FTS5 availability: DjimitFlo uses `better-sqlite3` ^13.0.3 (lock 13.0.3), whose bundled build defines
`SQLITE_ENABLE_FTS5` (`deps/defines.gypi:24` at v13.0.3). Native FTS5 needs no new dependency. Nothing in
`packages/*/src` uses FTS5 today (`git grep -i fts5`).

## 3. Capability matrix

| Capability | Leviathan | DjimitFlo | Verdict | Note |
|---|---|---|---|---|
| Lexical BM25 ranking | FTS5 bm25, porter, title weight (`index.rs:68-73`) | none. LIKE (`memory-store.ts:73`, `platform.ts:47`), substring (`okf.ts:131-136`), pseudo-BM25 (`vector-memory-service.ts:294-311`) | **MISSING** (real BM25) | The one verified gap. better-sqlite3 already ships FTS5 |
| Dense retrieval | none | kbContext cosine (`kb-corpus.ts:118-124`); Qdrant (`context-injection-service.ts:160-210`) | DjimitFlo EXISTS; Leviathan none | Leviathan cannot replace the dense arm |
| Hybrid / RRF fusion | none | RRF only in the harness (`retrieval-eval.ts:50-72`); `VectorMemoryService` labels a weighted sum "RRF" (`:126`) | **PARTIAL** | Not a Leviathan capability |
| Scoped search / filters | group tokens + facet filters + date bounds (`query.rs:651-688`) | Qdrant `store` payload filter (`context-injection-service.ts:174-175`); OKF `type` filter (`okf.ts:121`); no exact facet filter on kb_pages | PARTIAL | The DKF arm C metadata filters are MISSING |
| Entity resolution (fuzzy, ambiguity refusal) | `query.rs:240-303` | none for KB/OKF | MISSING (not needed) | No caller asks for it; no gap is claimed |
| Safety-gated serving | none: the index is served as ingested | content_safety safe-only + sha integrity + B19 + jev gate (`kb-corpus.ts:98-128`) | DjimitFlo EXISTS | Leviathan would bypass #972 unless it were fed only safe pages |
| Prompt-injection sanitising | none (cards are the raw record text) | `context-sanitizer.ts:38-70` | DjimitFlo EXISTS | — |
| Token budget packing | card budget (recall 800, search `-n`) | 1 500 tokens, first-fit (`context-injection-service.ts:307-316`) | EXISTS both | — |
| Retrieval logging | none | `kb_retrieval` judgments (`kb-corpus.ts:131-135`) | DjimitFlo EXISTS | — |
| Offline retrieval eval | vendor bench (synthetic, grep baselines) | `retrieval-eval.ts`, E1 prereg, scorer | DjimitFlo EXISTS (no labels) | — |
| Memory: keyed slot supersession, `as_of` | `write.rs:175-224`, `recall.rs:251-259` | memory candidates have no slot or validity interval; DKF `TEMPORAL_DECISIONS.md` is design only | **MISSING** in DjimitFlo | Leviathan's version has the confirmed defect in §4 |
| Memory: human-gated promotion | none (any `remember` is current at once) | `memory-candidate-service.ts:221-262` | DjimitFlo EXISTS | Leviathan's model conflicts with P0-9 |
| Secret refusal | regex guard (`guard.rs:27-46`) | `memory-candidate-service.ts:83, :316` | EXISTS both | — |
| Namespace / tenancy authz | none (`*` and any explicit ns, `mod.rs:542-552`) | memory routes are JWT/permission-gated; no namespaces | n/a | Neither has per-tenant memory; no tenant requirement is recorded |
| MCP argument typing | lenient: drops wrong types (§4) | zod schemas (`platform.ts:41`, `okf.ts:119-122`) | DjimitFlo EXISTS | — |

**Verified gaps: (a) real BM25/FTS5 lexical retrieval; (b) keyed, temporally valid memory supersession.** For (a)
DjimitFlo needs only SQLite, which it already has. For (b) the Leviathan design is defective (see §4).

## 4. Security review by code reading (phase 2)

HEAD = f1070fe5, so "fixed at HEAD" means the same as "fixed at base". All four upstream items are still open.

| # | Case | Code path at f1070fe5 (= HEAD) | Upstream fix | Verdict |
|---|---|---|---|---|
| I-26 | Wrongly typed MCP/REST arguments are silently dropped | `text_arg` uses `as_str` and returns `None` for a non-string (`mcp.rs:250-252`). `group: 123` → `None` → scope All (`mcp.rs:427`, `query.rs:311`), and the response still says `status: ok`. `query: 123` → browse newest first. `where` that is not an object is ignored (`mcp.rs:408`). A numeric `since`/`until` is dropped (`:431-432`). `int_arg`/`bool_arg` fall back to defaults (`:254-266`). REST shares `Session::call` (`http/mod.rs:524`) | none (issue open) | **CONFIRMED_BY_CODE** |
| PR-13 | Keyed memory with an inverted relation ("Alice manages Bob" → "Bob manages Alice") | `jaccard(word_set(old), words) >= 1.0` ⇒ Duplicate: the old claim is kept and the new one is merged away (`write.rs:184-192`). `word_set` drops order and stopwords, including to/from/by/of/on/in/for (`text.rs:11-16`), and strips plural s (`write.rs:101-111`) | PR #13 (open) compares the exact text | **CONFIRMED_BY_CODE**, unfixed at HEAD |
| PR-13b | The same inversion **without a key** (not covered by #13) | Unkeyed: Jaccard ≥ 0.8 merges into the best similar row (`write.rs:226-241`). "deploy from staging to prod" / "deploy from prod to staging" score 1.0 → merged; the new fact is lost and the old one gains importance (`:327`) | none | **CONFIRMED_BY_CODE** |
| PR-20 | Facet values > 200 chars are truncated | `v.trim().chars().take(200)` (`fields.rs:236`). The tag token is computed from the truncated value, while a filter hashes the full value (`text.rs:120-122`). The full value matches 0 rows; a 200-char prefix matches every value that shares it (facet collapse) | PR #20 (open) | **CONFIRMED_BY_CODE** (integrity, low) |
| PR-23 | Remote client takes the first message with any `id` | `find(|m| m.get("id").is_some())` (`http/client.rs:119-120`). An interleaved server request (ping) becomes an empty successful tool result | PR #23 (open) | **CONFIRMED_BY_CODE** (integrity/availability, low) |
| S-1 | Group fallback | When the group has no hits, `other_groups` from Scope::Others is added (`query.rs:408-425`). MCP always sets `fallback: true` (`mcp.rs:436`); the result is labelled "OTHER" | by design | **CONFIRMED_BY_CODE**: other groups' records are disclosed whenever a scoped search misses |
| S-2 | `scope=all` / `scope=others` | Chosen by the caller, with no authz check (`mcp.rs:395-400`, `query.rs:311, :663-665`) | by design | **CONFIRMED_BY_CODE**: a group is not an access boundary |
| S-3 | `get` without scope | `SELECT doc FROM records WHERE id = ?` returns the full raw record (`query.rs:579-586`, `mcp.rs:454-459`) | by design | **CONFIRMED_BY_CODE** |
| S-4 | `describe` exposure | Returns the absolute `index_path`, the field mapping, the top facet values, the 5 largest groups, an example id and build times (`query.rs:590-636`). A dataset summary (group count, date range, filter values) is also put in **every tool description and the `initialize` instructions** before any call (`mcp.rs:64-93, :105, :364`). OpenAPI leaves it out on purpose (`http/mod.rs:156-161`) | by design | **CONFIRMED_BY_CODE**: metadata disclosure to any authenticated client |
| S-5 | `ns: "*"` / arbitrary namespaces | `*` expands to every distinct namespace (`memory/mod.rs:546-550`). Any explicit list is only format-checked (`:551`). `remember` writes to any `ns` (`mcp.rs:486`). `forget` by id ignores the namespace (`write.rs:261`). Documented in `docs/MEMORY.md:152`; test `tests/memory.rs:94` | by design | **CONFIRMED_BY_CODE**: namespaces are organisational, not isolation |
| S-6 | The OAuth scope is not enforced | Tokens are issued with scope `memory` (`oauth.rs:31, :528`), but `check_access` checks only hash and expiry (`oauth.rs:353-364`). `authorized()` then allows every tool, including data `search`/`get` (`http/mod.rs:342-353, :441-443`) | none | **CONFIRMED_BY_CODE** (found while reading; no upstream report) |
| S-7 | Whether issue 26 leads to a cross-group leak in practice; real MCP clients sending wrong types | depends on client schema validation | — | **NOT_REPRODUCIBLE_BY_READING** |

### Sandbox tests that would be needed (not run)

All of these would run in a throwaway container with no network, built from source at f1070fe5 with `--locked`
(and `--no-default-features` for T1–T7), on the issue-26 four-record sample:

1. T1: `tools/call search {"query":"login","group":123}` → expect status ok with scope all (I-26). Repeat with
   `query:123`, `where:"status=closed"` and `since:20240101`, over stdio and over `POST /v1/search`.
2. T2: `remember {subject:"team",key:"manager",text:"Alice manages Bob"}`, then `{…,text:"Bob manages Alice"}` → expect
   `already known`, and `recall` returns the first text only (PR-13). Then the same pair without a key and with
   "deploy from staging to prod" (PR-13b).
3. T3: index two records whose `status` values share the first 200 chars → the full-value filter returns 0, and the
   prefix filter returns both (PR-20).
4. T4: `search {"group":"<group with no hit>","query":"login"}` → `other_groups` is non-empty (S-1). `scope:"all"` and
   `scope:"others"` (S-2). `get {"id":"<id in another group>"}` (S-3).
5. T5: compare `initialize` / `tools/list` / `describe` output against the source data to list the disclosed fields (S-4).
6. T6: `recall {ns:"*"}`, `recall {ns:"other"}`, `remember {ns:"other"}`, and `forget {id:<row in other ns>}` (S-5).
7. T7: `serve --http --auth oauth` on loopback: get a token with `scope=memory` through PKCE, then call `POST /v1/search`
   and `/v1/get` → expect 200 (S-6). This one needs the `remote` feature.
8. T8: a loopback MCP server stub that sends `ping` before the result, with `mcp --remote` → expect an empty result (PR-23).

## 5. Four-arm offline evaluation feasibility (phase 4)

| Label source | Rows | Eligible for query-level retrieval | Source |
|---|---|---|---|
| E1 query labels (`operator_label` / `e1_retrieval`, UI #933) | **0**; generator never triggered (0 `e1_retrieval_task`) | would be | #971 `EVALUATION_PROTOCOL.md` §1 (prod, 22-10); plan 20-10/21-10 |
| #835 discovery-relevance labels | 0 (14-10 and 22-10) | **no** (no query and no candidates) | `E1-RRF_RESULT.md` |
| `kb_retrieval` judgments | system log, mode shadow, decision always `yes` | **no** (not human relevance). Useful only as the query pool: 123 panel queries (plan 21-10) | `kb-corpus.ts:131-135` |
| `kb_passage_relevance` | 170 rows (132 yes / 38 no) | **no** (jev, NE-001) | #971 §1 |
| UX-24 fixture | 5 synthetic single-source queries | **no** | `E1-RRF_RESULT.md` |
| **Total eligible** | **0 < 30** | — | — |

**Verdict: INSUFFICIENT_EVIDENCE.** A four-arm comparison (existing `kbContext`/`rankContextResults`, native FTS5,
Leviathan, hybrid FTS5+dense RRF) cannot be run now. Two blockers come before the label count:

- **Pool bias.** E1 freezes candidates from `collectCandidates` (Qdrant/OKF/DjimitKB/experience), not from `kb_pages`
  and not from a lexical arm. A first-stage arm that returns unlabelled items would be scored as missing them. A fair
  four-arm test needs **pooled** labels: the blinded union of each arm's top-k on the same frozen `kb_pages` snapshot.
- **Arm overlap.** The Leviathan arm is FTS5 BM25 with `porter unicode61` and a title weight. Apart from boosts and
  group resolution, a native FTS5 arm with the same tokenizer and bm25 weights reproduces it, so a separate Leviathan
  arm adds a Rust build and little measurable difference.

**Labelling that would unblock it:** (1) the operator triggers `POST /api/self-improve/e1-labels/generate` and labels
≥ 30 of the 40 E1 tasks on `/decisions` (≈ 110 min by the #971 estimate). This closes E1 and measures fusion.
(2) For first-stage arms, ≥ 30 queries from the same `kb_retrieval` pool, labelled blind over a pooled candidate set
(top-5 of each arm, deduplicated) from one frozen `kb_pages` export. This is DKF S1 extended with pooling. It is the
same 30-query minimum, registered before scoring, with no jev or synthetic labels.

## 6. Decision (phase 5): **HOLD**

Leviathan is not adopted, vendored or run. The one capability it has that DjimitFlo lacks (real BM25) already ships in
DjimitFlo's SQLite, and no measurement shows that lexical retrieval would help.

| Factor | Assessment |
|---|---|
| ADOPT (binary / sidecar) | Needs a Rust toolchain in the `node:22-bookworm-slim` image or an unsigned prebuilt binary (sha256 only, tag-pinned actions, no attestation). It adds a second SQLite (C, via `cc`) and `ring`. The project is a 3-week-old 0.2.0 with one maintainer, 13 unmerged fix PRs and the open defects in §4. Its authz model (one token for all data, no namespace or group isolation, scope not enforced) would sit next to the JWT/permission routes and bypass #972 safe-only serving and the B19/jev gates. **Not justified** |
| ADAPT (vendor or port code) | Apache-2.0 allows it. The portable ideas are small: FTS5 schema, bm25 weights, facet tokens, keyed supersession. The supersession logic is the defective part (PR-13/13b). Porting the ideas is the same work as BUILD-NATIVE-FTS5 |
| BUILD-NATIVE-FTS5 | Zero new dependency, since better-sqlite3 compiles with FTS5. It is premature as a product change: E1 has 0 labels and an arm that only matches B is not promoted (#971 §6). It belongs in the offline scorer first, as DKF already planned |
| REJECT | Correct for Leviathan **as a dependency** under the current evidence, but it would close the lexical question, which is still open (gap a) |
| Maintenance / supply chain | Leviathan: Rust MSRV 1.88, edition 2024, 133 locked crates, bundled SQLite C plus `ring` build scripts, release binaries without provenance. Native FTS5: no new supply chain |
| Smallest reversible PR | **None is justified now.** The next step is operator labelling (§5, item 1). Only after ≥ 30 E1 labels exist, and if those labels show lexical misses, would a harness-only PR follow: an offline FTS5 arm in a `scripts/` scorer over a `kb_pages` export, plus pooled-candidate export, with prod untouched. That is the DKF slice step 6 |
| Evidence that would change the decision | (1) ≥ 30 pooled human labels where FTS5 or hybrid beats the dense arm with a paired-bootstrap CI above 0 → BUILD-NATIVE-FTS5 behind a flag. (2) Upstream merges fixes for I-26, PR-13 and PR-13b plus scope-bound tokens, and publishes signed or attested releases, **and** a labelled test shows Leviathan beating native FTS5 with the same tokenizer → reconsider ADAPT. (3) A tenant-isolated memory requirement appears: Leviathan's namespaces cannot meet it (S-5), so that pushes toward REJECT |
