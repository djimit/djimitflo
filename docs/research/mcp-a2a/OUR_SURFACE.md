# Djimitflo's own MCP, agent-protocol, skill and memory surface

Read-only inventory, 2026-10-22.

- **Code:** origin/main `fc29222c`. Paths are relative to the repo root, and `S/` = `packages/server/src/`. Line numbers point to origin/main. The PR in this directory changes only the lines marked *(PR)*.
- **Prod:** read-only probes on vps-agentical:
  - `docker exec … node` with `{readonly:true}` against `/data/djimitflo.sqlite`;
  - `docker inspect` / `docker ps`;
  - env-variable **names only**;
  - the `mcp` section of `/srv/djimitflo/opencode.json`, names only.
- **Prod image:** `djimitflo:main-f08b13b`.

## 0. The trust boundary that decides everything else

Makers run **inside the prod container**, as the same uid as the server. Evidence from the 2026-10-22 probe:

| Fact | Evidence |
|---|---|
| Process uid | `id -u` = 1001 inside `djimitflo-live`. |
| Prod DB owner | `/data/djimitflo.sqlite` is owned by `djimitflo(1001)`, mode 600. |
| Maker worktrees | Under `/data/loop-worktrees/…`, per `worker_leases.worktree_path` over 7 days. |
| Docker sandbox | The `DockerSandboxExecutor` path (`S/execution/execution-engine.ts:628-640`) is unavailable: there is no docker CLI and no socket in the container. |
| Maker shell use | opencode makers made **4,329 `bash` calls** in 30 days (555 stdout logs read). |
| opencode permissions | `external_directory: deny` is set in `/srv/djimitflo/opencode.json`. That setting does not cover the shell, which means any of those `bash` calls can read the DB. |
| Secrets in maker env | Server secrets are stripped from the maker env by the allowlist (`S/execution/executors/executor-env.ts:6-33`). Provider API keys are on that allowlist, so they stay in the env. |

**What follows:** inside a maker, every MCP permission check, role check and "approval" listed below is advisory, because the maker can read and write the DB directly. This is fine for the operator's own repository. It is **not** fine for any repository, MCP server, A2A peer or skill whose content the operator does not control. See SECURITY_GAPS.md S0.

## 1. The Djimitflo MCP server (`packages/mcp-server`, v0.5.8, SDK `@modelcontextprotocol/sdk` 1.32.1 in prod)

### 1a. Transports and authentication

| Transport | Where | Principal | Notes |
|---|---|---|---|
| stdio | `packages/mcp-server/src/index.ts:60-73` | Hardcoded **VIEWER** (`:67`). `sub` comes from `DJIMITFLO_MCP_STDIO_PRINCIPAL` or the uid. The token is taken from `DJIMITFLO_MCP_TOKEN` (`:71`). | Platform tools forward that token to the API (`tools/platform.ts:9-15`). |
| HTTP | `src/transports/http.ts:14-111`, started at `index.ts:75-77` | HS256 JWT verified with the API's own `JWT_SECRET` (`http.ts:64`). In live mode it is re-checked against `users` and `refresh_tokens` (`:19-42`). The session is pinned to the principal (`:96-99`). | Uses the **legacy SSE transport** (`:7,73`) on **0.0.0.0** (`index.ts:76`). No audience claim, no Origin check, no rate limit. **Not deployed:** the only listener in the prod container is :3001. |

The DB handle opens read-write (`src/db.ts:82`). The writing tools need `DJIMITFLO_DATA_MODE=live` and a `database_instance_id` (`db.ts:18-28`).

### 1b. Tools (60 registered in `index.ts:81-94`)

Read-only, open to any principal (most tools):
- loops, goals, agents, mission control;
- okf_search/get/related/validate/status;
- openmythos;
- governance list/get, cost, evidence;
- explainer list/get/search/compare;
- memory_search (reads `memory_candidates`, `tools/platform.ts:39-52`);
- authority_trace/stats (`read:audit`).

