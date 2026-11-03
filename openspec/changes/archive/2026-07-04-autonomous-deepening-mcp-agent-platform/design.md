## Context

DjimFlo is a TypeScript monorepo (npm workspaces) with 118 services, 10 executors, 1174 tests, and clean build. Graph analysis shows 3866 nodes, 40420 edges, 18 communities. LoopService is the #1 bridge node (betweenness 0.0323). The codebase has proven the facade decomposition pattern with LoopBudgetService extraction (12 methods delegated, 1174 tests pass, zero regressions).

External research confirms:
- MCP TypeScript SDK v1 is stable with Express middleware (@modelcontextprotocol/express)
- Deep Agents (LangChain) proves sub-agent context isolation pattern
- AutoAgent (HKUDS) proves NL-driven agent creation
- Dify/Sim prove visual pipeline builders

## Goals / Non-Goals

**Goals:**
- Expose ALL DjimFlo capabilities via MCP (loops, goals, agents, workers, intelligence)
- Isolate sub-agent context windows to prevent pollution
- Enable NL to agent creation pipeline
- Reduce LoopService from ~4900 LOC to <3000 LOC via decomposition
- Reduce createSwarmRoutes blast radius from 442 to <50 edges per factory
- Provide visual pipeline builder for agent workflows
- Zero breaking changes to existing HTTP APIs
- Each phase runs autonomously with human approval only at ship gate

**Non-Goals:**
- No changes to shared/telegram packages
- No database schema migrations (additive only)
- No new LLM model integrations (use existing LiteLLM routing)
- No changes to existing test files (additive only)
- Visual builder is agent-only in Phase C2

## Decisions

### D1 — MCP Server as New Package (Not Inline)
**Decision**: Create `@djimitflo/mcp-server` as a separate workspace package.
**Rationale**: MCP server has different dependencies, lifecycle, and deployment model. Separation allows independent versioning.
**Trade-off**: One more package to maintain. Worth it for clean boundaries.

### D2 — MCP Transport: Stdio Primary, HTTP Secondary
**Decision**: Stdio for local Claude Code/Cursor. Streamable HTTP for remote fleet access.
**Rationale**: Stdio is lowest-friction for local coding agents. HTTP enables fleet-wide access.
**Trade-off**: Two transport modes. MCP SDK makes this trivial.

### D3 — Context Isolation via Metadata Extension
**Decision**: Add contextBudget and messageHistory to spawn_trees metadata, not new tables.
**Rationale**: Minimal schema changes. Reuses NestedSpawnService. Backward-compatible.
**Trade-off**: JSON blob vs structured columns. Acceptable for v1.

### D4 — Route Decomposition: Domain-Based Split
**Decision**: Split createSwarmRoutes into createWorkerRoutes, createIntelligenceRoutes, createGovernanceRoutes.
**Rationale**: Each domain has distinct permission models. Matches existing pattern (goals.ts, loops.ts already separated).

### D5 — NL Agent Creation: LLM-Generated Config + Human Approval
**Decision**: LLM generates config from NL description. Human reviews before activation.
**Rationale**: Full autonomy is risky for agent creation. Human approval prevents misconfigured agents.

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP server breaks existing Express middleware | Low | High | MCP server is additive; existing routes unchanged |
| Context isolation adds latency | Low | Low | Context loading is async; budget check is O(1) |
| Route decomposition breaks API contracts | Medium | High | Integration tests verify all routes; phased rollout |
| NL agent creation generates unsafe configs | Medium | High | Human approval gate before activation |
| Visual builder scope creep | Medium | Medium | Phase C2 is agent-only |
