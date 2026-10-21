# The 10 MCP servers from "10 Secret MCP Servers You Should Be Using for AI Agents"

| Field | Value |
|---|---|
| Article | Arham Ali, *Python in Plain English* (Medium), 2026-10-13, about 7 min. `python.plainenglish.io/10-secret-mcp-servers-you-should-be-using-for-ai-agents-8b49b7d0f126` |
| How it was read | The direct URL returns HTTP 403 (paywall). The r.jina.ai reader returned only the first section. The **full text** came from a freedium mirror. I verified the order of all 10 servers, the descriptions and the "Get it" links against it. |
| Review date | 2026-10-21/22 |
| Method | Read-only. Sources: GitHub API (repo metadata, releases, compare, issues), npm, PyPI and GHCR registry metadata, GHSA, OSV and NVD. For source reading: shallow clones with `core.hooksPath=/dev/null`, read with grep/sed only, then deleted. **Nothing was installed, run, built or registered.** No clone was opened as a Claude Code project. |
| Negative-evidence check | `NEGATIVE_EVIDENCE.yaml` was read first. None of the 10 is a ruvnet package (NE-009, NE-012). GhidraMCP touches the reverse-engineering question that NE-008 (REA, NO_GO) already decided. The standing rule against community MCP servers and skills on trusted infrastructure (NE-008 `why`) applies to every individually-maintained entry. |

**The article itself is a supply-chain lesson.** It links two **non-canonical** repositories:
- #1 points to `carlos-life/OpenMemory`, a 4-star project written in one day (2026-03-15). It shares the name of mem0's and CaviraOSS's projects but none of their code.
- #10 points to `teamipc/blender-mcp`, a stale fork: 0 commits ahead and 64 behind upstream. Its bundled addon defaults `telemetry_consent=True`, which sends prompts, code and screenshots.

A reader who installs from the links gets the less safe artefact. Five of the ten READMEs recommend an unpinned `npx`, `uvx` or `curl | sh` install.

## Summary

