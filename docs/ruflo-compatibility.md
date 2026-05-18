# Ruflo Compatibility

## Classification: Conceptually Mapped

Ruflo is an open-source agent orchestration framework by [ruvnet](https://github.com/ruvnet). Djimitflo draws conceptual inspiration from Ruflo's approach to agent orchestration but has **no runtime dependency** on Ruflo and zero Ruflo code in the Djimitflo codebase.

## What Ruflo Provides

- Multi-agent swarm coordination
- AgentDB with HNSW/SONA memory systems
- 32+ plugins (web search, file system, GitHub, etc.)
- Claude Code hooks (pre/post execution lifecycle)
- MCP server integration
- Federation across multiple Claude Code instances
- Memory persistence across sessions

## Concept Mapping

| Ruflo Concept | Djimitflo Equivalent | Status |
|---------------|---------------------|--------|
| Task orchestration | ExecutionEngine + TaskExecutor | Implemented |
| Agent management | Agent model + monitoring | Implemented |
| Approval/prompts | PolicyDecisionService + ApprovalWorkflow | Implemented |
| Memory/context | Evidence chain + audit trail | Implemented |
| Hooks (pre/post) | DiffCaptureService (pre/post snapshots) | Implemented |
| Repository scanning | RepositoryScanner + health scoring | Implemented |
| AGENTS.md governance | AgentsMdValidator + effective stack | Implemented |
| MCP tools | MCP model + API endpoints | Implemented |
| Swarm coordination | — | Not implemented |
| AgentDB/SONA memory | — | Not implemented |
| Ruflo plugins | — | Not implemented |
| Claude Code dependency | — | Not applicable (Djimitflo uses OpenCode) |
| Federation | — | Not implemented |
| Session continuity | — | Not implemented |
| Worktree management | — | Not implemented |

## Key Differences

1. **Runtime dependency**: Ruflo depends on Claude Code. Djimitflo depends on OpenCode.
2. **Orchestration model**: Ruflo uses swarm-based multi-agent coordination. Djimitflo uses policy-gated single-agent execution with approval workflows.
3. **Memory**: Ruflo has persistent vector-based memory (HNSW). Djimitflo has SQL-based evidence chains and audit trails.
4. **Deployment**: Ruflo is CLI-first. Djimitflo is dashboard/control-plane first.
5. **Governance**: Djimitflo has a policy engine with risk classification, approval gates, and security overrides. Ruflo relies on Claude Code's built-in permissions.

## Known Upstream Instability

- Ruflo README commands may not match actual CLI behavior
- Ruflo's positioning has shifted ("codex orchestration CLI" → "multi-agent AI orchestration for Claude Code")
- Plugin ecosystem is in flux

## Recommended Approach

Djimitflo should continue to draw **conceptual inspiration** from Ruflo's orchestration patterns, but should not introduce a runtime dependency. If Ruflo matures and stabilizes, specific patterns (hooks, memory, federation) can be evaluated for adoption without coupling to Ruflo's implementation.