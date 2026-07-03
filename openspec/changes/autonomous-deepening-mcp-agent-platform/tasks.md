# Implementation Tasks

## Phase A — External Integration

### Goal: DjimFlo is accessible via MCP and sub-agents have context isolation

- [x] A1.1 Create `packages/mcp-server/` workspace with package.json, tsconfig.json, src/index.ts
- [x] A1.2 Implement McpServer class registering loop tools (start_loop, continue_loop, get_loop_status)
- [x] A1.3 Implement goal tools (create_goal, list_goals, get_goal)
- [x] A1.4 Implement agent tools (list_agents, get_agent_status, spawn_worker, get_mission_control)
- [x] A1.5 Add StdioServerTransport for local Claude Code/Cursor integration
- [x] A1.6 Add StreamableHttpServerTransport for remote fleet access
- [x] A1.7 Write MCP server tests (tool registration, request/response, both transports)
- [x] A1.8 Register MCP server in root `.mcp.json` for auto-discovery
- [x] A2.1 Add contextBudget and messageHistory to spawn_trees metadata schema
- [x] A2.2 Implement context window isolation in NestedSpawnService.prepareNestedLease()
- [x] A2.3 Implement auto-summarization when context exceeds budget
- [x] A2.4 Write tests for context isolation (budget enforcement, backward compatibility)
- [x] A2.5 Run full test suite — verify 0 regressions
- [ ] A2.6 **HUMAN APPROVAL GATE A**: Review MCP server + context isolation

## Phase B — Architecture Decomposition

### Goal: LoopService reduced by ~2000 LOC, route blast radius reduced by 80%

- [x] B1.1 Extract WorktreeManager service (createWorktree, applySourceWorkingTreeDiff, branchNameFor, pruneOrphanedWorktrees)
- [x] B1.2 Wire LoopService delegation to WorktreeManager
- [x] B1.3 Run full test suite — verify 0 regressions
- [x] B2.1 Extract GoalService (createGoal, listGoals, getGoal, updateGoal, decomposeGoal)
- [x] B2.2 Wire LoopService delegation to GoalService
- [x] B2.3 Run full test suite — verify 0 regressions
- [~] B3.1 Extract createWorkerRoutes from createSwarmRoutes (deferred — large effort, ~30+ routes, needs dedicated iteration)
- [~] B3.2 Extract createIntelligenceRoutes from createSwarmRoutes (deferred)
- [~] B3.3 Extract createGovernanceRoutes from createSwarmRoutes (deferred)
- [~] B3.4 Update routes/index.ts to use new factories (deferred)
- [~] B3.5 Run server-routes.test.ts — verify all routes still mounted (deferred)
- [~] B3.6 Run full test suite — verify 0 regressions (deferred)
- [~] B3.7 **HUMAN APPROVAL GATE B**: Review decomposition results (deferred)

## Phase C — Capability Expansion

### Goal: NL-driven agent creation + visual pipeline builder

- [x] C1.1 Create POST /api/agents/create-from-description endpoint
- [x] C1.2 Implement LLM pipeline: NL description → agent config (system prompt, tools, risk class)
- [x] C1.3 Integrate with AgentRegistryService for OKF markdown generation
- [x] C1.5 Write tests for NL agent creation
- [x] C2.1 Add @xyflow/react dependency to dashboard package.json
- [x] C2.2 Create PipelineBuilderPage.tsx with React Flow canvas
- [x] C2.3 Implement drag-and-drop nodes (Goal, Loop, Worker, Checker, Learning)
- [x] C2.4 Implement edge connections between nodes
- [x] C2.5 Add export to OpenSpec change functionality
- [x] C2.6 Write PipelineBuilderPage tests
- [ ] C2.7 **HUMAN APPROVAL GATE C**: Review NL agent creation + visual builder

## Validation & Ship Gate

- [ ] V.1 Run full test suite — target: >1230 tests, 0 failures
- [ ] V.2 Run type-check — clean across all workspaces
- [ ] V.3 Run lint — clean across all workspaces
- [ ] V.4 Run build — all workspaces build successfully
- [ ] V.5 CodeReviewGraph analysis — verify LoopService betweenness reduced by >30%
- [ ] V.6 CodeReviewGraph analysis — verify createSwarmRoutes edges reduced from 442 to <100
- [ ] V.7 Security review — no CRITICAL/HIGH findings
- [ ] V.8 Write ADR-001: MCP server architecture decision
- [ ] V.9 Write ADR-002: Sub-agent context isolation pattern
- [ ] V.10 Write ADR-003: Route factory decomposition strategy
- [ ] V.11 **FINAL HUMAN APPROVAL**: Review all artifacts, approve for production
