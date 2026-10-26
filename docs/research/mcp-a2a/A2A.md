# A2A (Agent2Agent) versus what Djimitflo already has

Read-only assessment, 2026-10-22. Code paths are on origin/main `fc29222c`. Prod numbers come from read-only probes of
`/data/djimitflo.sqlite` and `docker inspect` on vps-agentical. Spec facts were read in the a2aproject/A2A repository at
the release tags.

**Verdict: DEFER.** A2A adds nothing that a current Djimitflo flow needs. Its push model conflicts with the operator rule
that the VPS never calls the workstation. The one place it would help is a future external counterparty; see the reopen
trigger at the end.

## 1. What A2A is today

| Item | Fact | Source |
|---|---|---|
| Version | v1.0.1, released 2026-05-28. v1.0.0 (2026-03-12) carried the breaking changes: the proto package became `lf.a2a.v1`, `TASK_STATE_*` enums, `tasks/list`, a `tenant` field, and OAuth device code + PKCE (implicit and password flows removed). | github.com/a2aproject/A2A/releases/tag/v1.0.1 |
| Governance | Linux Foundation project, Apache-2.0. The TSC has 9 seats (Google, Microsoft, Cisco, AWS, Salesforce, ServiceNow, SAP, IBM, Bloomberg). IBM's ACP merged into A2A in August 2025. | GOVERNANCE.md; LF announcements |
| Transports | JSON-RPC 2.0 over HTTPS, gRPC, and HTTP+JSON/REST (`POST /message:send`, `GET /tasks/{id}`, `POST /tasks/{id}:cancel`, SSE streaming). All three must be functionally equivalent. | spec §5, §9–§11 |
| Agent Card | `/.well-known/agent-card.json`. Required fields: `name`, `description`, `supportedInterfaces[]`, `version`, `capabilities`, `skills`. Signing (JWS over a JCS-canonical card) is optional (MAY); clients SHOULD verify. The extended card endpoint MUST require authentication. | spec §8, §8.4, §13.3 |
| Auth | OpenAPI-style `securitySchemes`: API key, HTTP bearer, OAuth2, OIDC, mTLS. Every request MUST be authenticated. List/Get/Cancel MUST be scoped to the caller, and authorization must run before any lookup that could reveal a resource exists. In-task `AUTH_REQUIRED` MUST NOT count as authorization. | spec §7, §13.1 |
| Task lifecycle | `SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`, then one terminal state: `COMPLETED`, `FAILED`, `CANCELED` or `REJECTED`. Messages carry parts (text, raw, url, data). Outputs are artifacts; `contextId` groups turns. | spec §3, proto |
| Push notifications | The server POSTs to a client webhook. It SHOULD block private ranges (SSRF) and MUST send the configured credentials. | spec §13.2 |
| SDKs | python `a2a-sdk` 1.2.3 (2026-10-19), `@a2a-js/sdk` 1.3.0 (2026-09-29), java 1.4.0.Final, go v2.7.0. All Apache-2.0. | GitHub releases |
| Security record | a2a-java had 5 advisories in Aug–Sep 2026, including GHSA-qw47-mcm5-934w (fail-open default task authorization, high) and GHSA-q78c-5jjq-57g8 (push SSRF). A2ABreak (arXiv 2609.10871) lists 11 protocol-level attacks open to a spec-compliant attacker: `contextId` cross-client injection, identity loss across multi-hop delegation, and Agent Card spoofing with unattested skills. Unit 42 "Agent Session Smuggling" (2025-10-31) shows a malicious remote agent steering a client over many turns. | GHSA database; arXiv; Unit 42 |
| Adoption | VENDOR_CLAIM: "150+ organizations", Azure AI Foundry, Copilot Studio, Bedrock AgentCore (LF press release 2026-04-09). I could not verify any named production deployment between two independent organisations. | LF press release |

A2A and MCP do not overlap. MCP connects an agent to tools; A2A connects one opaque agent to another and hands it a task.

## 2. What Djimitflo already has for agent-to-agent work

