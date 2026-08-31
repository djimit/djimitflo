# feat: grounded Q&A knowledge pack + autonomous explaining fleet

## What changed

### New: Repo Explainer Fleet ("Explain My Repo" pipeline, full evolution)

- **Evidence pipeline**: clone → scan → structural graph → `RepoEvidencePacket` (token-budgeted facts with file:line / graph-node / README citations) → `ExplainerAuthorService` (LLM author with forced `[E-n]` citation contract + deterministic template fallback) → 3-dimension critic grade-loop with 3 retries and `human_review_queue` fallback.
- **Mermaid architecture diagrams** generated from graph communities/hubs with syntax validation + auto-repair; textual equivalents for screen readers bundled inline.
- **Knowledge pack** (`ExplainerKnowledgeService`): atomic chunking of published bundles, real semantic embeddings via Ollama `snowflake-arctic-embed:s` (384d, batch `/api/embed`), Qdrant persistence with `valid_until` freshness per chunk, and graceful file-bundle keyword fallback (EC-006) when Qdrant is unavailable.
- **Grounded Q&A** (`ExplainerAskService` + `POST /api/explainer/ask`): retrieve → generate (forced `[E-n]` citations, `NOT_IN_CONTEXT` protocol) → verify (fabricated-citation detection) → answer/refuse. Three distinct refusal types: `NOT_ENOUGH_EVIDENCE`, `NOT_IN_CONTEXT`, `NOT_ENOUGH_GROUNDING` (unmarked answers are refused, never fabricated). Extractive fallback returns ranked cited evidence when the LLM is down. FR-015 lineage: every ask persisted to `explainer_audit_log` with grounding metrics and latency.
- **MCP tools** (`explainer_search_repo`, `explainer_get_fact`, `explainer_compare_repos`, `explainer_ask`) — real implementations replacing mocks; ESM-safe (`node:fs` imports).
- **Autonomous fleet worker** mounted in bootstrap: 30s job tick + 10-min drift timer (staleness, score regressions, never-published repos → UAMS alerts). Honors kill-switch. `DJIMITFLO_EXPLAINER_AUTONOMY=false` opts out.
- **Public explore pages**: sitemap.xml, robots.txt, README badge widget (SVG), `llms.txt`, per-repo MCP manifest endpoint.
- **Governance closed loop**: `GET /review-queue` + `POST /review-queue/:id/resolve` (approve→publish, reject→unpublish, audit-logged); kill-switch endpoint; bundle unpublish with audit trail.
- **Test-isolation hardening**: `NODE_ENV=test` guards on every real-infra write path (Qdrant embed/search, UAMS posts) after test-run pollution of production Qdrant was discovered in live debugging.

## Why

Evolves the explainer system from "documents that exist" to a queryable, verifiable knowledge agent: semantic search scores 0.71–0.83 on synonym queries with zero lexical overlap; every LLM answer is claim-verifiable against evidence or explicitly refused (RKD pattern: refusal-is-a-feature).

## Migration steps

- Optional env: `QDRANT_API_KEY`, `QDRANT_URL`, `DJIMITFLO_EMBED_MODEL` (default `snowflake-arctic-embed:s`), `DJIMITFLO_ASK_LLM_MODEL` (default `glm-5.2:cloud`), `DJIMITFLO_EXPLAINER_AUTONOMY` (default on).
- Pull `snowflake-arctic-embed:s` on the Ollama host for semantic embeddings; without it the system degrades to lexical placeholder vectors (no failure).

## Breaking changes

None. All new endpoints are additive; existing schemas extended with nullable columns only (`users.organization_id` via migration, `GitHubRepo.size`).

## Known caveats

- `POST /ask` requires `read:repository` auth; there is intentionally no unauthenticated public ask surface yet (governance deferred until demand exists).
- Qdrant point ids use 32-bit FNV hashing — collision risk grows with bundle count; upgrade to SHA-256-derived u64 is planned feedback (review finding #11, non-blocking).
- Multi-tenancy: `users.organization_id` defaults to `'default'` when absent — backfill for org partitioning is separate work.