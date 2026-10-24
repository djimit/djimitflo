---
type: integration-package
title: MCP Server Package
description: The @djimitflo/mcp-server package exposes Djimitflo state and control actions to MCP clients (Claude Code, Cursor, VS Code) over stdio or an authenticated HTTP/SSE transport, reading and writing the SQLite database directly with a snapshot-vs-live safety boundary and per-principal role context.
tags: [mcp, mcp-server, stdio, http-transport, sqlite, snapshot-live-gating, tool-families, auth-context, integrations]
sources:
  - id: openwiki-source-ba912540c58d3dce145e1625
    resource: repo://packages/mcp-server/package.json
  - id: openwiki-source-99818a842bae5a0ab782c95a
    resource: repo://packages/mcp-server/src/__tests__/authority-tools.test.ts
  - id: openwiki-source-98839c85310f2361920fdde1
    resource: repo://packages/mcp-server/src/__tests__/db.test.ts
  - id: openwiki-source-6200567cdc34e1718c3313d0
    resource: repo://packages/mcp-server/src/__tests__/expert-tools.test.ts
  - id: openwiki-source-c611658bc71229073f0e22d4
    resource: repo://packages/mcp-server/src/__tests__/explainer-tools.test.ts
  - id: openwiki-source-f32a88438a95fd9c406f31ef
    resource: repo://packages/mcp-server/src/__tests__/http-auth.test.ts
  - id: openwiki-source-eaf564ef2befe321ffae6a08
    resource: repo://packages/mcp-server/src/__tests__/knowledge-tools.test.ts
  - id: openwiki-source-3df4070bfd72dd7e20c8c996
    resource: repo://packages/mcp-server/src/__tests__/mcp-server.test.ts
  - id: openwiki-source-9dfe4947b9bd3626878b7069
    resource: repo://packages/mcp-server/src/__tests__/mcp-write-permissions.test.ts
  - id: openwiki-source-76c13c8f1ab7259ccec3d305
    resource: repo://packages/mcp-server/src/__tests__/mission-control.test.ts
  - id: openwiki-source-f12bef0d948ec2e5776ac453
    resource: repo://packages/mcp-server/src/__tests__/orchestration-registration.test.ts
  - id: openwiki-source-26dce71b79faec29409362d1
    resource: repo://packages/mcp-server/src/auth-context.ts
  - id: openwiki-source-13f830df0763d5b992eb8922
    resource: repo://packages/mcp-server/src/db.ts
  - id: openwiki-source-35ac8c9a6fc2c825c488ce71
    resource: repo://packages/mcp-server/src/index.ts
  - id: openwiki-source-a78a8c0681b5fc0825f107fa
    resource: repo://packages/mcp-server/src/register-tools.ts
  - id: openwiki-source-502a0307278bcc1ace106d3b
    resource: repo://packages/mcp-server/src/tools/agents.ts
  - id: openwiki-source-d8dc0d8d1c544c08c0700d0d
    resource: repo://packages/mcp-server/src/tools/authority.ts
  - id: openwiki-source-4f3e4e48427ba24e11b45e1d
    resource: repo://packages/mcp-server/src/tools/experts.ts
  - id: openwiki-source-e7c45ca8fa1c19082bfc7554
    resource: repo://packages/mcp-server/src/tools/explainer.ts
  - id: openwiki-source-575b040fec90cc30b8394267
    resource: repo://packages/mcp-server/src/tools/goals.ts
  - id: openwiki-source-c6ee6f5f7a898e587f5e12de
    resource: repo://packages/mcp-server/src/tools/governance.ts
  - id: openwiki-source-cc63d73015a7fa6e00a63135
    resource: repo://packages/mcp-server/src/tools/loops.ts
  - id: openwiki-source-8f04739b52aff0f4f7b9a72c
    resource: repo://packages/mcp-server/src/tools/mission-control.ts
  - id: openwiki-source-66ddbd5f471b09bc44711337
    resource: repo://packages/mcp-server/src/tools/notebooks.ts
  - id: openwiki-source-2d70fb91a9d6205613f2bf57
    resource: repo://packages/mcp-server/src/tools/okf.ts
  - id: openwiki-source-01abed2ad820fe4049c8453a
    resource: repo://packages/mcp-server/src/tools/openmythos.ts
  - id: openwiki-source-d6ab0252e0bc9b6d4bbf7878
    resource: repo://packages/mcp-server/src/tools/orchestration.ts
  - id: openwiki-source-a141ce03ad5f1230df8c627e
    resource: repo://packages/mcp-server/src/tools/platform.ts
  - id: openwiki-source-efa7465e9bd745fbb057fbd3
    resource: repo://packages/mcp-server/src/transports/http.ts
  - id: openwiki-source-d00259be35083160b9e2c775
    resource: repo://packages/server/src/__tests__/seed-mcp-servers.test.ts
  - id: openwiki-source-baf2da50da44e229e8bb6daf
    resource: repo://packages/server/src/database/seed-mcp-servers.ts
  - id: openwiki-source-432dd950fb697e04f9ac8978
    resource: repo://packages/server/src/routes/mcp.ts
  - id: openwiki-source-4c98ee5915bd44e7aae4fb1d
    resource: repo://packages/shared/src/jwt.ts
  - id: openwiki-source-f873c20d1298723efcbc88e6
    resource: repo://packages/shared/src/types/auth.ts
