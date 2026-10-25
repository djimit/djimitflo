# Configuration architecture assessment

Current browser/source evidence supersedes the earlier env-only finding. Configuration now presents300 settings,268 environment entries,75 overrides and20 masked secrets, task-area navigation and Raw view. Filtering MEMORY_HOLDOUT_RATE shows effective .3, env source, default0, overridden state and restart guidance ([01 screenshot](01-effective-memory-config.png)). Positive filtering works. This is a useful existing foundation.

| Mechanism | Effective owner / visibility | Residual gap and implementation direction |
|---|---|---|
| Process env + code defaults | runtime-config-view.ts, health/config, ConfigurationPage | Defaults/source now visible; don't rebuild this subsystem. Add resolution context only where actual consumer precedence differs |
| Loop/model routing | LoopService, assignment context, runtime contracts, provider executors; env flags | A configured model/flag is not proof the selected runtime used it. Show requested/resolved/fallback model and policy at run detail |
| Meta tuning | meta-orchestration-service.ts, persisted tuning history; Self-Driving/Audit | Confidence .9 is heuristic; current runtime-budget changes logged. Catalog restart label does not explain DB tuning/next-run resolution. Link exact tuning revision to affected run |
| Skills admission | configuredSkillsDir/allowlist; both unset in current process | agent_skills0 and admission disabled by policy. Explain disabled rather than broken. Enable/disable/reload routes return503 without shared activation adapter; do not expose as working editor |
| Per-skill files/manifests | canonical agent-skills repo and native Hermes/OpenClaw roots | Package hashes/manifest/lifecycle visible to files, no runtime crosswalk. Add existing registry metadata/provenance links before any activation UI |
| Memory | LOOP_MEMORY_RULES_ENABLED, .3holdout, assignment hashes; promotion statuses/review | Process config, per-goal assignment, content hash and retention/use policy differ. Show effective rule set/withheld reason on run; never unmask memory text broadly |
| Knowledge/RAG | typed stores, embedding collection/model/dimension, ACE assignment | Collection presence is not compatible embedding/retrieval. Expose declared collection/model/dimension plus observed failure counter and freshness |
| Evolution/experiments | experiment-registry, protocol files, arm metadata, env flags, genome registry | Existing frozen protocols must stay frozen. Show effective mode, protocol/version, assignment/delivery, sample target, due decision, WIP exceptions and restart/next-run behavior |
| Budget/retry/timeout | runtime contract, LoopService/executor, gym/adapters | Several defaults and DB/per-run changes resolve after env display. Show source chain for selected run, not speculative universal settings |
| Integration | adapter/env, Fleet runtime contracts, MCP catalog, service-map | Configured, responded, auth-accepted, ready and last business outcome remain separate states |

Recommended flow: common task-area settings in current Configuration; progressive disclosure for defaults and advanced parameters; entity detail links to the subset actually used. Each effective value should carry source (default/env/DB/run override), revision/time, masked value and activation timing (immediate/next assignment/restart/redeploy). Source metadata must be generated at the actual resolver; don't implement a second precedence engine in the UI. Restart guidance for an env row is correct for that source but insufficient for a DB override.

Read-only inspection must not trigger refresh writes. MCP mount currently requests refresh=true and can persist probes/catalog; retain explicit, authorized refresh but make ordinary load passive. No additional confirmations are needed for ordinary reads. Secret field names and configured/absent state may be exposed, never credential values. Security scope/tenant behavior must remain unchanged.

Acceptance: fixture env/default/DB/per-run precedence agrees with the consumer; a newly created run records its selected revision without changing existing runs; masks remain after filtering/export/error; disabled capability reports why and where it can be enabled. No configuration was edited during this audit. See L6-05/07 and baseline DF-07/10 in [17](17-engineering-backlog.md).
