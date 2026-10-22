# DKF-EVOLUTION-001: current state of the knowledge ecosystem (Phase A, read-only forensics)

**Date:** 2026-10-22. **Code:** origin/main `4a9cbdf4`. **Prod:** `djimitflo-live` running `5dfc6cd`. All prod access was
read-only: SQLite opened `{readonly:true}`, `docker exec`, and probe files removed afterwards.

**Workstation and NAS:** read over SSH as `djimit@100.81.133.48`. On the NAS I collected only directory listings, sizes,
file types and counts. The excluded areas were never entered: `family-media-all`, `family-photos-recovered`, `secrets`,
`#recycle` and backup dumps.

**Prior work reused and re-checked, not redone:**

- plan Phase L / K / UX-21 / UX-24 / E1
- `docs/research/l3-forensics/` (capability-graph, 20-10)
- `docs/research/mcp-a2a/SECURITY_GAPS.md`
- `docs/research/eco/E1-RRF_RESULT.md`
- draft #961 (`docs/research/jev-evolution/`)

`causal-evolution-003` is in progress with a sibling agent. This file does not cover causal attribution.

**Classification.** Capability: EXISTS / PARTIAL / MISSING / SUPERSEDED / UNKNOWN. Evidence: VERIFIED_RUNTIME (seen
running in prod or on a host today) / VERIFIED_CODE (wired in code, no runtime evidence) / DOCUMENTED_ONLY / UNVERIFIED.
A route, table or registry entry is never taken as proof that something runs.

`S/` = `packages/server/src/`, `M/` = `packages/mcp-server/src/`.

---

## 0. Headline findings

1. **Two different things are both called "OKF".** Google's Open Knowledge Format v0.2 is one. Djimitflo's own "OKF" is
   the other: a v0.1-era markdown convention with a flat key:value parser and `[[wikilinks]]`. They share an idea
   (markdown plus frontmatter) and the `type` key. They differ on required fields, link syntax, trust model and
   timestamps (§2.1). Nothing in Djimitflo code references Google's spec.
2. **DjimitKBWiki is closer to Google OKF than Djimitflo's OKF is.** Every one of the 1 313 compiled pages carries `type`,
   which is the only key v0.2 requires. Its `sources: [..]` are bundle-relative paths. It fails v0.2 in two places:
   - `log.md` headings are `## [YYYY-MM-DD HH:MM:SS] op`, while §9 requires `## YYYY-MM-DD`;
   - links are `[[wikilinks]]`, not markdown links.
3. **There is exactly one live knowledge→agent path**: DjimitKBWiki → `kb-sync` → `kb_pages` → `kbContext` →
   specialist-panel and committee prompts.
   - It is VERIFIED_RUNTIME: 142 `kb_retrieval` rows in 30 days, 36 in the last 7.
   - It is gated by a jev relevance filter running in **enforce** with **0 labels**.
   - It is fed by a vault that has not changed since 2026-09-12: kb-sync sent 0 pages on 20, 21 and 22 October.
