# E. Configuration and integration audit

## Existing configuration surfaces

| Surface | Authority / what is actually applied | Visibility and friction |
|---|---|---|
| Configuration `/health/config` | Filtered UPPER_SNAKE `process.env`, secret name/value masking,500-character value truncation |268 settings/20 masked in inspected view; prefix groups and filter work. Source is current process environment, not a dump of runtime.env |
| Runtime.env / container deployment | Startup env plus compose/container overrides and defaults |UI explicitly advises backup+restart. Duplicate/older file entries are configuration debt, **not proof the effective running value is stale**. Health confirms current build identity |
| Loop runtime contracts / Fleet Cockpit | Available runtime/admission, pool capacity and role configuration |Availability, configured runtime and actual execution differ; link contract to source and last probe |
| Meta tuning | `meta_active_loop_parameters`, written with history/audit; LoopService reads by loop name for budgets/concurrency/gates |Real DB override path exists. Environment catalog omits this effective layer; Self-Driving shows applied history but not a complete per-run precedence view |
| Goal/loop/task forms | Per-execution runtime/repository/loop/budget inputs; domain validation and governance |Safe to inspect, writes excluded; actual selected runtime must be shown alongside configured default and fallback |
| Policies/Governance | Policy rules, runtime governance, assurance and admission gates |Existing scope/authorization retained; enabled policy is not proven enforced by this audit |
| MCP | Server registration, catalog classifications, policy-isolated routes |Page clearly says classifications gate no call. Do not silently repurpose catalog decisions into an enforcement engine |
| Skills/Catalog/Knowledge | Skill cards, imported artifacts, knowledge runtime projection/sync and expert lifecycle |Preparation, registration, promotion and runtime usage are different stages; current Catalog explains distinction well |
| Experiment registry / Evolution | Existing protocols, start/target/stop criteria, mode flags, WIP/approved overrides |No dedicated new experiment subsystem needed. Registry currently covers ACE, STE, Maker deps, X1, F2, TG, D5-NO, JEV1.14, memory holdout in source |
| Schedulers/retries/timeouts/integrations | Env flags, daemon/service defaults and per-call logic |Some source-only defaults are invisible when env absent. Workflows are loop-based; no stored workflow rows does not mean no orchestration |
| Telegram identities | Decisions allowlist administration plus configured polling |Daily queue and administration mixed; move editing to existing configuration context with a link back |

The real problem is **resolving the value that governed this run**, not editing more environment variables. Extend the current config endpoint/catalog progressively: common operator intents first (runtime/model routing, scheduling, resource budgets, retries/timeouts, knowledge/integration), advanced raw prefix list retained. Add definition, owner/consumer, source/default/override precedence, effective-at/run identity, redaction, validation and activation semantics. Derive metadata at existing resolution points; do not build a parallel store. Startup env typically requires restart; DB tuning can affect subsequent loop decisions; request-time values can apply immediately. Confirm per key rather than applying one global restart claim to all sources.

Source redaction masks credential names and recognizable credential values/URL user-info. It is not a formal guarantee against every secret encoding; do not export raw env/logs. No credentials were created, copied or revealed in this audit. Existing authorization/outbound-host isolation remained intact.

## Integration evidence ladder

CONFIGURED = endpoint/settings exist; CONNECTED = observed transport or recent request; HEALTHY = relevant bounded business capability succeeded recently; DEGRADED = evidence of a capability failure/constraint; FAILED = demonstrated inability; DISABLED = explicit mode/policy; UNKNOWN = insufficient evidence. These may apply per capability, not to an entire provider name.

The service map probes configured endpoints with no credentials,3 s timeout,60 s cache, deduped by endpoint. Source maps 5 xx→degraded,404→reachable,**every other HTTP status→up**, including 429. Therefore up is a transport label; it cannot establish authentication, model access or business health. MCP has a separate probe contract and policy-isolated reasons. Reuse these records plus existing usage/runtime evidence; do not add an integration layer.

