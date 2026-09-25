## Why

DjimFlo has achieved a clean build (1174 tests, type-check clean, lint clean) and completed Phase 1-2 of the "Go Deeper First" plan (LoopBudgetService extracted, error handler tested, path traversal fixed, server routes tested). Five critical gaps remain that block Level-19 feature development:

1. **No external integration point**: DjimFlo cannot be controlled by Claude Code, Cursor, OpenClaw, or any MCP-compatible agent. Every other major agent platform exposes MCP servers. DjimFlo is an island.
2. **No sub-agent context isolation**: NestedSpawnService has depth/cycle/budget gating but sub-agents share context windows. Deep Agents proves that isolated context windows prevent context pollution.
3. **No NL-driven agent creation**: AutonomousGoalGenerator creates goals from self-improvements but cannot create agents from natural language. AutoAgent proves this pattern works.
4. **LoopService still ~4900 LOC**: After budget extraction, the God Class remains the #1 architectural chokepoint (betweenness 0.0323). Worktree management, goal CRUD, and route factories need decomposition.
5. **No visual pipeline builder**: Dashboard monitors but cannot build agent pipelines. Dify/Sim prove drag-and-drop flow builders are essential.

This change creates 7 autonomous-executable work items across 3 phases, each with a human approval gate. Each item is designed to run to completion autonomously with the DjimFlo swarm/critic/reviewer pipeline, with human intervention only at the final ship gate of each phase.

## What Changes

### Phase A — External Integration (Autonomous)
- **A1. DjimFlo MCP Server**: New `@djimitflo/mcp-server` package exposing loop orchestration, goal management, and agent capabilities as MCP tools. Stdio + Streamable HTTP transports.
- **A2. Sub-agent Context Isolation**: Extend NestedSpawnService with per-agent context windows, message history isolation, and auto-summarization.

### Phase B — Architecture Decomposition (Autonomous)
- **B1. WorktreeManager Extraction**: Extract git/worktree operations from LoopService into dedicated service.
- **B2. GoalService Extraction**: Extract goal CRUD from LoopService into dedicated service.
- **B3. Route Factory Decomposition**: Split createSwarmRoutes (442 edges) into 4 domain-specific factories.

### Phase C — Capability Expansion (Autonomous)
- **C1. NL-Driven Agent Creation**: POST endpoint + LLM pipeline to create agents from natural language descriptions.
- **C2. Visual Pipeline Builder**: React Flow-based drag-and-drop agent pipeline builder in dashboard.

## Capabilities

### New Capabilities
- `mcp-server-exposure`: DjimFlo capabilities exposed as MCP tools for external agent control
- `sub-agent-context-isolation`: Isolated context windows for nested spawned agents
- `nl-driven-agent-creation`: Create agents from natural language descriptions
- `visual-pipeline-builder`: Drag-and-drop agent pipeline builder in dashboard

### Modified Capabilities
- `loop-service-facade`: LoopService becomes thin facade delegating to WorktreeManager, GoalService
- `swarm-routing`: createSwarmRoutes split into domain-specific route factories

## Impact

- **Affected packages**: `@djimitflo/server` (primary), `@djimitflo/dashboard` (Phase C2), new `@djimitflo/mcp-server`
- **APIs**: No breaking HTTP API changes. New MCP endpoint. New REST endpoint for NL agent creation.
- **Dependencies**: `@modelcontextprotocol/server` (v1, stable), `@xyflow/react` (Phase C2 only)
- **Systems**: DjimFlo server + dashboard. No changes to shared/telegram packages.
- **Risk**: Medium. Each phase is independently shipable with rollback. MCP server is additive. Decomposition uses proven facade pattern.
- **Estimated effort**: 35-40 hours across 7 items. Each item designed for autonomous execution.