generated: { by: "openwiki/0.5.2", at: "2026-10-24T12:32:22.727Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-10-24T12:32:22.727Z
---

# MCP Server Package

`@djimitflo/mcp-server` (`packages/mcp-server`) is the
[Model Context Protocol](https://modelcontextprotocol.io) bridge between Djimitflo
and IDE/agent clients such as Claude Code, Cursor, or VS Code. It ships a
`djimitflo-mcp` binary that starts an `McpServer` (`name: "djimitflo"`) and
registers twelve tool families covering loops, goals, agents, mission control,
orchestration, governance, and knowledge packs. Unlike dashboard/API clients, most
tools query Djimitflo's SQLite database **directly via `better-sqlite3` rather
than through the REST API**; only a handful of tools (council, approvals, exports,
explainer pipeline runs) deliberately cross the authenticated API boundary.

```text
djimitflo-mcp --transport stdio            # default, for IDE-managed processes
djimitflo-mcp --transport http --port 3002 # remote fleet access
djimitflo-mcp --db /path/to/djimitflo.sqlite
```

## Transports and principal context

```mermaid
flowchart TD
  CLI["parseArgs transport / port / db"] --> OPEN["createDatabase resolved path + mode"]
  OPEN --> STDIO{"transport"}
  STDIO -->|stdio| SYNTH["synthetic principal role viewer exp now + 24h"]
  STDIO -->|http| HTTP["startHttpServer port 3002 requires JWT_SECRET"]
  HTTP --> JWT["verifyHs256Jwt bearer token"]
  JWT --> AUTHN["currentPrincipal live DB re-check of user and session"]
  SYNTH --> ALS["runWithMcpAuth AsyncLocalStorage"]
  AUTHN --> ALS
  ALS --> TOOLS["registered tool families gated by requireLiveMode and requirePermission"]
```

*Startup wiring: one database handle is opened first, then either a synthetic stdio
principal or per-request JWT verification establishes the AsyncLocalStorage auth
context that all tool handlers read.*

The entrypoint `src/index.ts` parses `--transport`, `--port` (default `3002`), and
`--db`, opens the database once via `createDatabase`, and builds a `createServer`
factory that registers all tool families on each new `McpServer` instance. The
package is published (workspace-private) as `@djimitflo/mcp-server` with the
`djimitflo-mcp` bin pointing at `dist/index.js`; it depends on
`@djimitflo/shared` for `ROLE_PERMISSIONS`, `UserRole`, and `verifyHs256Jwt`,
and on `better-sqlite3` for direct database access.

**stdio (default).** A host IDE launches the binary as a child process; the server
connects to `StdioServerTransport` inside `runWithMcpAuth` with a synthetic
principal: `sub` comes from `DJIMITFLO_MCP_STDIO_PRINCIPAL` or falls back to
`stdio:<uid>`, `token` comes from `DJIMITFLO_MCP_TOKEN` (or empty), and the role is
**hardwired to `UserRole.VIEWER`** with a 24-hour expiry. This means a default
stdio session can only read; every tool guarded by a permission such as
`write:swarm_action`, `write:evidence`, `create:task`, or `read:audit` throws
`MCP_PERMISSION_DENIED` because the viewer role carries none of them. Tools that do
no `requirePermission` check (the plain read loops/goals/agents/mission-control
tools, OKF, notebook bridge calls, the extractive explainer fallback) still work.

**HTTP.** `startHttpServer` in `src/transports/http.ts` refuses to start without
`JWT_SECRET` (`JWT_SECRET is required for MCP HTTP transport`). It serves the
legacy SSE protocol at `/mcp`: `GET /mcp` opens a session stream, `POST /mcp`
delivers client messages to the per-session `SSEServerTransport`, and `/health`
answers an unauthenticated liveness probe. Every request requires a Bearer token
verified with `verifyHs256Jwt` (`@djimitflo/shared/jwt`), which rejects non-HS256
algorithms, bad signatures, unknown roles, missing `sub`, and expired tokens.

### Session authority re-validation

Signed claims are not trusted at face value. `currentPrincipal` re-reads the
**current** user row when the server runs against a live authority database: the
user must be active and hold a known role, `organization_id` must match the stored
assignment, and any browser-session token (`sid`) must have a non-revoked,
unexpired `refresh_tokens` row for the same user. On success the principal's role
and email are rebound from the database, so revoking a session or demoting a user
takes effect immediately — the `http-auth` test demonstrates a tool call failing
mid-session after `refresh_tokens` revocation. Two boundary behaviors matter:

- With a **snapshot or missing authority** the verifier falls back to legacy
  behavior: tokens *with* an `sid` are rejected (a static signature check cannot
  prove a session family is still alive), while sid-less tokens pass on signature.
  A failing live lookup is a refusal, never a fallback to signature-only trust.
- Each session records a principal key `(sub, role, organization_id, sid)` at
  stream setup, and every POST's token must produce the same key — preventing a
  different (or modified) token from reusing an existing MCP session (403 on
  mismatch).

## Database access, path resolution, and snapshot/live gating

`src/db.ts` resolves the database in priority order: the `--db` flag or
`DJIMITFLO_DB`/`DB_PATH` env (relative paths resolved against `INIT_CWD`, then
cwd), otherwise the first existing candidate among `<monorepo>/.data/djimitflo.sqlite`,
`<cwd>/.data/djimitflo.sqlite`, and `<cwd>/djimitflo.sqlite`. Startup throws when no
path can be resolved or the file does not exist, and the handle always opens with
`foreign_keys = ON`. The monorepo root is derived by stripping the
`/packages/<name>` suffix from cwd, so the binary can be launched from any
workspace.

The handle carries `mode: 'snapshot' | 'live'`, taken from
`DJIMITFLO_DATA_MODE` — **any value other than exactly `'live'` yields snapshot**.
Snapshot is the default and the safety boundary for a read-mostly client: every
mutating tool calls `requireLiveMode(handle)` first and fails closed with
`DJIMITFLO_LIVE_DATA_REQUIRED` on a snapshot. Live mode additionally requires the
database to carry a persistent identity: `requireLiveMode` reads
`system_state['database_instance_id']` and throws
`DJIMITFLO_DATABASE_ID_REQUIRED` when absent, and when
`DJIMITFLO_EXPECTED_INSTANCE_ID` is set a mismatch raises
`DJIMITFLO_DATABASE_ID_MISMATCH:<actual>` so a misconfigured `DJIMITFLO_DB` cannot
silently mutate the wrong database. `databaseProvenance` (exposed by tools such as
`djimitflo_get_mission_control` and `djimitflo_get_data_provenance`) reports the
instance id, node id (`DJIMITFLO_NODE_ID` or hostname), resolved path, mode, and
`DJIMITFLO_COMMIT_SHA` so operators can verify exactly which data a session is
attached to. Do not weaken this gating: it is what makes pointing the same binary
at a copied snapshot safe.

## Auth context and permission checks

`src/auth-context.ts` stores `{ payload, token }` in `AsyncLocalStorage`
(`runWithMcpAuth`/`currentMcpAuth`); `currentMcpAuth` throws
`MCP_AUTH_CONTEXT_REQUIRED` when a handler runs outside it, which makes anonymous
mutation impossible regardless of transport. It also exports
`requireMcpPermission(permission)`, which checks the principal's role against
`ROLE_PERMISSIONS` from `@djimitflo/shared` and throws
`MCP_PERMISSION_DENIED: <permission>`; orchestration and authority tools define an
identical local `requirePermission` helper. The contract — tested in
`__tests__/mcp-write-permissions.test.ts` and noted in the source comments — is
that a writing MCP tool must ask for the **same permission as its HTTP route
twin**, so the MCP surface is never a wider door than the API: the governance
write tools require `manage:config` (their twins are `POST /api/mcp/servers` and
`PATCH /api/mcp/permissions/:toolId`) and the explainer write tools require
`write:governance` (twins: `POST /api/explainer/tasks[/:id/run]`). The platform
tools (`council`, exports) and orchestration `approve_action` forward
`currentMcpAuth().token` as a Bearer header to `DJIMITFLO_API_URL` (default
`http://127.0.0.1:3001/api`), so the API re-applies its own authorization to
those calls.

## Tool family map

`registerTools` exported from `src/index.ts` mounts the twelve families below;
each tool name is listed with its mutating posture. A second registrar,
`src/register-tools.ts`, additionally mounts an `experts` family
(`djimitflo_expert_search`, `djimitflo_expert_get`,
`djimitflo_expert_capabilities`, `djimitflo_expert_claims` — read-only provenance
views over the `expert_*` tables) but is not imported by the binary's `main`, so
those tools only appear where that module is wired in explicitly (its own
`__tests__/expert-tools.test.ts` registers `registerExpertTools` directly). The
expert tools are §35 "Frontier Expert Intelligence" views: tentative lifecycle
states such as `DISCOVERED` (a signature match, never verified expertise) are
returned verbatim rather than promoted, person-kind identities are hidden unless
`FRONTIER_EXPERT_PERSONS_ENABLED=true`, and when the `expert_*` tables are
missing the tools return an explicit "not present" error instead of guessing.
Resolution and council dispatch stay on the governed HTTP routes
(`/api/swarms/expert/*`); these tools never write.

| Family | Tools | Posture |
| --- | --- | --- |
| loops | `djimitflo_list_loop_runs`, `djimitflo_get_loop_status`, `djimitflo_get_loop_catalog` | Read-only SQL over `loop_runs`/`worker_leases`/`loop_events`; loop starts happen elsewhere |
| goals | `djimitflo_list_goals`, `djimitflo_get_goal` | Read-only over `goals` plus linked runs |
| agents | `djimitflo_list_agents`, `djimitflo_get_agent_status` | Read-only over `agents` and active leases |
| mission-control | `djimitflo_get_mission_control`, `djimitflo_get_system_health` | Read-only aggregate counts (status-bucket: `running`/`verifying` loop runs, `created` goals, `active` agents, `running` worker leases), table stats, recent error/critical events — always including database provenance |
| orchestration | `djimitflo_spawn_agent`, `djimitflo_handoff_agent`, `djimitflo_approve_action` (mutating), `djimitflo_list_orchestration_agents` (read) | All three mutators require live mode; spawn/handoff need `write:swarm_action`, approve needs `create:task` and POSTs `/approvals` through the API |
| okf | `okf_search`, `okf_get`, `okf_related`, `okf_validate`, `okf_status` | Read-only over the file-based OKF bundle, no database involved |
| openmythos | `djimitflo_openmythos_leaderboard`, `djimitflo_openmythos_score` | Read-only over `openmythos_eval_runs`; evals are started via the REST API, not MCP |
| governance | `djimitflo_get_data_provenance`, `djimitflo_mcp_doctor`, `djimitflo_list_mcp_servers`, `djimitflo_list_mcp_tools`, `djimitflo_get_mcp_permissions`, `djimitflo_get_cost_summary`, `djimitflo_get_evidence_chain`, `djimitflo_list_openmythos_runs`, `djimitflo_list_skill_outcomes` (read) and `djimitflo_sync_mcp_catalog`, `djimitflo_sync_http_sidecar_catalog`, `djimitflo_probe_mcp_sidecars` (mutating with `apply=true`) | The three sync/probe tools default to `apply=false` dry-run previews and gate the write path behind `requireLiveMode` |
| notebooks | `notebook_list`, `notebook_create`, `notebook_delete`, `notebook_add_source`, `notebook_ask`, `notebook_generate`, `notebook_research`, `notebook_notes`, `notebook_download` | No Djimitflo DB access; all shell out to a NotebookLM bridge subprocess (see below) — create/delete/add/notes mutate the external service |
| explainer | `explainer_create_task`, `explainer_run_task` (write queue rows), `explainer_list_tasks`, `explainer_get_task`, `explainer_list_bundles`, `explainer_ask`, `explainer_search_repo`, `explainer_get_fact`, `explainer_compare_repos` (read) | The two writers gate on `requireMcpPermission('write:governance')` (their HTTP-twins' permission) and are caught into `isError` results; they do **not** call `requireLiveMode`. `explainer_ask`/`explainer_run_task` delegate to `EXPLAINER_SERVER_URL` when set, otherwise fall back to local chunk search / job enqueue |
| authority | `djimitflo_authority_trace`, `djimitflo_authority_stats` (`read:audit`), `djimitflo_authority_emit` (mutating, `write:evidence` + live mode) | `authority_emit` refuses `policyDecision: 'ALLOW'` — actionable authority requires the external producer — and stamps the authenticated principal as actor |
| platform | `djimitflo_council_ask`, `djimitflo_generate_export` (API-forwarded), `djimitflo_memory_search` (read-only SQL over `memory_candidates`) | Council/export calls carry the session Bearer token so the API's own auth applies |

Three deliberate "no-op by design" behaviors are worth knowing before extending
these tools: orchestration `djimitflo_spawn_agent` inserts a **registration-only**
idle `agents` row — its metadata records `registration_only: true` and
`context_budget_enforced: false`, and it never creates a task, worker lease, or
execution (covered by the orchestration-registration test); `djimitflo_approve_action`
creates a *pending* approval record and explicitly does not execute the action; and
`djimitflo_handoff_agent` writes a pending `fleet_handoffs` control-plane row rather
than transferring a live process.

The governance sync tools classify discovered tools with simple heuristics —
runtime tool names matching `approve|spawn|handoff` become
`requires_approval/high`, names matching `evidence|cost|permission|mcp_` become
`allowed/medium`, everything else `allowed/low`; for HTTP sidecars,
GET/HEAD/OPTIONS operations become `allowed/low` while other methods become
`requires_approval/medium` — so freshly synced permissions start conservative.
All three sync/probe tools also gate the write path on
`requireMcpPermission('manage:config')` after `requireLiveMode`, mirroring the
server-side `manage:config` routes that own the same `mcp_servers`/`mcp_tools`/
`mcp_tool_permissions` tables. The sidecar catalog sync additionally **deletes**
stale previously-synced tool rows (and their permission rows) that no longer
appear in a reachable sidecar's OpenAPI spec; the server-side twin logic for
that import lives in `packages/server/src/services/mcp-openapi-catalog.ts`,
which also refuses to overwrite a server that already has tool rows so an
operator's curated decisions survive refreshes.

## Client registration, seeded catalog, and the in-server `/api/mcp` routes

IDE/agent clients register **with this standalone package** by launching or
connecting to the `djimitflo-mcp` binary directly (stdio child process from the
IDE's MCP configuration, or an HTTP client hitting `:3002/mcp` with a Bearer
JWT); there is no discovery handshake through the Djimitflo REST API. The
standalone server and the Djimitflo server are **direct SQLite peers**: both read
and write the same `mcp_servers`, `mcp_tools`, and `mcp_tool_permissions` tables
(see `/openwiki/architecture/data-model.md`), and this page's governance family
and the server's `packages/server/src/routes/mcp.ts` expose parallel surfaces
over them:

- `djimitflo-mcp` registers its runtime tools under a synthetic server row
  `djimitflo-runtime` (via `djimitflo_sync_mcp_catalog`), and its
  `djimitflo_list_mcp_servers` marks that row `effective_status: 'catalog'`
  because a catalog entry has no liveness to probe.
- The **seeded fleet defaults** live server-side in
  `packages/server/src/database/seed-mcp-servers.ts`, which upserts eight
  sidecar server rows (research-agent, deerflow, context7, qdrant, searxng,
  litellm-mgmt, uams-read, knowledge-mcp-bridge) on migration, keyed by name with
  metadata **merged** into existing rows so operator-set fields survive reseeds.
  Probe configuration comes from row metadata (`probe_path`/`probe_url`/
  `openapi_path`/`probe_accept_statuses`), and both this package's
  `djimitflo_probe_mcp_sidecars` and `POST /api/mcp/servers/refresh` honor the
  same `probeSpec` semantics. Workstation-only sidecars are seeded with
  `known_unreachable` metadata (operator rule 2026-09-29: the control plane never
  calls the workstation), which both surfaces render as a calm `stopped`/
  `policy_blocked`-style status instead of an alarming `error`.
- The in-server routes (`GET /api/mcp/servers|tools|permissions`,
  `POST /api/mcp/servers[/refresh]`, `PATCH /api/mcp/permissions/:toolId`) are
  how the dashboard and operators manage the same registry; the write routes are
  rate-limited and gated behind `manage:config`, non-admin callers get
  command/args/env/url stripped. The standalone MCP server never calls those
  routes — it writes the same tables under its own `manage:config` permission
  check, keeping the enforcement point at the database for both boundaries (see
  `/openwiki/concepts/governance-pipeline.md` and
  `/openwiki/concepts/roles-and-permissions.md`).

## External integrations

**NotebookLM bridge.** The notebooks family shells out via `execFile` to
`NOTEBOOKLM_PYTHON` (default `~/.venvs/notebooklm/bin/python3`) running
`NOTEBOOKLM_BRIDGE_PATH` (default `~/workspace/notebooklm-mcp/bridge.py`) with a
120-second timeout and 10 MB stdout buffer, expecting JSON on stdout. Failures
surface as explicit `isError` tool results including the bridge's `recovery` hint
rather than throwing — the tools work from a snapshot server because they never
touch Djimitflo state.

**OKF bundle.** `okf_*` tools resolve the knowledge bundle from `OKF_BASE` or by
probing `djimitflo-knowledge/okf` relative to the module and cwd, and walk the
markdown tree per call to build an in-memory graph of frontmatter and `[[links]]`.
`okf_validate` enforces the required frontmatter fields (`type`, `title`,
`description`, `timestamp`, `tags`) and reports broken links. A missing bundle
raises `OKF bundle not found` and is returned as an error result. See
`/openwiki/operations/knowledge-runtime.md` for how this bundle is produced.

**Explainer server.** Without `EXPLAINER_SERVER_URL`, `explainer_ask` refuses to
fabricate answers: it returns extractive citations from published knowledge chunks
or a `NOT_ENOUGH_EVIDENCE` refusal, and `explainer_create_task`/
`explainer_run_task` — after the `write:governance` permission check — guarantee a
pending `explainer_jobs` row so the server's `ExplainerFleetWorker` later picks
the task up (`createTask` always inserts the job row; `runPipeline` re-enqueues
only when no pending/queued/running row exists). With the URL set, both delegate
over HTTP (optionally with `DJIMITFLO_API_TOKEN`). The local fallback chunks are
rebuilt on each call from the bundle's `facts_path`/`sections_path`/
`markdown_path` files, and chunk `valid_until` is anchored to bundle creation
(+7 days) rather than recomputed per call, so stale bundles stay stale.

## Testing

Focused contracts live in `src/__tests__/`:

- `db.test.ts` — path resolution against `INIT_CWD`, monorepo `.data` preference,
  snapshot default, and the database-instance-id requirement for live mutations.
- `http-auth.test.ts` — rejection matrix for live-session tokens (`revoked`,
  `expired`, `wrong-user`, `disabled`, `stale-organization`, snapshot authority),
  role rebinding from the live DB, mid-call revocation, and cross-principal session
  reuse (403).
- `orchestration-registration.test.ts` — spawn registers only an idle agent (no
  tasks/leases), and the anonymous/unauthorized/snapshot writes all fail closed.
- `mcp-server.test.ts` — registration of the full tool inventory, read-only tool
  execution in one pass, `DJIMITFLO_LIVE_DATA_REQUIRED` for every mutating apply
  path on a snapshot handle, and exact API URL forwarding for council/export tools.
- `mcp-write-permissions.test.ts` — the write-permission parity contract: a
  viewer/maker/checker `apply=true` catalog sync/probe is refused with
  `MCP_PERMISSION_DENIED: manage:config` while the operator's stored permission
  decision survives, the `apply=false` preview stays open to a viewer, and
  explainer `create_task`/`run_task` refuse every role without
  `write:governance` while writing no `explainer_tasks`/`explainer_jobs` rows.
- `explainer-tools.test.ts` — task creation inserts the row, and
  `explainer_run_task` without `EXPLAINER_SERVER_URL` reports `status: 'queued'`
  for the server-side worker instead of running locally.
- `expert-tools.test.ts` — the read-only experts family: missing `expert_*`
  tables return an explicit error, search/get/capabilities/claims round-trip
  with verbatim `DISCOVERED` states and `unresolved_contradictions` counts, and
  person-kind experts disappear unless `FRONTIER_EXPERT_PERSONS_ENABLED=true`.
- `mission-control.test.ts` — provenance is always included in mission-control
  payloads and summary fields count only the matching status buckets
  (running/verifying loans, created goals, active agents, running workers),
  with the five most recent events/errors ordered descending.
- `authority-tools.test.ts` — emit/trace/stats round-trip with sequence numbering
  and payload digests, `ALLOW`-forgery refusal for every role, and snapshot/anonymous
  write rejection.

## Configuration summary

| Variable | Effect |
| --- | --- |
| `DJIMITFLO_DB` / `DB_PATH` / `--db` | SQLite path; relative values resolve against `INIT_CWD` |
| `DJIMITFLO_DATA_MODE` | `live` enables mutating tools against the operational database; anything else is the snapshot default |
| `DJIMITFLO_EXPECTED_INSTANCE_ID` | Optional pin; live mutations fail with `DJIMITFLO_DATABASE_ID_MISMATCH` when the DB's `database_instance_id` differs |
| `DJIMITFLO_NODE_ID`, `DJIMITFLO_COMMIT_SHA` | Provenance labels reported by mission-control/governance tools |
| `DJIMITFLO_MCP_STDIO_PRINCIPAL`, `DJIMITFLO_MCP_TOKEN` | stdio principal id and the token forwarded to API-calling tools |
| `JWT_SECRET` | Required for `--transport http`; verifies Bearer JWTs |
| `DJIMITFLO_API_URL` | Base URL for council/approval/export forwarding (default `http://127.0.0.1:3001/api`) |
| `OKF_BASE`, `NOTEBOOKLM_PYTHON`, `NOTEBOOKLM_BRIDGE_PATH`, `EXPLAINER_SERVER_URL`, `DJIMITFLO_API_TOKEN`, `MCP_STATUS_TTL_MS` | Knowledge-bundle, NotebookLM bridge, explainer delegation, and stale-server classification tuning |
| `FRONTIER_EXPERT_PERSONS_ENABLED` | `true` reveals person-kind expert identities in the read-only experts tools; unset/hidden by default (§35 FE-AREAS) |

See `/openwiki/operations/configuration-reference.md` for the fleet-wide view of
these variables and `/openwiki/architecture/monorepo-layout.md` for where this
package sits in the workspace build order (`@djimitflo/shared` must build first).

## Invariants

- Snapshot is the default; only `DJIMITFLO_DATA_MODE=live` unlocks mutations, and
  only against an identified operational database (`requireLiveMode`).
- The stdio principal is always `viewer`-role; privilege comes only from real JWTs
  on the HTTP transport, where user state, organization, and session family are
  re-validated against live data on every request.
- Mutating tools fail closed: missing auth context, insufficient role, or snapshot
  mode each throw distinct errors (`MCP_AUTH_CONTEXT_REQUIRED`,
  `MCP_PERMISSION_DENIED`, `DJIMITFLO_LIVE_DATA_REQUIRED`) before any write occurs.
- Control-plane records ≠ execution: spawn, handoff, and approval tools persist
  intent only; task/loop services and the dashboard own dispatch and decisions.
- The MCP server is a **direct SQLite peer** of the server runtime, not an API
  client — both must therefore agree on schema and on the provenance/instance-id
  contract.
