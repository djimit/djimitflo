# Phase 6 Implementation Kickoff Tasks

**Target**: 8–12 weeks to completion  
**First Milestone**: Loop contract & goal lifecycle API (Week 1–2)

## Week 1: Foundation Schema & Services Setup

### Task 1.1: Database Schema (Migrations)
**File**: `/packages/server/src/database/migrate.ts`
**Scope**: Add Phase 6 migration function `createPhase6Tables()`
- `goals` table (id, owner_user_id, objective, constraints, acceptance_criteria, risk_class, budget, status, created_at, updated_at)
- `loop_runs` table (id, goal_id, status, trigger_type, stop_condition_met, state, escalation_reason, error_message, created_at, updated_at)
- `worker_leases` table (id, loop_run_id, role, runtime, status, worktree_path, branch_prefix, token_budget, token_used, wall_clock_budget_ms, wall_clock_used_ms, start_time, end_time, stdout, stderr, created_at, updated_at)
- `loop_gates` table (id, loop_run_id, gate_type, status, evidence_refs, blocked_reason, created_at, updated_at)
- Indexes on (owner_user_id, status), (goal_id), (loop_run_id, role)
**Tests**: Migration forward/backward; schema validation; index creation
**Validation**: Run `npm run dev:server` and check `/health` includes Phase 6 schema

### Task 1.2: Loop Service Core
**File**: `/packages/server/src/services/loop-service.ts` (NEW)
**Scope**: Loop state machine & lifecycle
- `createLoop(goal_id, trigger_type, stop_conditions, actions_allowed, verification_schema)` → loop_run
- `startLoop(loop_id)` → set status to `running`
- `stepLoop(loop_id, decision)` → state transition
- `getLoopState(loop_id)` → current state (from database)
- `verifyLoop(loop_id)` → run gate checks
- `closeLoop(loop_id, reason)` → set status to `completed|failed`
**Tests**: State machine transitions; all states reachable; escalation on blocked gates
**Validation**: Loop can be created, started, stepped, verified, and closed

### Task 1.3: Goal Service Core
**File**: `/packages/server/src/services/goal-service.ts` (NEW)
**Scope**: Goal lifecycle
- `createGoal(owner_user_id, objective, acceptance_criteria, risk_class, budget)` → goal
- `decomposeGoal(goal_id)` → list of sub-goals/leases
- `getGoal(goal_id, user_id)` → goal with ownership check
- `listGoals(user_id, status_filter)` → filtered goals
- `closeGoal(goal_id, reason)` → set status to `closed`
**Tests**: Authorization checks; acceptance criteria validation; budget enforcement
**Validation**: Goals can be created, decomposed, and listed

### Task 1.4: API Routes Setup
**File**: `/packages/server/src/routes/goals.ts` (NEW)
**File**: `/packages/server/src/routes/loops.ts` (NEW)
**Scope**:
- `POST /api/goals` → createGoal (requires `create:task` permission)
- `GET /api/goals/:id` → getGoal (ownership-scoped)
- `GET /api/goals` → listGoals (ownership-filtered)
- `PATCH /api/goals/:id` → updateGoal (ownership-scoped)
- `POST /api/loops` → createLoop (requires `execute:task` permission)
- `GET /api/loops/:id` → getLoop
- `PATCH /api/loops/:id` → stepLoop (decision body)
- `GET /api/loops/:id/verify` → verifyLoop
**Tests**: Auth middleware; ownership checks; 404 on inaccessible resources
**Validation**: Curl/Postman can create goals and loops

---

## Week 2: Verification Gates & Checker

### Task 2.1: Verification Gates Service
**File**: `/packages/server/src/services/verification-gates-service.ts` (NEW)
**Scope**: Gate evaluation
- `evaluateGates(loop_id)` → gate_results: { deterministic, checker, security, human }
- Deterministic gates: tests, lint, typecheck (run via subprocess)
- Checker gate: invoke checker worker (deferred; mock for Week 2)
- Security gate: run security scanner
- Human gate: check for human approval in approval_requests table
**Tests**: All gate types pass/fail; backpressure when gates fail
**Validation**: Loop cannot close without gate verdicts

### Task 2.2: Checker Executor Service
**File**: `/packages/server/src/services/checker-executor-service.ts` (NEW)
**Scope**: Read-only checker worker
- `executeChecker(loop_id, maker_diff, evidence)` → checker_lease
- Checker runs in separate worktree with read-only scope
- Checker cannot commit, push, or modify source
- Checker produces verdict: approved|changes-requested|failed
**Tests**: Checker isolation; read-only scope; independent verdict
**Validation**: Maker cannot proceed without checker approval

