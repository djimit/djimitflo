# Tasks

## Phase 1 — G14 Closure (next-level-swarm-skills-specialists)

- [ ] Check off G14.1: swarm_missions/tasks/decisions tables + state machine (tested by g14-swarm-intelligence.test.ts).
- [ ] Check off G14.2: capability registry + contracts + status gates (tested by swarm-intelligence-service.test.ts).
- [ ] Check off G14.3: specialist panels + dissent + consensus-to-backlog (tested by swarm-resource-plan.test.ts).
- [ ] Check off G14.4: evidence graph + claim ledger + contradiction + secret rejection (tested by swarm-intelligence-service.test.ts).
- [ ] Check off G14.5: capacity governor v2 + queue classes + fair-share + kill (tested by swarm-intelligence-service.test.ts).
- [ ] Check off G14.6: evaluation harness + deterministic scorecards (tested by swarm-resource-plan.test.ts).
- [ ] Check off G14.7: Mission Control dashboard + evidence-backed counts (tested by swarm-intelligence-service.test.ts).
- [ ] Check off G14.8: quorum gate + runner manifests + replay + warning gates (tested by swarm-intelligence-service.test.ts + swarm-resource-plan.test.ts).
- [ ] Check off G14.9: end-to-end swarm smoke (tested by g14-swarm-intelligence.test.ts).
- [ ] Run `openspec validate next-level-swarm-skills-specialists --strict`.

Validation:
- [ ] All 40 G14 tasks checked off with evidence references.
- [ ] `openspec validate next-level-swarm-skills-specialists --strict` exits 0.

## Phase 2 — G15 Enforcement (g15-enforced-swarm-intelligence)

### G15.1 Security Boundary
- [ ] Constrain OKF drift/sync to configured roots with canonical realpath checks.
- [ ] Remove arbitrary filesystem paths from OKF drift endpoints.
- [ ] Extend shared secret-like detector to all mutating endpoints.
- [ ] Replace broad `create:task` with scoped permissions.
- [ ] Move cockpit/workstation labels to runtime node config.
- [ ] Add evidence-ref resolver helpers.
- [ ] Add tests for path escape refusal, secret rejection, scoped permission refusal.

### G15.2 Capability Promotion
- [ ] Split `registerCapability` into `createCandidate` + `promoteCapability`.
- [ ] Require promotion evidence refs, eval scorecard, owner, version, risk ceiling.
- [ ] Require security checker + human approval for high/critical promotion.

### G15.3 Governance Enforcement
- [ ] Add `EnforcementDecisionService` for mutating actions.
- [ ] Stop accepting spoofable governance booleans; accept refs and resolve persisted evidence.
- [ ] Enforce maker/checker/security/quorum/human approval refs against stored records.
- [ ] Ensure `ready_for_human_merge`, `human_approved`, `completed` remain distinct.
- [ ] Write trace spans for each enforcement decision.

### G15.4 Claim Ledger V2
- [ ] Add typed claim fields: predicate, object, scope, valid_from, valid_until, sensitivity.
- [ ] Replace same-subject heuristics with explicit supports/refines/contradicts edges.
- [ ] Require evidence refs to resolve before claim promotion.
- [ ] Add specialist-review-to-claim extraction.
- [ ] Add retention/deletion metadata for evidence and memory candidates.
- [ ] Add tests for contradiction, unsupported claim, expired claim, sensitive evidence.

### G15.5 Evidence Graph Resolver
- [ ] Add lineage resolver APIs for forward and reverse traversal.
- [ ] Add evidence graph summaries for dashboard cards.
- [ ] Ensure graph traversal respects permission scope.
- [ ] Add tests for panel-to-memory lineage, lease-to-claim reverse lookup.

### G15.6 Runner Manifest Auto-Write (extend existing)
- [ ] Add auto-write for skip, stop, kill, timeout, drain actions.
- [ ] Attach stdout/stderr/artifact refs and token usage to manifests.
- [ ] Write before/after checkpoint refs around worker execution.
- [ ] Add tests for timeout manifest, killed worker manifest, drain summary.

### G15.7 Capacity Governor Live Scheduler (extend existing)
- [ ] Implement configurable fair-share weights with starvation protection.
- [ ] Enforce runtime concurrency slots per adapter and risk class.
- [ ] Enforce token/wall-clock/retry/failure budgets before worker start.
- [ ] Add process-aware stop/kill adapters for Codex/OpenCode.
- [ ] Wire circuit breaker into `startNextWorker`.
- [ ] Add tests for fair-share ordering, exhausted budgets, stop/kill evidence.

