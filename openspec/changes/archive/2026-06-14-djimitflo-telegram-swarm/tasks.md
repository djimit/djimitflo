# Tasks — djimitflo-telegram-swarm

## High-Level Order

1. Design update (D7 + D8) — OKF runtime (Qdrant + GraphStore + MCP)
2. Specs complete (agent-registry, context-injection, skills-distribution, swarm-training; add OKF write to swarm-memory)
3. Create djimitflo-knowledge repo + OKF seed
4. Implement TelegramGatewayService + registry + heartbeat
5. MemorySyncService (UAMS/Qdrant) + OKF write
6. OKF tools (validate/index/rebuild) + MCP server
7. ContextInjectionService (Qdrant + OKF traversal)
8. WorkspaceProvisionerService (SSH primair, Telegram fallback)
9. Skills lifecycle (acquire → validate → push)
10. Training export + ReasoningBank

## Detailed Tasks

T01: Create repo djimitflo-knowledge (GitHub) and local clone
T02: Seed OKF structure: okf/agents, okf/services, okf/skills, okf/models, okf/repos, okf/memory, okf/runs
T03: Add symlink in djimitflo: `knowledge -> ../djimitflo-knowledge/okf` (developer ergonomics)

T04: DB migration — add columns to `agents`:
  - telegram_bot_id, telegram_bot_name, machine_ip, agent_type, host_machine_id, okf_concept_path, last_heartbeat_at

T05: New route `POST /api/agents/:id/heartbeat` (authz: admin/operator)
T06: AgentRegistryService — write/update OKF agent concept + agents/index.md

T07: New workspace `packages/telegram/` with grammy; implement TelegramGatewayService managing 6 bots
T08: Telegram handlers: `/task`, `/status`, `/approve`, `/memory`, `/research`
T09: WebSocket integration: broadcast task events to originating machine bot

T10: MemorySyncService — write to UAMS (retry/backoff)
T11: MemorySyncService — embed to Qdrant `djimitflo_swarm` (auto-create with dim=384)
T12: MemorySyncService — write OKF CompletedTask concept (staged, no auto-commit)

T13: djimitflo-knowledge tools:
  - validate_okf.py — frontmatter + link checks
  - index_qdrant.py — chunk → embed (nomic-embed-text:latest via Ollama) → upsert into `djimit_okf`
  - index_graphstore.py — extract nodes/edges → write to `combined_graph.db` (new repo row)
  - rebuild_indexes.py — orchestrate validate → qdrant → graph; write reports/index_status.json

T14: MCP server `mcp/okf_mcp_server.py` (fastmcp stdio) with tools:
  - okf_search(query, type?, limit?) → Qdrant `djimit_okf`
  - okf_get(concept_id)
  - okf_related(concept_id, depth?) → GraphStore
  - okf_reindex(scope?) → run rebuild_indexes.py
  - okf_status() → counts/errors/last_indexed

T15: Register OKF MCP in workstation master-mcp.json

T16: ContextInjectionService — combine Qdrant `djimitflo_swarm` + OKF traversal via MCP; trust-level aware ranking

T17: WorkspaceProvisionerService — SSH primair, Telegram fallback; generate SOUL.md, USER.md, TOOLS.md, AGENTS.md, HEARTBEAT.md per machine

T18: SkillValidatorService — isolated process path (timeout, cwd jail, env whitelist, dry-run)
T19: SkillValidatorService — Docker path for high-risk categories (no-new-privs, cap-drop=ALL, network=none)
T20: Skills push — Hermes via Telegram (file message to ~/.hermes/skills/), OpenClaw via Admin RPC; log to okf/skills/log.md

T21: Training export endpoint `/api/exports/training` (JSONL; leakage-free); ReasoningBankService writes to `djimitflo_reasoning`

T22: Commit automation — checkpoint auto-commit at validated run end or daily rollup; never per task

## Constraints
- SSH primary provisioning; Telegram fallback
- HEARTBEAT: daily, random between 03:00–06:00
- No git push without explicit approval
- Local-only networking; no external dependencies beyond current stack