### Task 2.3: Dashboard Goals/Loops Page
**File**: `/packages/dashboard/src/pages/GoalsLoopsPage.tsx` (NEW)
**Scope**:
- List goals with status (created|planning|running|closed)
- List loops with lifecycle (created|running|verifying|blocked|completed|failed)
- Show goal → loops → leases hierarchy
- Create goal form (objective, acceptance criteria, risk class, budget)
- Loop details view with gate status
**Tests**: Render without errors; create goal form validation
**Validation**: Browser shows Goals/Loops page; can create goal

---

## Week 3–4: Fleet Orchestration & First Loop

### Task 3.1: Fleet Planner Service
**File**: `/packages/server/src/services/fleet-planner-service.ts` (NEW)
**Scope**: Worker assignment
- `planFleet(goal_id)` → worker_role_assignments: maker, checker, security, memory, governance
- Assign workers by role; determine concurrency bounds
- Maker count based on goal budget and task complexity
**Tests**: Fleet plan generation; role distribution
**Validation**: Fleet can be planned for multi-worker execution

### Task 3.2: Worktree Manager Enhancement
**File**: `/packages/server/src/utils/git-worktree-manager.ts` (EXTEND)
**Scope**:
- `createWorktree(lease_id, branch_prefix)` → worktree_path
- Support agent/loop/ branch prefixes for isolation
- Implement retry logic for git lock conflicts (3 attempts, exponential backoff)
**Tests**: Concurrent worktree creation; retry on lock; cleanup
**Validation**: 5 parallel makers can create worktrees without git conflicts

### Task 3.3: First Loop Implementation
**File**: `doc-drift-and-small-fix-loop` integration
**Scope**: End-to-end test with real first loop
- Define loop trigger: "README.md git diff > threshold"
- Define acceptance criteria: "README updated, tests pass, no merge"
- Create goal, loop, maker assignment
- Run maker with bounded token budget
- Verify with checker + deterministic gates
- Close without merge
**Tests**: Full loop lifecycle; no git conflicts; no merge
**Validation**: First loop completes successfully in local dev

### Task 3.4: Fleet Cockpit Dashboard
**File**: `/packages/dashboard/src/pages/FleetCockpitPage.tsx` (NEW)
**Scope**:
- Show pool status: available/prepared/queued/running/completed/failed
- Show queue depth, token burn, warnings
- Show worker role distribution
- Show next safe action
**Tests**: Render without errors; show real data
**Validation**: Fleet Cockpit displays pool status live

---

## Acceptance Criteria for Phase 6 Week 1–4

✅ **Week 1**:
- [ ] Phase 6 database schema passes migration tests
- [ ] Loop service can create, start, step, verify, close loops
- [ ] Goal service can create and decompose goals
- [ ] `/api/goals` and `/api/loops` endpoints respond with auth checks

✅ **Week 2**:
- [ ] Verification gates evaluate deterministic checks (tests, lint, typecheck)
- [ ] Checker executor runs in isolated worktree
- [ ] Dashboard Goals/Loops page renders
- [ ] Can create goal via API and see in dashboard

✅ **Week 3–4**:
- [ ] Fleet planner assigns makers/checker/security/memory roles
- [ ] 5 concurrent makers create worktrees without git conflicts
- [ ] `doc-drift-and-small-fix-loop` completes end-to-end
- [ ] Loop closes with gates passed, no merge
- [ ] Fleet Cockpit shows pool status live

---

## Dependencies & Blockers

**Must-have by Week 1**:
- Phase 5 auth/ownership model (already complete ✅)
- SQLite schema migration system (already complete ✅)

**Phase 6 → Later phases**:
- Phase 8 (runtime contracts) needs Phase 6 loop/lease model
- Phase 7 (intelligence kernel) needs Phase 6 goal/loop structure
- Phase 11 (enforcement) needs Phase 6 + 7 + 8

---

## Success Metrics

| Metric | Target | Validation |
|--------|--------|-----------|
| Loop creation latency | < 100ms | Time loop creation API call |
| Goal acceptance criteria validation | 100% reject invalid | Test invalid criteria |
| 5 concurrent makers | No git conflicts | Run 5 parallel worktrees |
| Checker verdict enforcement | 100% block bypass | Maker cannot close loop without checker approval |
| Dashboard render time | < 500ms | Browser DevTools timeline |
| First loop duration | < 15 min (bounded) | Token budget enforced |

---

## Daily Progress Tracking

**Day 1–2**: Task 1.1 (Schema) + 1.2 (Loop Service)  
**Day 3–4**: Task 1.3 (Goal Service) + 1.4 (Routes)  
**Day 5–6**: Task 2.1 (Gates) + 2.2 (Checker)  
**Day 7–8**: Task 2.3 (Dashboard)  
**Day 9–12**: Task 3.1 (Fleet) + 3.2 (Worktree) + 3.3 (First Loop)  
**Day 13–14**: Task 3.4 (Cockpit) + validation

---

**Next Daily Loop Iteration**: Review completed tasks, identify blockers, adjust schedule if needed.