| # | Server (link in article) | Maintainer | Licence | Pinnable version (2026-10-21) | Write / exec tools | Default telemetry | Advisories 2025–26 | Djimitflo class |
|---|---|---|---|---|---|---|---|---|
| 1 | OpenMemory (`carlos-life/OpenMemory`) | individual, 1-day project | MIT | none (no tags) | add/update/delete memory | none found | none | **REJECT** |
| 1b | canonical: mem0 OpenMemory MCP | mem0ai (vendor) | Apache-2.0 | sunset; removed 2026-07-29 | add/delete/delete_all memories | **on** (PostHog) | **CVE-2026-59705, unfixed** (unauthenticated read/write) | **REJECT** |
| 1c | canonical: CaviraOSS/OpenMemory, now LongMemory | org | Apache-2.0 | npm `longmemory@1.3.3` | ingest, manage_skill, sync_connector | VENDOR_CLAIM none | none | **ALREADY_COVERED** |
| 2 | DBHub (`bytebase/dbhub`) | Bytebase (vendor) | MIT | `@bytebase/dbhub@1.5.0`; image `sha256:aa040931…` | `execute_sql` (writes and DDL on by default) | none found | CVE-2026-61742 (DNS rebinding → SQL), CVE-2026-61788 / -61789 (read-only bypass → `COPY … TO PROGRAM` RCE) | **REJECT** (ALREADY_COVERED) |
| 3 | MarkItDown MCP (`microsoft/markitdown`) | Microsoft | MIT | `markitdown-mcp==0.0.1a8` (alpha) | `convert_to_markdown(uri)`: any `file:` path, any `http(s)` URL | none in MCP; audio goes to Google Speech | none filed; open issues #1905 (local file read), #2621 (SSRF), XXE, zip bomb | **REJECT** as MCP; ADAPT_IDEA |
| 4 | n8n-MCP (`czlonkowski/n8n-mcp`) | individual | MIT | `n8n-mcp@2.95.0`; GHCR `sha256:41f03f45…` | create/activate/execute workflows, credentials CRUD | **on**: uploads workflow structure and intent text to `telemetry.n8n-mcp.com` | 16 in 2026 (1 critical, 6 high), including GHSA-gg57-wj7g-vfrv (2026-10-18, unsanitised telemetry) | **REJECT** |
| 5 | Snyk MCP (`snyk/studio-mcp`) | Snyk (vendor) | Apache-2.0 | `snyk@1.1308.2` (embeds studio-mcp 1.15.4; postinstall downloads a binary) | SCA runs Gradle/Maven build code; `snyk mcp configure` rewrites `~/.claude/CLAUDE.md` | feedback analytics; `snyk_code_scan` **uploads source** | none for studio-mcp | **REJECT** |
| 6 | Excalidraw MCP (`excalidraw/excalidraw-mcp`) | excalidraw org | README says MIT, **no LICENSE file** | v0.3.2 `.mcpb` sha256 `2b494012…` | export uploads the diagram | none | none (pins SDK 1.25.2, which has 6 SDK advisories) | **REJECT** |
| 7 | Qdrant MCP (`qdrant/mcp-server-qdrant`) | Qdrant (vendor) | Apache-2.0 | `mcp-server-qdrant==0.8.1` (wheel sha256 `eb7b3610…`) | `qdrant-store` (auto-creates collections); has `QDRANT_READ_ONLY` | none in repo | none (pins fastmcp 2.7.0, which has 8 OSV advisories) | **ALREADY_COVERED** |
| 8 | Zotero MCP (`54yyyu/zotero-mcp`) | individual | MIT AND AGPL-3.0 | `zotero-mcp-server==0.15.1` | about 20 write/delete tools, no read-only mode | none | **CVE-2026-108583** (SSRF in `add_by_url`). My reading says still unfixed in 0.15.1 (`tools/write.py:2052`). | **REJECT** |
| 9 | GhidraMCP (`LaurieWired/GhidraMCP`) | individual | Apache-2.0 | release 2.0, tag commit `1e980252` (not on PyPI; `ghidramcp` on PyPI is a fork) | 8 rename/retype/comment writes to the Ghidra DB | none | none; open #140/#141 (prompt injection from hostile binaries). 1.x bound 0.0.0.0 with no auth. | **REJECT** (NE-008 precedent) |
| 10 | Blender MCP (`teamipc/blender-mcp`) | **stale fork** of `ahujasid/mcp-for-blender` (individual) | MIT | canonical `mcp-for-blender==2.2.2` (wheel sha256 `7dfaadb5…`) | **`execute_blender_code` = `exec()` with no sandbox**; unauthenticated socket on localhost:9876 that auto-starts | **on** (Supabase; usage events even without consent) | CVE-2026-66004 (file write), CVE-2026-10661 / -10662 (fixed), CVE-2026-10688 (exec "by design") | **REJECT** |

Class legend:
- **ADOPT_CANDIDATE**: worth a pinned, sandboxed trial.
- **ADAPT_IDEA**: take the idea in-house.
- **REJECT**: no fit, or risk beyond benefit.
- **ALREADY_COVERED**: Djimitflo already has it.

None of the ten is an ADOPT_CANDIDATE.

## Per-server detail

### 1. OpenMemory
- **Article link `carlos-life/OpenMemory`.**
  - Not a fork. Created 2026-03-15; all 4 commits landed within 18 minutes. 4 stars, about 850 LoC of Python, stdio only.
  - Storage is SQLite at `~/.openmemory/memories.db`.
  - Tools: `add_memory`, `update_memory`, `delete_memory`, plus 5 reads.
  - Optional OpenAI embeddings send memory text out.
  - Install: `pip install -e .` from a clone. **Trap:** the PyPI names `openmemory` and `openmemory-mcp` belong to an unrelated uploader.