The `okf_get` path traversal (L3 P0-2) is **fixed** on main. `resolveOkfConceptPath` rejects absolute paths, `..` and symlinks that escape the root (`tools/okf.ts:37-47`, #914). `loadAllFiles` uses `Dirent.isDirectory()`, which returns false for symlinks, so the walk does not follow them (`:87-112`).

Writing, executing or calling another system:

| Tool | Writes / calls | Check on main | After this PR |
|---|---|---|---|
| `djimitflo_spawn_agent`, `djimitflo_handoff_agent` (`tools/orchestration.ts:28-127`) | `agents`, `fleet_handoffs` | live + `write:swarm_action` (`:41-42,92-93`) | unchanged |
| `djimitflo_approve_action` (`:129-163`) | `POST /api/approvals` with the caller's token | live + `create:task` (`:142-143`) | unchanged |
| `djimitflo_authority_emit` (`tools/authority.ts:160-255`) | `authority_events` | live + `write:evidence` (`:185-186`) | unchanged |
| `djimitflo_sync_mcp_catalog` (`tools/governance.ts:293-399`) | upserts `mcp_servers`, `mcp_tools`, **`mcp_tool_permissions`** (overwrites operator decisions) | live only (`:317`) | live + `manage:config` *(PR)* |
| `djimitflo_sync_http_sidecar_catalog` (`:401-537`) | fetches each sidecar's OpenAPI URL (also on preview), upserts and **deletes** tool rows | live only (`:472`) | live + `manage:config` *(PR)* |
| `djimitflo_probe_mcp_sidecars` (`:539-597`) | fetches each sidecar's probe URL, updates status | live only (`:567`) | live + `manage:config` *(PR)* |
| `explainer_create_task` (`tools/explainer.ts:179-199`) | inserts `explainer_tasks` and `explainer_jobs` with any `local_path` / `repository_url` | **none**; no live check either | `write:governance` *(PR)*, same as `POST /api/explainer/tasks` (`S/routes/explainer.ts:71`) |
| `explainer_run_task` (`:229-243`) | enqueues a job, or `POST /api/explainer/tasks/:id/run` using the **server's** `DJIMITFLO_API_TOKEN` (`:55-60`) | **none** | `write:governance` *(PR)* |
| `explainer_ask` (`:257-311`) | `POST /api/explainer/ask` using `DJIMITFLO_API_TOKEN` | none | unchanged (read) |
| `notebook_create/delete/add_source/generate/research/notes/download` (`tools/notebooks.ts:54-170`) | `execFile` of `bridge.py` against Google NotebookLM. `add_source type=file` uploads **any local path**. `download outputPath` writes **any local path**. | **none** | unchanged (SECURITY_GAPS.md S6) |
| `djimitflo_council_ask`, `djimitflo_generate_export` (`tools/platform.ts:22-66`) | API calls that **forward the caller's own bearer token** | the API's own checks | unchanged |

Tool annotations: none of the 60 tools declares `readOnlyHint` or `destructiveHint`.

There are two divergent registries:
- `index.ts:81-94` registers the authority tools but **not** the expert tools.
- `register-tools.ts:16-29` registers the expert tools but **not** the authority tools.

The live server is `index.ts`. That is why this session's tool list has `djimitflo_authority_*` and no `djimitflo_expert_*`.

### 1c. Who runs it, and current use

| Caller | Config | Use (evidence) |
|---|---|---|
| The operator's Claude Code on the MacBook | `~/djimitflo/.mcp.json` (gitignored): `node ./packages/mcp-server/dist/index.js --transport stdio`, env name `DJIMITFLO_DB`. Enabled through `.claude/settings.local.json` `enabledMcpjsonServers: ["djimitflo"]`. | Used interactively; no server-side log. It runs the `dist/` **of the shared checkout that autonomous loops edit** (SECURITY_GAPS.md S11). |
| Prod opencode makers | `/srv/djimitflo/opencode.json` (root, mounted read-only into the container) has `mcp.djimitflo = {type: local, command: node /app/packages/mcp-server/dist/index.js --transport stdio, enabled: true}` and no env keys. | **0 MCP tool calls** in 30 days. Of 6,716 tool calls in 555 opencode stdout logs: read 1,649, grep 243, write 170, bash 4,329, todowrite 17, edit 216, glob 92. Likely cause: `DB_PATH` is not on the maker env allowlist (it is in the container env, but `RUNTIME_ENV_PASSTHROUGH` contains only `OPENCODE_CONFIG*` of the names checked), so `createDatabase` cannot find a DB and the child exits (`db.ts:69-76`). Inferred, not observed: no MCP lines appear in 40 recent stderr logs. |
| Fleet hosts over HTTP | Not deployed. | No listener. Every registry card has `mcp_servers: []`. |

The operator's Claude Code also runs three user-level MCP servers outside this repo:
- `github-mcp-server` (local Go binary, PAT from env);
- `research-agent`;
- `deerflow` (`uv run` local scripts).

None of them is prod.

## 2. The external MCP catalog the server knows (`/mcp-permissions`)

`S/database/seed-mcp-servers.ts:24-33` seeds 8 entries. The 2026-10-22 prod probe shows 10 rows:

| Name | URL host | Status | Marker |
|---|---|---|---|
| research-agent, qdrant, uams-read | agenticservices 100.77.58.72 | running (pinged 2026-10-21 20:10) | `catalog_only`, reachable |
| knowledge-mcp-bridge | 100.77.58.72:8007 | running | OpenAPI-synced tools |
| context7 | context7.com | running | `catalog_only` |
| searxng, litellm-mgmt, deerflow | workstation 100.81.133.48 | stopped | `known_unreachable` ("the control plane never calls the workstation") |
| djimitkb-mcp | 192.168.1.28:8008 (registered outside the seed) | stopped | "Blocked by policy … OUTBOUND_DENY_HOSTS" |
| Djimitflo Runtime MCP | — | catalog | last synced 2026-10-01 |

Prod counts:
- `mcp_tools` = 148: 87 for one OpenAPI sidecar, 56 runtime, 5 others.
- `mcp_tool_permissions` = 148: 101 `allowed`, 47 `requires_approval`. **147 of the 148 reasons start with "synced"**, so only about 1 row reflects an operator decision.

**Nothing enforces these rows.** Djimitflo is not an MCP client: no `sdk/client`, `callTool` or `tools/call` appears anywhere in `packages/`. Its own MCP server never reads `mcp_tool_permissions`. The table is read only by the routes that display it (`S/routes/mcp.ts:93,219,290,340`) and written by `PATCH /api/mcp/permissions/:toolId` (`:302-344`, `manage:config`), by the OpenAPI importer (`S/services/mcp-openapi-catalog.ts:34`) and by the MCP sync tools. The page shows "Approval gates: N" (`packages/dashboard/src/pages/MCPPermissionsPage.tsx:214`) and offers a "Requires approval" option (`:261`). Neither has any runtime effect. See SECURITY_GAPS.md S5.

**Outbound guard** (`S/utils/outbound-guard.ts:10-47`):
- It is an exact-hostname **denylist** taken from `OUTBOUND_DENY_HOSTS`, which is set in prod (name verified).
- It wraps only `globalThis.fetch` and checks only the first URL. Redirects are not re-checked. It does not resolve DNS and has no private-range rule. It is not installed when the variable is empty (`:33`).
- `GET /api/mcp/servers?refresh=true` (requireAuth only, `S/routes/mcp.ts:85-120`) lets any logged-in user trigger server-side probes of URLs stored in DB rows.

## 3. Agent-to-agent and fleet protocols

See A2A.md §2 for the full table.

**Federation** (`S/routes/federation.ts`):
- `register`, `work` and `inbox/work` need `manage:config` (`:113-116,148,190,212`).
- Outbound tokens may only come from `FEDERATION_PEER_TOKEN_*` env names (`:77-87`, #914).
- Peer URLs must be https or an allowlisted http host, and redirects are refused (`:93-105,234`).
- Inbound work is wrapped in `BEGIN_EXTERNAL_CONTENT` (`:199`).
- Prod: **0 peers**.

**segml federation:** `POST /api/segml/federation/receive` writes peer patterns with only `read:evidence` (`S/routes/segml-federation.ts:46`). Prod has no `segml_federated_patterns` table, so the route errors.

**Host-agent** (pull, `S/routes/host-agent.ts:21-90`):
- Per-host HMAC token scoped to `host-agent`.
- Commands are approved against their sha256 with `approve:task`, and self-approval is recorded (`S/services/fleet-commands.ts:54`).
- Prod: 7 hosts heartbeating (last 2026-10-21 22:03). 9 `diagnostic` commands, all `done`; the last on 2026-10-07.

**Agent registry** (`/srv/agent-registry/main.py`, a separate service on the VPS, uvicorn `0.0.0.0:8088`, published on the tailnet IP):
- **No auth on any route.** That includes `POST /memory/write`, `DELETE /memory/{id}` and `POST /context/forward` (agent → agent context queue), plus `/knowledge/agent/{name}/register`.
- It holds 5 cards with `daps[]` sha256 hashes.
- Djimitflo only reads `GET /agents` (`S/routes/federation.ts:58-71`).

**Event bus** (`/srv/event-bus/main.py`, `:8083`, Redis):
- **No auth** on `POST /events/{stream}` or `GET`.
- Djimitflo's ingest polls without an auth header (`S/services/external-event-ingest-service.ts:149-150`). The outbox sends `Bearer DJIMIT_EVENT_BUS_TOKEN` (`S/services/event-outbox-service.ts:40-53`), which the bus ignores.
- Signatures are verified only for `agent.outcome`, and only under `FLEET_EVENT_SIGNATURES` (`:41,176,202-203`). The variable is set in prod (value not read).
- Prod, 30 days: **9,679 events** from 8 self-declared sources: djimitflo-scout 7,007, operator-chatgpt 1,018, hermes-macmini 697, djimit-kbwiki 412, eve-action-processor 397, hermes-eve-v 102, daps 29, eve-maintainer 17. By type: discovery 9,126, content 204, work 193, agent 127, outcome 29.
- `roborev.finding` events become `work_items` with no signature (`:124-139`). There are 0 in prod.

**Knowledge bus HTTP** (`S/routes/knowledge.ts:24`):
- `POST /api/knowledge/publish` needed only `requireAuth`. *(PR: now also `write:claim`.)*
- Subscribers act on claims: `capability_gap` creates a candidate `swarm_capabilities` row (`S/services/capability-acquisition.ts:27-75`), and `help_request` asks `NestedSpawnService` for a maker spawn (`S/services/negotiation-coordinator.ts:52-110`). Both start unconditionally (`S/bootstrap/autonomous-services.ts:360-375`).
- Spawning is held back by the `SPAWN_DEPTH_BUDGET=0` default (L3 P3-6).
- Prod: 0 `swarm_claims` in 30 days.

**Agent Commons:**
- The public routes `/api/swarm-v2/social-runtime/*` have no `requireAuth` (`S/routes/index.ts:175`) and are rate-limited 60/min.
- `GET /card` is a public discovery card (`S/services/agent-commons-open-door-service.ts:44-69`).
- `POST /join` needs an operator invite (sha256-hashed, TTL, max uses) and creates a `paused` agent (`:82-108`). The operator then approves it with `manage:tokens`.
- Token-gated replies go through `respondSocial`. A reply's `proposed_improvement` becomes a `self_improvements` proposal (`S/services/agent-communication-service.ts:646-653`). Content safety on that reply is shadow-only.
- `commons-falsifier.ts:14-36` runs agent-submitted test files under vitest on the host when `COMMONS_FALSIFIER_MODE=shadow` and the agent is listed.
- Prod: 32 `agents`, all `active` (status never decays, L3 P3-8).

## 4. Skills

| Surface | Source | Integrity | Reaches maker prompts? | Prod |
|---|---|---|---|---|
| `S/services/skill-loader-service.ts` (`agent_skills`) | Filesystem `DJIMITFLO_SKILLS_DIR`; unset → disabled (`:50-52,77-79`) | sha256 hashes recorded but not pinned (`:254-259`); regex injection blocklist (`:287`) | No; used for outcome attribution only (`S/execution/execution-engine.ts:149,1394,1445`) | `agent_skills` = **0** |
| `S/routes/skills.ts` | — | assign/remove need `write:skills` + `write:agents`; **no audit** | — | — |
| `skill_cards` (`S/services/skill-distillation.ts`) | Distilled from outcomes when `SKILL_DISTILLATION_MODE=shadow` | — | No (`:9-12`); only a gym playbook gene behind `DREAM_PLAYBOOK_GENE` | **97, all `candidate`**; last written 2026-10-21 |
| OKF skills, `frontier-expert-skills.ts` | Repo-hardcoded installer; **an installed file overrides the built-in text with no hash** (`:64`) | none | Council expert prompts (`expert-perspective-builder.ts:76`) | — |
| `.opencode/skills/` (35 directories) | Repo; not loaded by the server. `dream-cycle/dream_cycle.py:73-80` fetches arXiv over **plain HTTP** and imports `/home/djimit/.hermes/scripts` | none | opencode sessions on hosts that use this repo's `.opencode` | — |
| `packages/agent-catalog` | `AGENT_CATALOG_SOURCE` profiles → static gate → compiled artefacts | activation needs a passed evaluation plus audit (`packages/agent-catalog/src/registry.ts:7-20`) | No (`runtime_registered:false`) | — |
| `opencode.json` `permission.skill: ask` | — | — | Skills prompt in opencode; the prod value of `OPENCODE_SKIP_PERMISSIONS` was not read | — |

## 5. Memory

| System | Write path | Gate | Reaches maker prompts? | Prod |
|---|---|---|---|---|
| `memory_candidates` | `POST /api/memory/candidates` (`write:claim`); `proof-run-service`; Commons review | `review_required` passes with **any `approved_by` string** (`S/services/memory-candidate-service.ts:233`). Machine promoters: `proof-run-service.ts:481,817,838,864,1254`. | **Yes**: up to 3 promoted `engineering_rule` rows go into `LOOP_WORK.md` (`S/services/assignment-context.ts:79-130`) when `LOOP_MEMORY_RULES_ENABLED` is true (name present in prod; value not read). Sealed by trust on first use (`:110-123`). | 185 promoted, 45 rejected |
| `proactive_memories` (`S/routes/memory.ts`) | `write:claim` / `write:governance`; no audit | relevance-based auto-promotion (`proactive-memory-service.ts:146-148`) | No | — |
| Context injection (`S/services/context-injection-service.ts:10-33,171,225`) | Qdrant `djimitflo_swarm` / `djimit_okf` and DjimitKB, written by memory-sync on task completion (`memory-sync-service.ts:69-190`) | `ContextSanitizer`; trust from the payload (default 0.5) | **Yes**: as `metadata.swarm_context` on every new task (`S/routes/tasks.ts:178,197`) | — |
| UAMS, Qdrant on agenticservices | `memory-sync-service.ts` POST plus collection **delete/recreate** on a dimension mismatch (`:169-170`) | API keys (names `UAMS_API_KEY`, `QDRANT_WRITE_API_KEY`) | via context injection | — |
| Agent-registry shared memory (ecosystem) | `POST /memory/write`, **unauthenticated** | none | Not read by Djimitflo | — |

## 6. Audit coverage of the writing surfaces

| Surface | Audited where |
|---|---|
| MCP spawn / handoff / authority emit | Rows carry the principal (`orchestration.ts:109`, `authority.ts:204-212`). MCP calls are **not** generally logged. |
| Catalog sync / sidecar probes / explainer / notebooks | **No audit row.** |
| Host-agent commands | `fleet_commands` plus an audit record with `self_approved` (`fleet-commands.ts:54`) |
| Commons operator actions | `audit.record` on every `/social/*` operator route |
| Skills assign, `/api/memory` writes, knowledge publish | **No audit.** |
| Event-bus ingest | `external_events` stores the payload. The source is self-declared. |

`audit_logs` holds **0 rows** in prod. The audit records in this table live in other tables, such as `authority_events` (1,221 rows: service 629, human 317, agent 275).

## 7. Principals in prod

`users` = 4, **all `admin`**. Every JWT in prod therefore carries all 21 admin permissions. The roles MAKER / CHECKER / VIEWER (`packages/shared/src/types/auth.ts:15-83`) are not used by any account, so the permission fixes in this PR change nothing for today's accounts. They take effect when least-privilege service accounts exist (SECURITY_GAPS.md S12).