### G15.8 OKF Skill Sync + Hypothesis Workbench
- [ ] Index OKF skill roots into capability candidates.
- [ ] Keep sync dry-run by default; require explicit apply.
- [ ] Persist specialist profile registry versions.
- [ ] Add hypothesis entities with evidence plan, falsification signal, stop condition.
- [ ] Add panel-to-backlog and hypothesis-to-goal projection without starting workers.
- [ ] Add tests for draft skill advisory-only, validated skill eligibility, hypothesis stop.

### G15.9 Mission Control Drill-Through
- [ ] Add drill-through links from dashboard metrics to evidence records.
- [ ] Add gated operator actions for OKF validate, sync, close learning.
- [ ] Add latest learning outcome panel with score delta.
- [ ] Add tests for drill-through evidence chain.

Validation:
- [ ] `openspec validate g15-enforced-swarm-intelligence --strict` exits 0.
- [ ] `npm run test` exits 0.
- [ ] `npm run type-check` exits 0.

## Phase 3 — G16 No-Theater Proof (g16-no-theater-swarm-proof)

### G16.1 Runtime Contract Repair
- [ ] Fix CodexExecutor flags: `exec --json --cd`.
- [ ] Add `codex-executor.test.ts` covering flags, sandbox, timeout.
- [ ] Extract shared runtime contract probe for loop-service + execution-engine.
- [ ] Add contract fixtures for available/drifted/unavailable.
- [ ] Ensure contract output includes command, version, status, reason, evidence, checked_at.

### G16.2 Enforcement Repair (overlaps G15.1-G15.4)
- [ ] Add canonical OKF/workspace root allowlist.
- [ ] Replace raw `okf_base` query with configured root id.
- [ ] Replace broad permissions with scoped permissions.
- [ ] Require governance to resolve persisted refs.
- [ ] Block direct public assertion of completed runner manifests.
- [ ] Add typed claim predicate/object/scope fields.
- [ ] Add tests for path escape, spoofed governance, spoofed manifest, non-contradiction.

### G16.3 OpenCode MCP And Skills Health
- [ ] Add OpenCode config inspector for `opencode.jsonc`.
- [ ] Detect missing `mcp`, `tools`, `agent`, `permission.skill` sections.
- [ ] Run `opencode mcp list` with timeout; classify status.
- [ ] Add remediation text for `database is locked`.
- [ ] Add per-agent MCP exposure recommendations.
- [ ] Add OpenCode skill permission scanner → capability candidates.
- [ ] Add tests for locked MCP DB, missing config, credential redaction.

### G16.4 OpenAI Capability Descriptors
- [ ] Add descriptor kinds for OpenAI Agents SDK, Skills, MCP/connectors.
- [ ] Require explicit approval/authorization refs for remote MCP.
- [ ] Treat OpenAI hosted skills as privileged candidates until reviewed.
- [ ] Add adapter boundary docs: local runtime stays Codex/OpenCode until SDK proof.
- [ ] Add tests that OpenAI descriptors cannot route local workers without adapter proof.

### G16.5 Proof Run Service
- [ ] Add `ProofRunService` with rollback group.
- [ ] Register ≥6 capabilities (mock, codex, opencode, OKF skill, specialist, harness).
- [ ] Create specialist panel with ≥3 reviews and dissent/evidence refs.
- [ ] Create ≥3 typed claims (proposed, supported, review-required).
- [ ] Create backlog item + goal from panel/claim evidence.
- [ ] Create loop run + ≥2 worker leases.
- [ ] Execute maker/checker through mock runtime.
- [ ] Write trace spans, checkpoints, runner manifests, memory candidate.
- [ ] Attach proof-run metadata to every created record.

### G16.6 Proof Run API And CLI
- [ ] Add `POST /api/swarms/proof-runs` to start mock proof run.
- [ ] Add `GET /api/swarms/proof-runs/:id` for status and evidence.
- [ ] Add `POST /api/swarms/proof-runs/:id/rollback` for demo rollback.
- [ ] Add `npm run swarm:proof` script.
- [ ] Add `npm run swarm:proof:rollback` script.
- [ ] Ensure proof run auto-starts mock workers; release actions are explicit.

### G16.7 Mission Control Proof Output
- [ ] Add proof-run summary section to Mission Control.
- [ ] Show live counts vs required minimums.
- [ ] Show latest proof-run id, status, runtime, rollback status.
- [ ] Link to created goal, loop, leases, claims, panel, traces, manifests, memory.
- [ ] Show missing evidence as blocking facts.
- [ ] Add dashboard smoke test for proof section.

### G16.8 Live Workstation Proof Smoke
- [ ] Run database migration on workstation.
- [ ] Capture pre-run zero-state counts.
- [ ] Run mock proof run.
- [ ] Capture post-run nonzero counts.
- [ ] Capture Mission Control API proof output.
- [ ] Capture dashboard screenshot/browser smoke.
- [ ] Run rollback.
- [ ] Capture rollback counts.