| Surface | Direction | Auth | Prod use (probe 2026-10-22) | A2A analogue |
|---|---|---|---|---|
| Federation routes `/api/federation/*` (`routes/federation.ts:107-255`) | Push: we POST to a peer's `/inbox/work` | Admin JWT (`manage:config`, `:115`). Outbound token comes only from `FEDERATION_PEER_TOKEN_*` env names (`:77-87`, fixed in #914). https only, or an http host from the allowlist (`:93-105`). Redirects refused (`:234,238`). | `federation_peers` = **0 rows**. Never used. | SendMessage + GetTask, no Agent Card |
| Agent registry (separate service, `/srv/agent-registry/main.py`, uvicorn `0.0.0.0:8088`, published on the tailnet IP) | Pull: Djimitflo reads `GET /agents` (`federation.ts:58-71`) | **None** on any route, including `POST /memory/write`, `DELETE /memory/{id}`, `POST /context/forward` and `POST /knowledge/agent/{name}/register` | 5 cards (djimitflo-vps, knowledge-vps, uams-vps, openclaw-workstation, eve-v-node), all ONLINE. Cards carry `capabilities`, `api_endpoint` and `daps[]` with sha256 hashes. | Agent Card registry, unsigned and unauthenticated |
| Event bus (`/srv/event-bus/main.py`, `:8083`, Redis streams) | Both ways, as a broker | **None** on publish or read. `agent.outcome` events are signature-checked inside Djimitflo when `FLEET_EVENT_SIGNATURES` is set (`external-event-ingest-service.ts:41,176`). | Live (`djimit.events`). | Push notifications / task status events |
| Host-agent pull (`routes/host-agent.ts:21-71`) | **Pull**: hosts poll the VPS | Per-host HMAC token scoped to `host-agent` (`:25-37`). The operator mints tokens with `manage:tokens` (`:64-69`). Commands are approved against their sha256 with `approve:task` (`:83-85`); self-approval is recorded (`fleet-commands.ts:54`). | 7 hosts heartbeating. 9 diagnostic commands, all done, the last on 2026-10-07. | None. A2A has no pull worker. |
| Remote maker / gym queue (the workstation pulls) | **Pull** | Spawn token (`DJIMITFLO_SPAWN_TOKEN`) | 151 remote maker leases in 30 d | A2A task handled by a worker, inverted |
| Agent Commons | In-process | See OUR_SURFACE.md §6 | — | Not A2A (social layer) |

## 3. Is there a concrete need that A2A meets better?

| Candidate need | Does A2A meet it better? | Evidence |
|---|---|---|
| Hand work to the workstation and other hosts | **No.** A2A is client → server push, and push notifications are server → client webhooks. Using it here means the VPS calls the workstation, which the operator rule (2026-09-29, `utils/outbound-guard.ts:1-6`) forbids. The pull queues are the deliberate design. | `seed-mcp-servers.ts:15-23`; host-agent and remote maker queue |
| Federate with another Djimitflo instance | **No demand.** `federation_peers` has 0 rows, and no peer has ever been registered. | probe |
| Advertise our agents | Partly. The agent registry already serves card-like JSON. What it lacks is **authentication and signatures**, not a protocol. | `/srv/agent-registry/main.py` |
| Let an external client's agent platform submit work (G4.3 pilot) | **Possibly**, if that client runs Azure AI Foundry, Copilot Studio or Bedrock AgentCore and wants to call us as an agent. No such client exists yet. | plan Phase G4.3 |
| More verified changes, more repos, a better oracle | **No.** A2A is transport. It does not touch the limiting stage (verified → merged → settled). | L3 report §5 |

## 4. Decision and what to take now

**DEFER** with these reasons:
1. No caller needs it.
2. The pull-only invariant conflicts with A2A's push model.
3. The security record is still settling: optional card signing, A2ABreak's 11 protocol-level attacks, and the 2026 SDK CVEs.
4. Every A2A peer is a new prompt-injection source. Its output would reach makers, which run inside the prod container (SECURITY_GAPS.md S0).

Ideas to adapt now. These are in-house and need no A2A dependency:
- **A2A-1 (S):** authenticate the agent registry and the event bus. This is the real gap, and A2A would not fix it. See SECURITY_GAPS.md S3.
- **A2A-2 (S):** sign the registry cards. Each host already has a key path: the deep-agent Ed25519 contracts in `execution/executors/deep-agent-executor.ts:56-97`, and the fleet event keys in `scripts/fleet-event-key.ts`. Signing over a canonical JSON copies A2A §8.4 without adopting A2A.
- **A2A-3 (XS):** apply A2A §13.1 to our own inbox. If federation is ever enabled, `/inbox/work` should take a peer-scoped token instead of an admin JWT. Today a peer would need **admin** rights on the receiver (`federation.ts:190`, `canManage`), which is over-broad.
- **A2A-4 (XS):** map task states in the docs: our `loop_runs` / `worker_leases` statuses to A2A `TASK_STATE_*`. Then a future facade is a thin translation layer, not a redesign.

**Reopen trigger:** a named external counterparty, or the G4.3 pilot client, that must call Djimitflo agent-to-agent and cannot use the REST API. Even then, build only a **server-side facade** behind a default-off flag:
- an Agent Card signed with a pinned key;
- the HTTP+JSON binding;
- OAuth2 client credentials or mTLS, with per-client task scoping;
- `SendMessage` mapped to a goal wrapped in `BEGIN_EXTERNAL_CONTENT`, the same as `federation.ts:199`;
- no push notifications and no outbound A2A client calls.

The operator decides to open that door.