4. **The labelling infrastructure exists but has never been used.** Prod has 0 `operator_label` rows of any kind and 0
   E1 frozen tasks, although both labelling UIs are in the prod build `5dfc6cd`:
   - the E1 UI (#933), merged 2026-10-21, so one day old;
   - #835, merged 2026-10-15.

   This is why E1 stays INSUFFICIENT. The remaining step is an operator action, not code.
5. **Content-safety coverage of the KB is 65 %, not about 100 %.** 456 of 1 313 pages have no yes/no verdict, because
   NVIDIA returned 429s and timeouts. Unchanged pages are never re-sent, so this does not self-heal.
6. **The workstation KB maintenance jobs are dead.**
   - The NAS backup rsync, `daily-validate.sh` and the weekly `rebuild_indexes.py` all redirect their output into
     `~/djimit/DjimitKBWiki/logs/`, which no longer exists. The two scripts are also missing from the vault.
   - Cron fires every day; the commands do not run.
   - The NAS wiki snapshot is frozen at **2026-07-01** while the vault moved on to 2026-09-12.
   - L3 had marked `ws.kbwiki_maintenance` ACTIVE. **This is a correction.**
7. **The vector layer is heavily duplicated.**
   - There are two Qdrant 1.19.1 instances. The workstation one is used by KBWiki. The agenticservices one,
     `100.77.58.72`, is prod's `QDRANT_URL`. They hold the same collection names with diverged counts: `djimit_okf`
     25 581 vs 30 575, and `djiment_kb` 25 854 vs 60 618.
   - There are three embedding spaces (2048 / 768 / 384), five embedding clients, six or more memory stores and four
     claim tables.
   - No sqlite-vec or FTS5 exists anywhere.
8. **No knowledge has a validity interval.** `kb_pages`, `memory_candidates`, OKF files and three of the four claim
   tables carry no valid_from/valid_to or supersession. Only `expert_affiliations` has `valid_from/valid_to`, and
   `swarm_claims` has `valid_until` + `invalidated_by`. Decisions live in three ADRs and in PR prose. No decision record
   table links a decision to its rationale and evidence.

---

## A1. Infrastructure

### 1.1 NAS (Synology `//192.168.1.92/NAS`)

- **Protocol and mount:** SMB/CIFS **3.1.1**, `cache=strict`, mounted `rw` through **autofs** at `/mnt/nas` on the
  workstation (`systemd-1 autofs … direct, timeout=300`). The fabric must use it read-only. The mount itself is rw.
- **Capacity:** 1.8 T total, **1.4 T used (75 %)**, 446 G free. On 2026-09-27 it was 69 %, so usage grew 6 points in
  about 4 weeks.

| Top-level dir | Size | Contents (names and types only) | Fabric relevance |
|---|---|---|---|
| `workstation-backup/` | 250 G | `restic/` 170 G, `restic-stale-20260508/` 80 G (backup dumps, **excluded**), `wiki/` **660 M**, `memory-evolution/` 0 | `wiki/` = DjimitKBWiki snapshot. **Candidate corpus** |
| `vps-backups/` | 53 G | `vps-agenticservices/` 34 G, `vps-agentical/` 11 G, `archive-20260928/` 5.0 G, `paperclip-retirement-20260921/` 3.1 G, `retired-20260928-agenticservices/` 1.5 G | backups (excluded), except the Paperclip JSONL history already analysed in Phase L3 (aggregates only) |
| `qdrant-snapshots/` | 810 M | `knowledge_base_v2/*.snapshot`: 4 × 202 MB, one per night 02:30 (19–22 Oct), from the workstation Qdrant (18 957 points) | vector backup, not knowledge |
| `workstation-retirement-20260730/` | 461 M | `djimitflo/` 208 M, `manifests/` | retired host archive |
| `ai-workstation-backup/` | 200 K | `inventory-20260505/` (system-info, git-repos list), `pre-server-migration-…/` | inventory text |
| `agent-shared/` | 56 K | 12 files dated 23 Apr – 1 May: `decisions/` 1, `infrastructure/` 4 (**incl. `credentials-refs.md`**), `runbooks/` 3, `protocols/` 1, `task-queue/PROTOCOL.md`, 2 state JSON | **stale** (Phase L5 parked it: pre-VPS-migration ops facts) |
| `family-media-all/`, `family-photos-recovered/`, `secrets/`, `#recycle/` | not measured (excluded) | — | **never** |

The excluded areas together are about 1.1 T: 1.4 T used minus 305 G measured.

NAS `workstation-backup/wiki/`:

- 4 287 `.md` files: 1 014 summaries, 1 014 sources, 893 `10 Raw/repos`, 249 concepts, 47 entities, 24 reports, about
  1 000 flat `raw/*.md`, and 10 copies of `nas-agent-shared`.
- It also contains a **627 M embedded `qdrant-storage/`**, a `.env` file (name seen; contents not read), 56 `.dat`,
  14 `.bin` and 1 PDF.
- Newest file: **2026-07-01**.

### 1.2 Workstation (`100.81.133.48`): DjimitKBWiki and its jobs

**Vault:** `~/djimit/DjimitKBWiki` (origin `github.com/djimit/DjimitKBWiki`). Last commit `0aa9473c`, 2026-09-12. 11
commits since 2026-09-01.

| Folder | Files |
|---|---|
| `wiki/concepts` | 252 |
| `wiki/entities` | 47 |
| `wiki/summaries` | 1 014 |
| `wiki/sources` | 1 014 |
| `wiki/reports` | 24 |
| `wiki/projects` | 1 |
| `synthesis`, `explorations` | 0 |
| `raw/` | 1 004 |
| `10 Raw/` | 233 |

The vault is compiled by OpenKB (`wiki/AGENTS.md` "Wiki Schema"; `.openkb/`). Its frontmatter is managed by code:

- concepts: `type` 252/252, `sources` 251, `description` 249;
- summaries: `type`, `description`, `doc_type`, `full_text`.

`type` values: Summary 1 014, Concept 249 (+3 `concept`), Work 24, Other 16, Organization 4, Product 3. There is an
`index.md`, a `log.md` and `[[wikilinks]]`.

| Job | Schedule | Observed state (2026-10-22) | Class |
|---|---|---|---|
| `djimit-kb-sync.timer` → `~/.djimit/bin/kb-sync.mjs --max 400` (user unit) | daily 04:30 | runs, exit 0. **"0 changed page(s) … sent 0"** on 20, 21 and 22 Oct | EXISTS · VERIFIED_RUNTIME (idle: source static) |
| cron `wiki-delta-emitter.sh` | */15 | runs, logs "no new commits" | EXISTS · VERIFIED_RUNTIME (idle) |
| cron `qdrant-snapshot-knowledge-base-v2.sh` | 02:30 | OK, 18 957 points, snapshot to NAS | EXISTS · VERIFIED_RUNTIME |
| cron rsync vault → NAS `workstation-backup/wiki` | 03:00 | CRON fires; **redirect target `logs/` missing, so the command never starts**; NAS copy frozen 2026-07-01 | **broken** · VERIFIED_RUNTIME |
| cron `scripts/daily-validate.sh` | 07:20 | script **absent** from the vault, and `logs/` missing | **broken** · VERIFIED_RUNTIME |
| cron `tools/qdrant/rebuild_indexes.py` | Sun 04:00 | script **absent** (the copy lives in prod `djimitflo-knowledge/tools/`) | **broken** · VERIFIED_RUNTIME |

**Workstation Qdrant 1.19.1** (`0.0.0.0:6333/6334`, API key). It has 24 collections, all Cosine, all 768-d except where
noted:

| Collection | Points | Notes |
|---|---|---|
| `djiment_kb` | 25 854 | |
| `djimit_okf` | 25 581 | |
| `knowledge_base_v2` | 18 957 | named vector `dense`, 768 |
| `litellm-cache` | 8 062 | |
| `djimit-skills` | 1 084 | |
| `agent_shared_memory_v2` | 548 | |
| `chunks-persona` | 491 | |
| `rechtspraak-benchmark` | 337 | |
| `action_items` | 252 | |
| `dennis-knowledge` | 175 | |
| `ollama_docs` | 88 | |
| `openai_docs` | 70 | |
| `djimitkb-wiki` | **58** | |
| `djimitflo_reasoning` | 8 | |
| `djimitflo_explainers` | 1 | 384-d |
| `djimitflo_swarm` | 0 | 384-d |
| `signals` | 0 | |
| others | ≤ 40 | |

Most of these are populated by tools outside the Djimitflo repo. `djimitkb-wiki` has only 58 points against about
1 300 compiled pages, so it is not the KB index Djimitflo uses.

### 1.3 agenticservices (`100.77.58.72`) and prod VPS (`100.86.47.122`)

- **agenticservices** runs a second Qdrant 1.19.1. It is reachable from prod with prod's key; the workstation key is
  refused. It has the **same 24 collection names plus `authority_events`** (1 797 points, 1-d). Counts have diverged:

  | Collection | Workstation | agenticservices |
  |---|---|---|
  | `djimit_okf` | 25 581 | 30 575 |
  | `djiment_kb` | 25 854 | 60 618 |
  | `djimitkb-wiki` | 58 | 63 |
  | `djimit-skills` | 1 084 | 1 195 |
  | `agent_shared_memory_v2` | 548 | 793 |
  | `djimitflo_swarm` | 0 | 87 |
  | `djimitflo_explainers` | 1 | 43 |
  | `knowledge_base_v2` | 18 957 | absent |

  Which copy is the source of truth: UNKNOWN. **DUPLICATED.**
- **UAMS:** `UAMS_URL=http://100.77.58.72:8000`. The plan memory says MacBook→UAMS needs SSH. Its status from prod was
  not probed (UNVERIFIED).
- **Prod container mounts:** `/srv/djimitflo/djimitflo-knowledge → /app/djimitflo-knowledge` (**rw**) with
  `OKF_BASE=/app/djimitflo-knowledge/okf`; `/srv/djimitflo/data → /data`.
- **Code default.** `QDRANT_URL` defaults to `http://192.168.1.28:6333` in code, the workstation LAN address. That breaks
  the "VPS never calls the workstation" rule if the env var is ever dropped. Prod overrides it.
- **MacBook:** the ChatGPT export analysis exists at `~/Downloads/chatgpt-export-analysis` (4.0 M, 12 files incl.
  `djimit-conversations.jsonl` 1.7 MB). Its contents were not read. It is **private and local only**.

---

## A2. Djimitflo knowledge, memory, retrieval, OKF, wiki and DI code paths

### 2.1 "OKF" in Djimitflo vs Google Open Knowledge Format v0.2

**Source for Google OKF v0.2:** `GoogleCloudPlatform/open-knowledge-format` `SPEC.md`, HEAD `ad30107c` (2026-08-21),
Apache-2.0. It was fetched with `gh api` and read in full.

| Aspect | Google OKF v0.2 | Djimitflo "OKF" (code) | DjimitKBWiki (OpenKB) |
|---|---|---|---|
| Unit | bundle = directory of `.md`. Concept ID = path minus `.md` | directory `OKF_BASE`, folders `skills, agents, memory, services, repos, models` (`M/tools/okf.ts:18`) plus `concepts/`, `tasks/` written by services | `wiki/{concepts,entities,summaries,…}` |
| Frontmatter syntax | YAML (nested maps and lists: `generated: {by, at}`, `sources: [{id, resource, …}]`) | **flat `key: value` line parser**; only `[a, b]` becomes an array (`M/tools/okf.ts:49-60`; a second parser is `knowledge-runtime-service parseMarkdown`). **Nested v0.2 fields would be mangled** | YAML (flow lists) |
| Required | **`type` only** (§4.1, §11) | `okf_validate`: `['type', 'title', 'description', 'timestamp', 'tags']` (`M/tools/okf.ts:283`). Capability contract: 6 keys (`knowledge-runtime-service.ts:19`). Specialist profile: 4 keys (`:579-584`). Python `validate_okf.py` lives outside the repo (`:365-380`) | `type` (code-managed) |
| Recommended | `title`, `description`, `resource`, `tags` | — | `description` |
| Timestamp | `generated.at` (ISO 8601 with offset). **`timestamp` is superseded** (§13.1, breaking change from v0.1) | `timestamp` **required**, i.e. the v0.1 field | none (`created`/`updated` on 3 pages) |
| Provenance | `sources[]` entries: `resource` REQUIRED; plus `id`, `title`, `author`, `usage_count`, `last_modified`; `usage_window`; footnote `[^id]` per claim | `source_ref`, `source_path` (free text) | `sources: ["summaries/x.md"]`, a list of strings with no `resource` key |
| Trust | `generated.by` and `verified[]` with actor convention `agent/ver`, `human:id`, `process:id`. Tier derived, **no stored score** (§5.1, §5.3) | `trust_level` (371/413 prod docs), `approved_by` (free text), `confidence` and `verification` (updater) | none |
| Lifecycle | `status: draft\|stable\|deprecated` (absent = stable); `stale_after` (absolute instant) | `status` on 14/413 docs | none |
| Links | standard markdown links, `/`-absolute recommended. Untyped edges. Broken links tolerated | `[[wikilinks]]`; `okf_related` does BFS ≤ 3 over them (`M/tools/okf.ts:211`) | `[[wikilinks]]` |
| index.md / log.md | optional; index has no frontmatter except root `okf_version`; log uses `## YYYY-MM-DD` (MUST) | one root `index.md` | `index.md` (wikilinks); `log.md` uses `## [YYYY-MM-DD HH:MM:SS] op`, which **violates §9** |
| Attested Computation | `type: Attested Computation` + `runtime`, `parameters`, `executor`, `attester` | — | — |
| Extensions | any extra key allowed. Consumers SHOULD preserve unknown keys on round-trip and MUST NOT reject | not round-tripped: `OkfKnowledgeUpdater` rewrites whole files (`okf-knowledge-updater.ts:99-109`) | code-managed |
| Conformance stance | permissive: never reject for missing optional fields, unknown types, unknown keys or broken links | **strict**: a missing key FAILs `okf_validate`. A failed Python validation blocks `syncCapabilities` and turns `/health knowledgeRuntime` to error (`routes/health.ts:103-109`) | — |
| What it does NOT define | storage, serving, query, a taxonomy of types, access control (trust tiers are "advisory, not access control", §5.3), typed relations, temporal validity / supersession beyond `deprecated`, a confidentiality label, the receipt and attester ABI (deferred, §12) | — | — |

**Verdict: different things that share a name.** Djimitflo's OKF predates v0.2 and is incompatible with it in three
ways:

1. It requires `timestamp`, which v0.2 retired.
2. Its parser cannot read v0.2's nested trust and provenance fields.
3. Its validator rejects documents that v0.2 declares conformant.

Djimitflo's own writer also violates Djimitflo's own validator. `OkfKnowledgeUpdater` writes
`type, title, confidence, verification, domains, sources, updated` and omits `description`, `timestamp` and `tags`.

The comment "OKF (Open Knowledge Format)" at `M/tools/okf.ts:2` is the only expansion of the acronym. Nothing references
Google's repository.

**Prod OKF bundle** (`/srv/djimitflo/djimitflo-knowledge/okf`):

- 413 `.md` files: memory 260, tasks 98, runs 26, services 9, skills 8, governance 6, agents 5, root index 1.
- 284 changed since 2026-09-27. By month: 63 from July, 148 from September, 202 from October.
- `type` counts: MemoryCandidate 162, Reasoning 98, CompletedTask 98, TrainingCycle 25, Service 9, Skill 8, Agent 5,
  Concept 3, others 1 each.
- Key counts: `type` / `title` / `timestamp` 413, `trust_level` 371, `description` and `tags` 259. So **154 docs fail
  Djimitflo's own `okf_validate`**.
- `memory/` is written by the container user (`paperclip` uid on the host) when memory candidates are promoted. Prod has
  189 promoted candidates.
- The plan's "129 docs" on 27-09 has grown to 413, almost all machine-written run and memory exhaust, **not** curated
  knowledge.
- Maintenance jobs (`knowledge_maintenance_runs`): `okf_sync_drift` 32 runs, `wiki_delta` 32, `okf_lint` 5. All `ok`,
  **0 findings**, last run 22-10. That a lint finds 0 issues while 154 docs miss required keys means the lint checks
  something else. UNVERIFIED which rules it applies.

### 2.2 Component inventory

Prod counts are from read-only probes on 2026-10-22, with a 30-day window unless stated.

| Component | Code (file:line) | Flags (prod value) | Store | Prod evidence | Class |
|---|---|---|---|---|---|
| **KB ingest** (kb-sync → `/api/gym-worker/kb`) | `scripts/kb-sync.mjs`; `S/routes/remote-gym.ts:67` (host spawn token, `middleware: []` at `routes/index.ts:192`); `S/services/kb-corpus.ts:25-50` (≤ 20 pages/call, 20 k body cap, path regex, sha256, content_safety, NVIDIA embed) | `KB_CONTEXT_ENABLED=true`, `NVIDIA_API_KEY` set | `kb_pages(path PK, host, title, body, sha, vector BLOB, updated_at, embedding_model, embedding_dim)` | 1 313 pages (summaries 1 014, concepts 252, entities 47), all host `workstation`, avg body 1.9 k chars, 2.5 M chars total. `updated_at` 27-09 → **06-10**. **embedding_model/dim NULL on all 1 313** | EXISTS · VERIFIED_RUNTIME |
| **kbContext retrieval** | `kb-corpus.ts:55-94`: full-table cosine scan, cos ≥ 0.3, k = 3, P1 seal (`:60-69`), framing (`:88`) | same | reads `kb_pages`; logs `kb_retrieval` judgments (shadow) | 142 `kb_retrieval` in 30 d (36 in 7 d; last 22-10 00:29Z). Callers: specialist panel (`self-improvement-agent-review-service.ts:250`, 415 panels in 30 d) and committee (`committee-swarm.ts:85`, 134 jobs, last 19-10; `COMMITTEE_SWARM_ENABLED=false` now). 0 `self_improvements` carry `kb:`/`okf:` evidence refs | EXISTS · VERIFIED_RUNTIME |
| **kb_passage_relevance** (jev gate) | `kb-corpus.ts:98-112` (`gatePassages`; < 0.5 dropped under enforce) | `TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=enforce` (since 28-09, plan "cost lever" #520) | `judgments` | 170 enforce rows (132 yes / 38 no), 452 page verdicts, 88 dropped (#961). **0 labels** | EXISTS · VERIFIED_RUNTIME · **unvalidated acting path** |
| **content_safety** | `S/services/content-safety.ts:6-24,58,117,139`, model `nvidia/nemotron-3.5-content-safety` | `CONTENT_SAFETY_MODE=shadow`, `SCOPE=decision`; KB ingest acts in every mode (`kb-corpus.ts:40`) | `judgments` | 30 d: 6 096 rows. All time: 2 085 yes, 18 no, **3 993 error** (http_429 3 762, timeout 229). kb_page: 857 yes / 9 no / 462 error; **456 pages unverdicted** | PARTIAL · VERIFIED_RUNTIME |
| **P1 integrity seals** | `kb-corpus.ts:60-69`; memory rules `assignment-context.ts:92-123` | — | `judgments` `artifact_integrity` | 0 rows (no drift seen) | EXISTS · VERIFIED_CODE |
| **Djimitflo OKF MCP tools** | `M/tools/okf.ts`: `okf_search` :117 (substring scan, no index), `okf_get` :167 (#914 containment :37-47), `okf_related` :211, `okf_validate` :271, `okf_status` :332 (always `healthy`) | no permission checks | files | MCP call counts: UNKNOWN (no MCP call log in DB) | EXISTS · VERIFIED_CODE |
| **KnowledgeRuntimeService** (OKF → capabilities) | `S/services/knowledge-runtime-service.ts:16-19,91,156,365-380,474-499` | `OKF_BASE` | files → capability rows | health surfaces it; `okf-synchronization-loop` in catalog (`packages/shared/src/loop-catalog.ts:33`) has **0 `loop_runs` ever** | PARTIAL · VERIFIED_CODE |
| **OkfKnowledgeUpdater** | `S/services/okf-knowledge-updater.ts:15,99-109`; bootstrap constructs and `void`s it (`S/bootstrap/autonomous-services.ts:441-443`); real caller is only `S/scripts/run-autonomous-cycle.ts:75-76` | — | `okf_knowledge_updates` | **0 rows** | MISSING in runtime (script-only) |
| **Knowledge maintenance** | `S/services/knowledge-maintenance-service.ts:8-26,104` (jobs okf_sync_drift, wiki_delta, okf_lint) | `KNOWLEDGE_MAINTENANCE_ENABLED=true` | `knowledge_maintenance_runs` | 69 runs, all ok, 0 findings | EXISTS · VERIFIED_RUNTIME (signal-free) |
| **Context injection (multi-source RAG)** | `S/services/context-injection-service.ts:12-13,33,57,139-171,190,225,279`: Qdrant `djimitflo_swarm` (nomic 768), `djimit_okf` (Qdrant despite the name `searchOkfMcp`), DjimitKB MCP `:8008`, experience retrieval. `rankContextResults` = trust tier then raw score | `RETRIEVAL_NORMALISE_SCORES` (off) | Qdrant (agenticservices) | callers: `routes/tasks.ts`, proof-run, e1 labels. Prod use rate UNKNOWN. L3 F5: Qdrant swarm path dead (nomic 404 at agenticservices, 384 vs 768 dim) | PARTIAL · UNVERIFIED runtime |
| **Retrieval eval harness (UX-24) + RRF** | `S/services/retrieval-eval.ts:50,88`; `scripts/e1-rrf-score.mjs` | — | — | harness only; E1 INSUFFICIENT | EXISTS (offline) · VERIFIED_CODE |
| **E1 labelling UI (#933)** | `S/services/e1-retrieval-labels.ts`; routes `S/routes/self-improvement.ts:166-180`; `packages/dashboard/src/pages/E1RetrievalLabelSection.tsx` | generate needs `manage:config` | `judgments` (`e1_retrieval_task` frozen; `operator_label`) | **0 tasks, 0 labels** | EXISTS · VERIFIED_CODE, never used |
| **#835 discovery relevance labels** | `discovery-relevance-labels.ts` | — | `judgments` `operator_label` | **0** | EXISTS · never used |
| **Knowledge fitness K1 (#863)** | `S/services/knowledge-fitness.ts:5-40` (min n 5, half-life 30 d, window 90 d); `S/services/knowledge-overview.ts:121` → `GET /api/health/knowledge` | read-only | derived | runs on request; L3: knowledge credit cannot discriminate yet | EXISTS · VERIFIED_CODE |
| **Knowledge gaps (#864)** | `S/services/knowledge-gaps.ts:21-22`; callers `loop-daemon.ts:937`, `expert-council-service.ts:145` | `KNOWLEDGE_GAP_MODE=shadow` | `judgments` `knowledge_gap` (`knowledge_gaps` table 0 rows) | 13 open gaps (failure signatures), 16–19 Oct | EXISTS · VERIFIED_RUNTIME (shadow) |
| **Outcome attribution** | `S/services/outcome-attribution.ts:5-17,209-214` | `OUTCOME_ATTRIBUTION_ENABLED=true` | `judgments` (annotation), `outcome_credits` | 189 annotations (30 d); credits: reviewer 164, memory_rule 162, example 99, maker 82, model 23, judgment 14, genome 3; **knowledge 0** | EXISTS · VERIFIED_RUNTIME |
| **Memory candidates and rules** | `S/services/memory-candidate-service.ts:99-460` (Qdrant flywheel `:362`, UAMS sink stub ~`:455`); injection `assignment-context.ts:79-130` | `LOOP_MEMORY_RULES_ENABLED=true`, `MEMORY_CANDIDATE_REVIEW_ENABLED=true`, `MEMORY_HOLDOUT_RATE=0.3`, `MEMORY_TEMPLATE_DEDUP_MODE=shadow` | `memory_candidates` (235: 189 promoted), `memory_access_log` | 937 reads in 30 d over **19 distinct** candidates; holdout readout due 27-10 | EXISTS · VERIFIED_RUNTIME |
| **Other memory stores** | `central_memories` (`memory-store.ts:50`); `proactive_memories` (`proactive-memory-service.ts:412`); `vector_memories` (`vector-memory-service.ts`, "BM25+RRF" is actually `0.6·dense + 0.2·bm25 + 0.2·bandit`, `:127`); `segml_fleet_memory` (created twice); `cognitive_episodes`; reasoning bank (Qdrant `djimitflo_reasoning`) | — | — | central_memories 893 episodes (loop-daemon); proactive 0; vector_memories 0; segml 0; reasoning bank **write-only** (L3) | central: EXISTS · VERIFIED_RUNTIME (write-only); others: SUPERSEDED / dormant |
| **MemorySync → UAMS + Qdrant + OKF** | `S/services/memory-sync-service.ts:9-11,25,60-93,138,205` | `UAMS_URL` set | UAMS, `djimitflo_swarm` (384), OKF `tasks/` | 98 OKF `tasks/` docs exist → the OKF leg runs; UAMS and Qdrant legs UNVERIFIED | PARTIAL |
| **Frontier Experts** (persons → areas) | `expert-*` tables (`S/database/migrate.ts:2005-2141`); `expert-areas.ts` | `DJIMITFLO_FRONTIER_EXPERTS_ENABLED=true`, scheduler false, `FRONTIER_EXPERT_SOURCE_UNITS_ENABLED=true` | expert_* | identities 4 568, claims 2 265 (2 263 `undetermined`), evidence 15 197, versions 25 007. Claims `temporal_scope` empty on all. 379 `frontier_experts` LLM calls in 30 d. Persons→areas applied 14-10 (persons 1 094 → 0) | EXISTS · VERIFIED_RUNTIME (knowledge unused: 0 proposals cite units, L3) |
| **Explainer** | `M/tools/explainer.ts:188-377`; server `routes/explainer.ts`; Qdrant `djimitflo_explainers` (384, snowflake) with `valid_until` per chunk | `DJIMITFLO_EXPLAINER_AUTONOMY` on by default | `explainer_*`, `repo_graph_snapshots` | 120 bundles; 19 tasks in 30 d, **0 in 7 d** (last 09-10) | EXISTS · VERIFIED_RUNTIME (idle) |
| **OpenWiki** | `openwiki/` (generated by `.github/workflows/openwiki-update.yml`; `.last-update.json` `status: interrupted` 2026-09-25); reader `S/services/commons-grounding.ts:53` | `COMMONS_AGENDA_GROUNDING=false` | repo files | NE-003 Commons grounding REJECT | PARTIAL · reader off |
| **DjimitKB HTTP clients** | `S/services/knowledge-adapters/djimitkb-adapter.ts:11` (`:8007`); `context-injection-service.ts:33,279` (`:8008`); `evidence-service.ts:67` (no caller) | `DJIMITKB_URL` / `DJIMITKB_MCP_URL` unset in prod | — | — | DUPLICATED · UNVERIFIED |
| **NotebookLM tools** | `M/tools/notebooks.ts:16-26` (Python bridge, no permission check; S6) | — | Google NotebookLM (external) | — | EXISTS · must stay away from private corpora |
| **Claims** | `swarm_claims` (`migrate.ts:1089`, has `valid_until`, `invalidated_by`, `supports_ref`, `contradicts_ref`); `knowledge_claims` (`:2174`, duplicated at `knowledge-sharing-service.ts:201`); `expert_claims` (`:2077`, SPO + polarity + `temporal_scope` + support_status); `research_claims` | — | — | swarm 400 (last 13-09), knowledge 5 (last 11-07), expert 2 265, research 42 (last 16-07); 1 `CONTRADICTS` relation (unresolved) | DUPLICATED ×4 |
| **Decision records** | ADRs `docs/adr/0001-0003` (docs only); `swarm_decisions` (`migrate.ts:1191`, 11 rows, last 08-09); `approvals` (509); `authority_events` (`:1290`); `judgments.provenance_json` | — | — | no decision → rationale → evidence → supersession model | PARTIAL / DOCUMENTED_ONLY |
| **Knowledge publish** | `POST /api/knowledge/publish` (`S/routes/knowledge.ts:26`, `write:claim`, S4 fix); second path `POST /api/swarms/knowledge/publish` (`swarm-intel.ts:70`) | — | in-process bus / `knowledge_claims` | — | DUPLICATED · VERIFIED_CODE |
| **`djimitflo_memory_search` MCP** | `M/tools/platform.ts:39-50` (LIKE over memory_candidates, no permission check) | — | — | — | EXISTS · gap (T12) |

### 2.3 Tests that pin the knowledge paths (present on main)

- KB: `kb-corpus.test.ts`, `kb-passage-gate.test.ts`, `embedding-hygiene.test.ts`, `content-safety-prompt-gate.test.ts`
- OKF: `M/__tests__/okf.test.ts`, `knowledge-tools.test.ts`
- Retrieval and labels: `retrieval-eval.test.ts`, `retrieval-e1-rrf.test.ts`, `e1-retrieval-labels.test.ts`
- Knowledge services: `knowledge-maintenance.test.ts`, `knowledge-gaps.test.ts`, `knowledge-fitness.test.ts`,
  `knowledge-overview.test.ts`, `knowledge-routes.test.ts`, `okf-knowledge-updater.test.ts`
- Other: `negative-evidence.test.ts`, `fe-areas.test.ts`

Memory note: OKF and knowledge tests must isolate `OKF_BASE`, because the `knowledge` symlink is absent in CI.

---

## A3. Agents and swarms: real invocation frequency and knowledge dependencies

Prod, 30 days to 2026-10-22, counted from SQLite:

| Agent / loop | Invocations (30 d / 7 d) | Reads knowledge | Writes knowledge |
|---|---|---|---|
| repo-maintenance-loop | 1 044 / — (1 011 completed) | memory rules (assignment context) | OKF `runs/`/`tasks/`, central_memories |
| evolution-gym | 945 (942 completed) | holdout tasks; `DREAM_EVIDENCE_SOURCES` (K1 refs, off) | genome trials |
| doc-drift-and-small-fix-loop | 352 (208 completed) | memory rules | — |
| tg-001 | 90 | — | — |
| okf-synchronization-loop | **0 ever** | — | — |
| specialist panels (auto review) | 415 / 86 | **kbContext** (only live KB consumer) + OKF specialist profiles | `kb_retrieval` judgments |
| committee swarm | 134 / 23 (last 19-10; now disabled) | recipes: kb, experts, memory, skills, discoveries (`committee-swarm.ts:79-103`) | forecasts |
| worker leases (makers/checkers) | 3 556 / 811 | assignment context: memory rules (937 reads / 19 rules) | — |
| Commons residents (7) | ≈ 636 LLM calls; 4 480 agent_messages | Commons threads (grounding off) | proposals |
| frontier_experts | 379 LLM calls | external papers/repos | expert_* |
| explainer | 19 tasks / 0 | repos, Qdrant explainers | bundles, UAMS |
| council (`djimitflo_council_ask`) | 0 (last session 21-09) | — | — |
| jev | 2 543 calls | judged state (incl. KB passages) | judgments |
| embeddings (NVIDIA) | 362 calls | — | vectors |

Takeaway: of about a dozen active agents, **one** consumes the KB (panels, through kbContext). The busiest loops consume
only memory rules, and only 19 of them. The rest of the "knowledge" surface (OKF, Qdrant, UAMS, experts, explainer) is
written far more than it is read.

---

## A4. Classification summary: duplicated, abandoned, reusable

**Reusable as the base of the fabric:**

- `kb-sync` push model and host-token route
- `kb_pages` with the P1 seal
- `content_safety`
- `kbContext` call sites
- `retrieval-eval.ts` (RRF, bootstrap)
- the E1 and #835 labelling UI pattern
- `judgments` provenance
- knowledge-fitness, outcome-attribution and the NE registry
- `expert_affiliations` (the only as-of query, `frontier-expert-registry-service.ts:176`) and `swarm_claims` (validity +
  invalidation) as temporal templates
- DjimitKBWiki as the curated corpus: already `type`-carrying, close to OKF v0.2

**Duplicated, each with a consolidation candidate (no change proposed here):**

- 2 Qdrant instances with the same collection names
- 3 embedding spaces and 5 embedding clients (proposal-dedupe NVIDIA; `embedding-provider.ts`;
  `ollama-embedding-provider.ts`; inline fetches in memory-sync, reasoning-bank, context-injection,
  memory-candidate-service, experience-retrieval and explainer-knowledge). `EMBEDDING_MODEL` means two different things
  in two code paths.
- 6+ memory stores
- 4 claim tables
- 2 knowledge-publish routes
- 2 DjimitKB HTTP clients (ports 8007 and 8008)
- 2 OKF base resolvers, 2 frontmatter parsers, 3 OKF validators
- 2 MCP `registerTools` with different tool sets; the expert MCP tools are test-only
- KBWiki's `tools/{qdrant,graphstore}` copied into prod `djimitflo-knowledge/tools/`

**Abandoned or inert:**

- `OkfKnowledgeUpdater` at boot
- `okf-synchronization-loop` (0 runs)
- reasoning bank (write-only)
- `proactive_memories`, `vector_memories`, `segml_fleet_memory` (0 rows)
- `knowledge_claims` (5 rows, last July), `research_*` (last July)
- `services/reasoning-loop.ts` (no importer)
- `EvidenceService.captureAssessmentEvidence`
- `bootstrap/core-services.ts` (no importer)
- the UAMS promote sink (stub)
- the workstation KBWiki crons (§1.2)
- `agent-shared` (stale since April)

**SUPERSEDED:**

- Paperclip as the work plane (ADR 0001)
- nomic-embed for G6 (retired at agenticservices; still referenced in 5 code paths)
- the persons-based Frontier Experts (→ areas, 14-10)
- OKF `timestamp` (superseded in Google v0.2 by `generated.at`)

Machine-readable version: `capability-graph.json`. Its node and edge fields follow
`docs/research/l3-forensics/capability-graph.json`.