Validation:
- [ ] `openspec validate g16-no-theater-swarm-proof --strict` exits 0.
- [ ] `npm run test` exits 0.
- [ ] `npm run build --workspace=@djimitflo/dashboard` exits 0.

## Phase 4 — Pi Executor + Loop Runtime

### Pi Executor (add-pi-executor)
- [ ] `canExecute` returns true for code tasks.
- [ ] JSON-mode run maps events to TASK_STARTED/TOOL_CALL/LOG/TASK_COMPLETED/TASK_FAILED.
- [ ] Non-JSON run falls back to heuristic parsing with EVIDENCE WARNING.
- [ ] `cancel()` SIGTERM-then-SIGKILL.
- [ ] Run real task through djimitflo → PiExecutor → Ollama, zero egress.
- [ ] Verify diff snapshot, risk classification, audit trail.
- [ ] Verify approval-gate behavior: djimitflo is authoritative.
- [ ] Verify AGENTS.md precedence (workspace > project > djimitflo).
- [ ] Update `docs/integrations.md` Pi status to Verified.

### Pi Loop Runtime (add-pi-loop-runtime)
- [ ] Confirm runtime union sites in loop-service.ts.
- [ ] Extract `buildPiArgs` + `mapPiEvent` into shared module.
- [ ] Add `'pi'` to runtime literals at four sites + RuntimeContract.
- [ ] Implement `getRuntimeContract('pi')` probe.
- [ ] Add `'pi'` case in `buildRuntimeCommand`.
- [ ] Map `skipPermissions` to Pi behavior (always-true, risk via PI_TOOLS).
- [ ] Ensure spawn cwd is worktreePath.
- [ ] Parse `message.usage` into worker lease runtime usage.
- [ ] Add tests for Pi runtime command, contract probe, usage parsing.

Validation:
- [ ] `openspec validate add-pi-executor --strict` exits 0.
- [ ] `openspec validate add-pi-loop-runtime --strict` exits 0.
- [ ] `npm run test` exits 0.

## Phase 5 — Agentic Loop Fleet Closure (agentic-control-loop-fleet)

- [ ] Document Ruflo as inspiration only; Codex/OpenCode is runtime target.
- [ ] Capture live Codex/OpenCode executor contracts from local binaries.
- [ ] Define Agentic Control Loop glossary (goal, loop, step, worker, lease, gate, verdict, memory).
- [ ] Create evidence folder `agent-evidence/agentic-control-loop-fleet/`.
- [ ] `openspec validate agentic-control-loop-fleet --strict` exits 0.
- [ ] Docs no longer imply Ruflo runtime dependency.
- [ ] Codex/OpenCode capabilities proven from local binaries or marked unavailable.
- [ ] Loop can resume from persisted state after server restart.
- [ ] Validate skills before any active loop uses them.

## Phase 6 — Workstation Deployment (commit-workstation-smoke-and-policy-runner)

### Commit
- [ ] Review dirty worktree and identify scoped paths.
- [ ] Run `git diff --check`.
- [ ] Re-run targeted validation for server, dashboard, OpenSpec.
- [ ] Selectively stage only scoped implementation and OpenSpec files.
- [ ] Confirm no secrets or local env values are staged.
- [ ] Commit with scoped message.

### Deploy
- [ ] Deploy/restart committed server on workstation.
- [ ] Verify server health and version.
- [ ] Verify `/api/loops/runtime-contracts`.
- [ ] Verify `/api/swarms/status` including `fleet_pools`.
- [ ] Verify dashboard Fleet Cockpit from MacBook.
- [ ] Verify Goals/Loops prepared maker/checker controls.
- [ ] Run scheduler tick in safe mode without starting workers.

### Smoke
- [ ] Runtime contract output captured for Codex/OpenCode.
- [ ] Swarm status distinguishes registry agents, prepared leases, running leases, active execution.
- [ ] Dashboard matches API data.
- [ ] `git status --short` is empty after commit.
- [ ] All evidence captured.

## Final Validation

- [ ] All 256 unchecked tasks checked off across 7 changes.
- [ ] `openspec validate <change> --strict` exits 0 for all 14 changes.
- [ ] `npm run test` exits 0.
- [ ] `npm run type-check` exits 0.
- [ ] `npm run lint` exits 0.
- [ ] `npm run build --workspace=@djimitflo/dashboard` exits 0.
- [ ] `git status --short` is empty.
- [ ] Proof run demonstrates nonzero output with rollback.
- [ ] No auto-merge/push/deploy/high-risk-unattended in any smoke.