- **mem0 OpenMemory MCP.**
  - Sunset (issue #4923). Removed from the monorepo in PR #6530 on 2026-07-29. The Docker image was last updated 2025-06-17.
  - The SSE endpoint takes `user_id` from the URL path with no auth and `CORS *`.
  - **CVE-2026-59705** was closed with "sunsetted, won't fix".
  - The mem0 library's PostHog telemetry is on by default (`MEM0_TELEMETRY=False` turns it off).
- **CaviraOSS → LongMemory.** Apache-2.0, active. Streamable HTTP on `127.0.0.1:7331`. Bearer auth only when `LONGMEMORY_API_KEY` is set (empty by default). It has a read-only mode. The npm maintainer changed at the rename.
- **For Djimitflo:** memory is not a missing capability. We have `memory_candidates` (230 rows, 185 promoted), UAMS and Qdrant on agenticservices. What we lack is a **measured effect**: NE-002 is INCONCLUSIVE, and the memory holdout reads out on 27-10 (plan G3.1). Another memory store would only add an unmeasured write path into maker prompts. **REJECT, or ALREADY_COVERED.**

### 2. DBHub
- **Transport and auth:** stdio, or HTTP that binds **0.0.0.0, unauthenticated** by default (`src/config/env.ts:410-431`, `src/server.ts:189-193`). The README install is `npx @bytebase/dbhub@latest --transport http`.
- **Read-only:** only per tool, via TOML; the default policy allows writes (`src/utils/sql-access-policy.ts:73-74`). It was bypassed three times in 2026: CVE-2026-61742, -61788 and -61789 (Postgres `COPY … TO PROGRAM`, MySQL comment trick). An unverified CVE-2026-79536 alleges SQLi in v1.2.0.
- **For Djimitflo:** prod reads already go through `docker exec … node` with `{readonly:true}` (operator memory: deploy rules). The djimitflo MCP server serves curated reads. An `execute_sql` tool on the control-plane DB would hand a model the trust boundary. **REJECT (ALREADY_COVERED).**

### 3. MarkItDown MCP
- **Tool:** a single tool, `convert_to_markdown(uri)`.
  - `file:` reads any local file the process can read (`_markitdown.py:480-492`, open issue #1905).
  - `http(s)` is fetched with no allowlist, no timeout, and redirects followed (`_markitdown.py:514-516`). That is SSRF, and fix PR #2621 is unmerged.
- **Transport:** no auth. stdio, or `--http` on 127.0.0.1:3001 with Starlette `debug=True`. The Dockerfile enables plugins.
- **For Djimitflo:** no measured gap needs Office/PDF→Markdown for makers. Frontier and KB ingestion already have their own paths. **REJECT as an MCP server.**
- **ADAPT_IDEA:** if document conversion is ever needed (e.g. the ChatGPT export or NAS documents in plan Phase L/O), call the `markitdown` *library* (MIT) from a pinned version, offline, on local files only, in a job with no network.

### 4. n8n-MCP
- **Maintainer and cadence:** an individual (a sole proprietorship), with a hosted SaaS upsell. Releases come very fast: 3 in 4 days.
- **Tools:** create, update, **activate** and **execute** workflows, plus credentials CRUD (`src/mcp/tools-n8n-manager.ts:13-965`).
- **Telemetry, verified on by default:** it sends sanitised workflow structures and free-text intent to `telemetry.n8n-mcp.com` "to build datasets and machine learning models". Turn it off with `N8N_MCP_TELEMETRY_DISABLED=true`.
- **Advisories:** 16 in 2026.
- **For Djimitflo:** no n8n in the stack. Djimitflo is itself the workflow and control plane. **REJECT.**

### 5. Snyk MCP
- **Shape:** vendor tool, stdio only, embedded in the Snyk CLI.
- **Egress:** `snyk_code_scan` uploads source code to Snyk SaaS, which breaks the invariant "private data never to an external API" (plan Phase G).
- **Execution:** SCA runs the project's build tooling (Gradle/Maven), behind a folder-trust prompt that `TRUSTED_FOLDERS` or `--disable-trust` bypass.
- **Install:** the documented install is `npx -y snyk@latest`, with a postinstall binary download. `snyk mcp configure` **writes global agent rules into `~/.claude/CLAUDE.md`** and other agents' instruction files (`internal/configure/host_config.go:9-56`).
- **For Djimitflo:** the finding-fix lane needs **deterministic, offline, re-runnable** scanners (finding-fix-lane design §2). A SaaS scan is neither offline nor reproducible. **REJECT.** See DISCOVERY.md for offline alternatives (Opengrep, osv-scanner `--offline`).

### 6. Excalidraw MCP
- **Install path:** the recommended install is the **hosted unauthenticated endpoint** `https://mcp.excalidraw.com` (Vercel, `CORS *`), so diagram content leaves the host.
- **Local mode:** binds 0.0.0.0:3001.
- **Licence and maintenance:** there is no LICENSE file. It pins SDK 1.25.2, which has 6 advisories; the upgrade PRs are unmerged.
- **For Djimitflo:** no gap. **REJECT.**

### 7. Qdrant MCP
- **Shape:** vendor; a real `QDRANT_READ_ONLY=true` (`mcp_server.py:193-199`).
- **Install:** the README install is unpinned `uvx`. The Dockerfile installs unpinned. It pins `fastmcp==2.7.0`, which has 8 advisories.
- **For Djimitflo:** Qdrant on agenticservices (`100.77.58.72:6333`) is already registered in `seed-mcp-servers.ts:28` as a catalog-only dependency, and the server has its own client (`QDRANT_URL`, `QDRANT_WRITE_URL` env names in prod). Giving makers `qdrant-store` would add an unmeasured write path into shared memory. **ALREADY_COVERED.**
- **ADAPT_IDEA, read-only by default:** expose only the reads makers need through our own MCP server.

### 8. Zotero MCP
- **Surface:** an individual maintainer, about 58 tools of which about 20 write or delete, and no read-only mode.
- **SSRF:** `zotero_add_by_url` → `_fetch_embedded_metadata` still calls `requests.get(url)` without the public-host guard (`tools/write.py:2052`, v0.15.1), despite CVE-2026-108583.
- **Plugin updates:** the Zotero plugin pulls updates from the maintainer's `main` branch.
- **For Djimitflo:** Frontier Experts uses DataCite, and there is no Zotero library. **REJECT.**

### 9. GhidraMCP
- **2.0 versus 1.x:** 2.0 binds loopback and rejects Origin headers, but has no token. 1.x bound 0.0.0.0 with no auth.
- **Install:** the README installs from unpinned `main` via `uvx --from git+…`. The PyPI name `ghidramcp` is a fork with the original author's name in its metadata.
- **Main risk:** prompt injection from a hostile binary into an agent that can write to the Ghidra DB (#140/#141).
- **For Djimitflo:** NE-008 already decided that reverse engineering is not a Djimitflo capability need, and the parse-only shipped-code scan (#723) covers supply-chain inspection. **REJECT.**

### 10. Blender MCP
- **The article's link:** `teamipc` (account created 2026-03-06, 0 followers) forked upstream on 2026-08-24 and never committed. Its addon (1.5) defaults `telemetry_consent=True`.
- **Canonical `mcp-for-blender` 2.2.2:**
  - `execute_blender_code` → `exec(code, namespace)` with no sandbox (`addon.py:2288-2296`).
  - The addon opens an unauthenticated TCP socket on localhost:9876 that auto-starts with Blender.
  - Safe mode is opt-in and enforced only in the MCP server, not the addon.
  - Telemetry to a Supabase project is on by default.
  - The recommended install is `curl … | sh`, which edits about 8 MCP client configs.
- **For Djimitflo:** no gap. **REJECT.**

## What carries over to Djimitflo

1. **Canonical-repo check for discovered tools (ADAPT_IDEA, XS).** The scout and Frontier pipelines, and any human reading listicles, should record for each repo: the owner type, fork-of, ahead/behind upstream, and whether the package name matches the repo. The article got 2 of 10 wrong. NE-012 already showed how a copied `mcp.json` spreads auto-approve settings.
2. **Read-only by default (pattern from Qdrant / LongMemory / github-mcp-server).** Our own MCP server exposes write tools to every principal, and only some check permissions. See SECURITY_GAPS.md S1, S2 and S4.
3. **Pin by digest or exact version, never `@latest` or `uvx <name>`.** Our own `.vscode/mcp.json` still runs `npx -y @playwright/mcp` unpinned (SECURITY_GAPS.md S9).
4. **Telemetry audit before any adoption.** Four of the ten phone home by default (mem0, n8n-mcp, Blender MCP, Snyk analytics).