| Integration / dependency | Current evidence and bounded state | Operational impact, missing diagnostics and recovery context |
|---|---|---|
| Event bus |Service map 200; 12,550 external_events/2,691 outbox rows. CONFIGURED/CONNECTED |Counts do not establish lag or delivery success; show oldest pending, last publish/ack, retry/dead-letter state and dependent discovery pipelines |
| Agent registry |Probe 200; 5 registry rows vs 32 agent rows. CONNECTED, sync completeness UNKNOWN |Attach last sync/drift and source identity; do not collapse different populations |
| Ollama primary / local routing |Tags probe 200; Ollama-routed gemma panel/fallback calls 48/48 ok in 7 d,~1.88 s mean; last 22Oct 00:29Z |CONNECTED and historical bounded call success; not proof all models/current inference healthy. Local-vs-cloud actual execution must follow recorded provider/model, not endpoint brand |
| LiteLLM |Configured primary/map path; endpoint reachability |CONNECTED transport only; management host may be policy-isolated. Show model-route availability, quota and last inference by consumer |
| Ollama Cloud/social provider |Map models 200,~1.1 s in earlier snapshot; usage/error history |CONNECTED; semantic/social capability health UNKNOWN. Correlate last actual round/inference and model availability; do not turn old timeout into current outage |
| NVIDIA safety/embeddings |7 d safety 136/136 recorded ok,602 ms mean; embeddings 92/92 recorded ok,507 ms mean; last23Oct15:22/15:09Z |CONNECTED with recent recorded request successes; semantic model quality and broader health UNKNOWN. Show n/window and latency distribution; retry history not validated |
| TypeSafe JEV |Root 404 reachable; jev 1.13:241 calls 240 ok 936 ms, last 23Oct 15:10Z, one failure 17Oct; 1.14:45/45 ok 263 ms |CONNECTED business requests despite root 404. Quality routing shadow/rejection evidence is separate from transport health; avoid whole-provider FAILED based on root probe |
| OpenCode maker runtime |40 model-call records/17 ok 7 d; lastfailure 23Oct 15:21Z, lastsuccess 22Oct 00:25Z; contract available |DEGRADED observed request cohort 57.5% not-ok, not necessarily 57.5% terminal task failure. Link quota/admission/executor cause, retry/fallback and run IDs |
| Remote/workstation maker |14 records 11 ok, mean~934 s, lastsuccess 21Oct, lastfailure 18Oct |CONNECTED historical; current full capability UNKNOWN. Long duration warrants run-level breakdown before cost/performance conclusion |
| Claude/Codex CLI |Gym transport 10/10Claude,5/5Codex records; separate gym task results can be 0% |Transport success ≠ solved holdout. Show runtime contract/admission, task outcome/gate and priced/unpriced usage together |
| Hermes |Configured checker hermes; knowledge sources hermes-macmini/eve-v had 23Oct activity; Interaction Board social/evidence rows |CONNECTED for observed ingestion/social evidence; full checker E2E not proven. Link active checker lease/proof/last verdict; no new direct endpoint probe attempted |
| OpenClaw |Catalog target and runtime/agent vocabulary/source support |CONFIGURATION/SOURCE evidence; current execution UNKNOWN. Preparing catalog artifacts is explicitly not dispatch |
| Qdrant |Read/write health 200, MCP service dependency Running; existing knowledge paths |CONNECTED; live collection retrieval/write/vector quality unverified. Zero vector_memories SQLite rows do not prove Qdrant empty |
| UAMS/research-agent/knowledge bridge/context7 |Probe Running/200; knowledge bridge 4 catalog tools, others service dependency |CONNECTED transport; current auth and successful retrieval per tool UNKNOWN. Show owning capability, last successful use and failure cause |
| DeerFlow / DjimitKB / SearxNG / LiteLLM management |MCP states Policy Isolated with clear outbound-deny/workstation rule |DISABLED from control-plane path by policy, not FAILED. Existing boundary is intentional; do not bypass to make cards green |
| GitHub/CI |117 loop PRs and 17 dependency rows at earlier view, settlement/review evidence |CONNECTED historically; rate limits, webhook freshness and latest CI adoption not independently validated. Link exact PR/head/check evidence rather than infer from row presence |
| Telegram |Allowlisted identity and polling/config evidence |CONFIGURED; notification delivery/auth/retry and active poll owner UNKNOWN; no message sent |
| Federation |0 peers/34 localcandidate capabilities; frontend recovered |Peer integration UNKNOWN, no configured peer to test; registration excluded |
| Frontier / Commons automation |Respective scheduler/proposal-review flags observed disabled |DISABLED for named automation only; current data can be historical or other active capabilities |
| NAS/object storage |No current operator health or verified storage integration discovered |UNKNOWN; do not invent provider/endpoint. Filesystem worktree health is not NAS/storage proof |

Latency figures are recorded means or point-in-time probe durations, not SLO distributions. Last-failure NULL means none recorded in the bounded query, not never failed. Authentication was not tested by exposing credentials. Retry/backoff policies exist in source and some cockpit diagnostics, but per-integration retry execution was not independently reproduced.

## Read-only investigation boundary

MCP page mount uses `getMCPServers()`→`/mcp/servers?refresh=true`. Handler probes services, updates status/last_ping/error timestamps, and may sync missing OpenAPI tools. This happened through ordinary page inspection; no Add server or permission mutation was clicked. **GET is not read-only here.** Split passive inventory from an explicitly named probe/catalog-sync operation using existing authorization. A low-risk refresh does not need a new confirmation dialog, but it should have clear effect, audit scope and no accidental catalog mutation during read-only investigation. Health scan GET was separately source-reviewed: checks plus filesystem dry-run, not heal.
