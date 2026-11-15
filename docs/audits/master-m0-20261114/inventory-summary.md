# M0: inventory of execution surfaces and value contracts (§4 + §5)

Read-only. Machine-readable companion: `m0/inventory-matrix.json`. It has 194 entries, one row for each of the 587 routes, a reconciliation section and 24 value contracts.

## 1. Scope and commits

| Item | Value |
|---|---|
| Source read | origin/main `7758d153e415177de8e977721011c9675482934c` (#1263, 2026-11-14 20:05 +0100), detached worktree |
| Built artefact | prod `/health`: `build.commit` = `built_commit` = `7758d153…`, `build_source` deploy-vps.sh, build_time 2026-11-14T19:25:26Z, `commit_matches_build` true |
| Running version | container `djimitflo-live`, server 0.5.8, booted ≈ 19:46Z (uptime 2804 s at 20:32Z). Source, built artefact and running version are the same commit. |

**Existing sources reused (nothing re-derived):**
- `scripts/route-source-inventory.mjs` and `scripts/ux-coverage.mjs` (UX-0)
- prod `usage_counts` route telemetry (S4, since 2026-09-28; `usage_loss` is empty, so 0 counts were dropped)
- `scheduler-registry.ts` `noteScheduler` call sites (39)
- `EVOLUTION_FLAGS`, `NON_EVOLUTION_FLAGS` and `unknownEnvFlags`
- `FITNESS_CONTRACTS` (#1188)
- `experimentsReport`
- `RUNTIME_ADMISSIONS` plus `decide()` and `runtimeHealth`
- `efficiencyWithCost` (30 d)
- the `LOOP_CATALOG`
- the `mcp_*` tables

The built `dist` modules ran in a readonly node probe inside the container. I removed every temp file afterwards.

**Not done:**
- I did not call `GET /api/health/schedulers`. It needs a manage:config JWT, so live in-memory tick state was not observed. Scheduler execution below is inferred from the rows each scheduler writes.
- Logs exist only since the container booted (≈ 1 h), so they cannot show tick history.

**Evidence levels:**
- CODE: read in the source.
- TEST: a test file imports the unit. This means the file exists, not that a test asserts the behaviour.
- RUNTIME: a prod row or count.
- NONE: no evidence.

## 2. Totals (with denominators)

**Routes (UX-0 + telemetry, 47 days):**
- 587 routes mounted under `/api`, in 63 router factories.
- Routes with a dashboard caller in `api.ts`: **162 of 587**. Operator routers: 162 of 558. Machine routers: 0 of 29, which is expected.
- Routes with a script, MCP or Telegram path literal: 38 of 587.
- Routes hit since 2026-09-28: **160 of 587**. Routes hit in the last 30 d: **143 of 587**.
- **Unused** (no UI caller, no script caller, 0 hits in 47 d): **338 of 587**.
- UI-called but 0 hits in 47 d: **80 of 162**.
- Router factories with 0 hits in 30 d: **18 of 63**, including apex 16, skills 15, agi 9, exports 7, runtime-governance 7, backups 6, research 6, gym 5, models 5, segml-federation 4, spawns 3 and red-team 3.
- Routes without a route-level permission literal: 78 of 587. Mount-level `requireAuth` or a machine token covers them; the inventory misses aliased `requirePermission` calls, for example in segml-federation.
- Not counted by telemetry: `/github/webhook`, `/explore/*` (7 routes), app-level `/health` and `/metrics`.

**Registered schedulers:** 39 `noteScheduler` sites.
- Armed according to prod flags: **33 of 39**.
- Off by flag (6): dead_code_lane, evolution_gym, committee_evolution, djimitsec_repository_scan, frontier_experts and retention.
- Armed with persisted output inside their expected window: **22 of 33**.
- **Armed with no persisted evidence: 11 of 33**:
  - finding_fix_lane: last output 11-07, interval 12 h
  - draft_pr_retry: last output 11-05, interval 15 min
  - commons_investigation_outcomes: last output 10-24, interval 15 min
  - shipped_code_scan: last output 10-09, interval 24 h
  - commons_falsifier: 0 rows ever
  - gym_orphan_sweep, loop_pr_ci_watch, self_healing, self_improvement_auto_review, inference_failover_probe and memory_delivery_reconcile: no table records their ticks

**Recurring units outside the scheduler registry: 29.** These include:
- **LoopDaemon**, every 5 s. It runs the maker lanes and spends 89 % of cloud tokens.
- ExternalEventIngest, the evidence room, continuous-learning, the explainer worker every 30 s, and FleetMesh every 30 s.

There are also 10 pull-driven workers or ingress points:
- remote gym, remote maker, committee, CV-001, PL-001, TG-001, web research and local shadow jobs
- host-agent poll and the social-runtime callbacks

**Flags:**
- `EVOLUTION_FLAGS` has 189 names, 136 of them acting; 142 of 189 are set in prod. `NON_EVOLUTION_FLAGS` has 95 names; 48 of 95 are set.
- Names without a non-registry reader: **0 of 284**, by mention-level grep.
- Fitness coverage: 136 acting flags, of which 105 are mapped, 31 exempt and 0 unmapped.
- Prod sets **8 flag-shaped names that no code reads** (the boot warning): `DJIMITFLO_HERMES_MODEL`, `DJIMITFLO_HERMES_PROVIDER`, `LITELLM_DEFAULT_MODEL`, `LITELLM_EXECUTION_TIMEOUT_MS`, **`LOOP_CHECKER_RUNTIME`**, **`LOOP_MAKER_RUNTIME`**, `MODEL_CANDIDATES_FRONTIER_EXPERTS` and `RUFLO_EXECUTION_TIMEOUT_MS`.

**Fitness contracts:** 49. closed_loop 6, measured_no_selection 19, unmeasured 19, circular 5.

**Experiments:** 11 registered; 7 running, 4 closed.
- **Overdue: ACE-001 and STE-001.** Every arm has reached its target and there is no verdict. STE-001 is past its 11-14 stop date.
- Closed experiments whose flag is still set: `TG_001_MODE=on`, `PL_001_MODE=on`, `MEMORY_HOLDOUT_RATE=0.3` and `EFFORT_SIBLING_RANDOMISE=true`. No attempts have run since 10-17 or 10-30, so this is config debt, not spend.
- D5-NO has n = 0 of 100 after 34 days.

**Runtime admission:** 13 ledger entries. CONDITIONAL 1 (djimitsec, expires 2026-11-27, in 12 d), LEGACY_ADMITTED 11 (all expire 2026-12-31), REJECT 1 (openhuman).
- 10 runtimes appear in probes or leases with no entry (UNKNOWN_RUNTIME).
- `manual` is one of them and carries most leases: 363 leases in 30 d per `runtimeHealth`, and 2,500+ PR-review checker leases.
- Leases in 30 d:
  - opencode: 489 leases, 0.73 success
  - remote: 64 leases, 0.34 success
  - claude: 17 leases, 4 completed
  - codex: 5 leases, 0 completed

**Loop catalog:** **2 of 7** declared loops were ever instantiated in `loop_runs`. Of those, `repo-maintenance-loop` appears only as the label of the GitHub PR-review runs (1286 in 30 d, dry run, manual leases). 6 loop names that are not in the catalog appear in `loop_runs` (evolution-gym, cv-001, pl-001, tg-001, research-loop, legacy-evidence-recovery).

**MCP:** 10 servers.
- 6 show `status=running`, but their `last_ping_at` is 2026-10-23. That status is 22 days stale.
- 4 are stopped: three are known unreachable, and djimitkb-mcp is blocked by `OUTBOUND_DENY_HOSTS`.
- 148 tools, all 148 with a permission row.
- The djimitflo-runtime catalog has 56 tools (synced 2026-10-01) against 61 `registerTool` call sites in the source.
- No server-side record of MCP calls exists.

**Spend in 30 d (`efficiencyWithCost`):**
- Cloud tokens 144.5M: maker:opencode 128.9M (89.2 %), checkers 12.4M, maker:codex 1.05M, jev 0.90M, content_safety 0.49M, evolution_gym 0.31M, panel_review 0.21M.
- Local GPU: the gym used 545,697 GPU-s (151.6 h, 30.4 kWh, 1079 jobs), remote maker 41,203 s (2.0 kWh), committee 4,236 s.
- The workstation wall meter shows 51.1 kWh.
- Not metered: OpenMythos nightly GPU, and self-improvement auto-review tokens (gemma4:31b:cloud, absent from `llm_model_calls`).

## 3. Per-claim table

| id | claim | status | evidence level | evidence | uncertainty |
|---|---|---|---|---|---|
| INV-1 | UX-0 route coverage is the reusable route source of truth | BEVESTIGD | CODE+RUNTIME | ux-coverage on 7758d153: 587 routes, 162 UI-called, 25 unresolved dynamic calls; joined with usage_counts | api.ts `this.request` only; direct fetch is not counted (only auth-store.ts uses it) |
| INV-2 | The scheduler registry shows all recurring work | GEWIJZIGD (incomplete) | CODE | 39 registered against 29 unregistered units (LoopDaemon `services/loop-daemon.ts:529`, ingest `external-event-ingest-service.ts:306`, evidence room `commons-evidence-room.ts:243`, …) | in-memory registry not read (needs JWT) |
| INV-3 | Registered and armed means ticking | NIET VERIFIEERBAAR for 11 of 33 | RUNTIME (absence) | no persisted row in the expected window (list in §2) | ticks are in memory and reset each deploy; "no row" can also mean no input |
| INV-4 | Every registered flag has a reader | BEVESTIGD | CODE | 0 of 284 names without a non-registry reader; `fitness-contracts` coverage has 0 unmapped | mention-level grep, not semantic |
| INV-5 | No unread flags are set in prod | GEWIJZIGD (8 set, unread) | RUNTIME | boot log and `unknownEnvFlags`: `LOOP_MAKER_RUNTIME` and `LOOP_CHECKER_RUNTIME` among them | — |
| INV-6 | Experiments stop when they are closed | GEWIJZIGD | RUNTIME | no TG attempts after 10-17, no PL after 10-30, but 4 flags still on; ACE and STE overdue | whether code ignores a closed flag was not traced for every experiment |
| INV-7 | The roborev → Djimitflo intake (AGENTS.md) is active | NIET VERIFIEERBAAR / never observed | RUNTIME | 0 roborev events in `external_events` (15,456 rows) and 0 work_items with source roborev | the shipper may still be in dry run (roborev side out of scope) |
| INV-8 | The 7 catalog loops run | GEWIJZIGD (2 of 7 run) | RUNTIME | `loop_runs` (5160 rows): only doc-drift and repo-maintenance; repo-maintenance means PR review | — |
| INV-9 | Runtime admission covers the runtimes that execute | GEWIJZIGD | RUNTIME | `manual` (most leases) is UNKNOWN_RUNTIME; 11 legacy admissions expire on 12-31 at once | `manual` may be exempt by design (no executor) |
| INV-10 | MCP catalog status reflects reality | GEWIJZIGD (stale) | RUNTIME | 6 servers "running" with a 22-day-old ping | — |

## 4. Reconciliation: declared vs observed

- **Unused routes:** 338 of 587. The full list is in `reconciliation.unused_routes`.
- **UI routes nobody used:** 80 of 162.
- **Off-by-flag lanes that machines still poll:**
  - `/api/gym-worker/committee/claim`: 6331 polls in 30 d, and committee has been off since 10-19.
  - `/api/gym-worker/maker/claim`: 6413 polls; the last remote maker job was on 11-06.
  - `/api/host-agent/shadow/claim` has had 0 hits since 09-30, while 6 jobs are still queued.
- **Dead code (CODE, with RUNTIME corroboration):**
  1. `ReconciliationService.start()` is never called (`services/reconciliation-service.ts:341`; only constructed at `routes/self-improvement.ts:39`). `reconciliation_runs` has 0 rows.
  2. `bootstrap/recovery.ts` is never imported. `recoverInterruptedOpenMythosRuns` is dead, and 4 `openmythos_eval_runs` rows are stuck `running`, the oldest since 2026-09-13.
  3. SEGML: 408 of 408 cycles failed (last 09-23, "No evaluation run found"). 16 of 17 `segml_*` tables are empty.
  4. The FleetMesh 30 s heartbeat runs over `fleet_nodes`, which has 0 rows.
  5. 5 of 7 catalog loops have never run.
  6. 18 router factories have 0 hits.
- **Silent fallbacks and sinks:**
  - **Evidence room:** 1369 Commons questions in 30 d. 1348 expired, 21 are pending and 0 were answered, because the residents are off (`SOCIAL_AUTOPILOT_RUNTIME=off`).
  - **Discovery backlog:** 4032 rows unjudged, 0 ever judged, while ingest adds about 3568 discovery events a month (`DISCOVERY_RELEVANCE_PAUSED=true`, frontier scheduler off).
  - **Stale MCP status:** the stored "running" status is shown as live.
  - **Ingest poll errors** go only to `console.warn` (one timeout at boot), with no counter.
  - **Shared review model:** review and refinement both use gemma4:31b:cloud (boot warning), so the review is not independent.
  - **Explainer worker** polls every 30 s with no author LLM configured, and 1 job has been stuck `running` since 09-23.
  - **Queue hygiene misses** the 4 OpenMythos runs, 1 explainer job, 6 local shadow jobs, 8 `prepared` leases and 3 `ready_for_human_merge` loop runs.
  - **Webhook conclusion:** `github_webhook_deliveries.result_json.conclusion` is null for 1261 of 1261 deliveries.
  - **Login churn:** `POST /api/auth/login` was called 5320 times in 30 d. 4277 come from `node@100.86.47.122`, a machine client logging in about every 10 min (only 53 refreshes).
  - **Retention is off** with a 744 MB DB.
  - **Latent auth fallback:** 44 of 65 route factories fall back to a no-op `requirePermission` when `auth` is undefined. `createRoutes` throws `AUTH_MIDDLEWARE_REQUIRED` (`routes/index.ts:93`), so prod mounts are guarded. This is latent only (CODE).
  - **Dependency lane** in `act` mode has merged 0 of 38 PRs.

## 5. Value contracts (§5). Proposals only; nothing was changed.

| Loop / lane | Value type | Baseline → observation (30 d) | Budget | Stop rule | Proposal |
|---|---|---|---|---|---|
| Maker lanes (doc-drift: test_gap, exports, mutation_gap, finding_fix) | direct result | 226 terminal: 122 verified (54 %), 64 regressed, 32 infra; 81 auto-merged; 0.67 verified per M tokens (wk 11-07); ≥ 1.22M tokens per verified task | opencode 128.9M + checkers 12.4M | none per lane (auto-merge revoke only) | **keep + improve**: record the lane on goals (`metadata.lane` null on 1516 of 1516) and register LoopDaemon |
| checker / security_checker | maintenance-risk | 135 + 131 executions; F2 at 57/46 of 93 | 12.4M | F2 stop 01-15 | **keep** (security_checker is unmeasured) |
| Remote gym (workstation) | bounded knowledge | 1079 runs, 30.4 kWh; genomes 1 active / 3 trial / 18 retired; 15 trial results all-time | GPU, cap 72/day (≈ 40/day used) | per-genome McNemar | **improve**: measure decisions per kWh before resizing |
| CV-001 | bounded knowledge | 23 of 120 pairs, projected 136 | GPU (quiet window) | 12-08, 4-rule | **keep to readout** |
| ACE-001 / STE-001 | bounded knowledge | arms at target, no verdict | maker tokens | stop_by reached | **read out now** (frees WIP) |
| PL / TG / X1 / memory-holdout | — | closed, flags still on | 0 | fired | **retire flags** |
| D5-NO | bounded knowledge | 0 of 100 in 34 d | jev | 01-09 | **improve or close INCONCLUSIVE** |
| Committee swarm | bounded knowledge | off since 10-19; 0 of 20 forecasters decision-grade | GPU | n≥30 & skill<0 | **retire / keep off; stop the worker's committee polling** |
| Residents + evidence room | bounded knowledge | residents off since 10-08; evidence room 98.5 % expired | Ollama | arenaGate | **pause evidence room** (or merge into digest) |
| Specialist panels | direct result | 237 panels, 179 goals; circular | 214k + 194k tokens | none | **improve**: compare verified rate of panel goals vs panel-skipped oracle-lane goals |
| Shadow judgments that spend tokens (checker_second_opinion 485k, failure_cause 265k, decision_context 194k, risk_atomic 190k, prescreen 153k) | bounded knowledge | unmeasured or circular, decision_rule null | Ollama / jev | none | **pause** risk_atomic, failure_cause and decision_context; keep prescreen under D5-NO |
| Content safety | maintenance-risk | 833 calls, enforce | NVIDIA, 499k tokens | 4/min | **keep** |
| Discovery / frontier experts | bounded knowledge | 4032 unjudged; frontier off | 0 now | fleetSourceGate (needs judged rows) | **pause discovery ingest or retire the backlog** |
| Web research | — | off, 0 claims | 0 | — | **keep off** |
| Benchmarks | bounded knowledge | 4 runs all-time; F1 13 d overdue | operator runner | — | **improve** (notice without execution) |
| Settlement execution | maintenance-risk | 110 shadow judgments, 0 tokens | VPS CPU | — | **keep** |
| Dream evolution / dream state | bounded / maintenance | 5 LLM calls; 100 ledger rows | small | McNemar | **keep** |
| OpenMythos nightly | bounded knowledge | 90 runs, average score 2.29; no consumer; GPU unmetered; 4 stuck | workstation GPU | none | **pause / retire unless a consumer is named** |
| GitHub PR review | maintenance-risk | 1288 reviews, 0 tokens | CPU | — | **keep; rename the loop label** |
| Dependency lane (act) | maintenance-risk | 0 of 38 merged | GitHub API | red CI revokes | **improve or pause** |
| Continuous learning / meta-tuning / curiosity | bounded knowledge | 0 patterns and 0 proposals in 817 cycles; meta-tuning applied 0 and silent since 11-05; curiosity silent since 09-08 | CPU | none | **merge / retire** |
| Content drafts | direct result | 7 generations, 12k tokens | Ollama | — | **keep (shadow)** |
| Self-improvement auto-review | maintenance-risk | tokens unmetered; same model as refinement | gemma4 cloud | — | **improve** |

## 6. Confirmed defects: smallest fix, a test that fails today, risk, and whether it blocks M1

1. **29 recurring units outside the scheduler registry, including LoopDaemon and ExternalEventIngest.**
   - Fix: wrap their starts in `noteScheduler` + `guardTick`, in `bootstrap/autonomous-services.ts`, `index.ts` and `bootstrap/operator-services.ts`.
   - Test: boot with flags on, then assert that `listSchedulers()` contains `loop_daemon`, `external_event_ingest` and `commons_evidence_room`.
   - Risk: low (the registry passes the armed state through unchanged).
   - **Blocks M1 if M1 uses `/schedulers` as execution truth.**
2. **`bootstrap/recovery.ts` is dead, and 4 OpenMythos runs are stuck `running`.**
   - Fix: call `recoverInterruptedOpenMythosRuns(db)` in the `index.ts` boot path, or fold it into the existing recovery.
   - Test: seed a `running` eval row, init the server, and expect it marked interrupted.
   - Risk: low. Does not block.
3. **`ReconciliationService.start()` is never called.**
   - Fix: either wire it with `noteScheduler('reconciliation_nightly', …)`, or delete `start()` and the 2 flags.
   - Test: with `RECONCILIATION_NIGHTLY_ENABLED=true`, the registry contains it.
   - Risk: low. Does not block.
4. **The evidence room emits to an absent consumer (1348 of 1369 expired).**
   - Fix: skip the sweep when `SOCIAL_AUTOPILOT_RUNTIME=off`, or set `COMMONS_EVIDENCE_ROOM_MODE=off`.
   - Test: runtime off, then the sweep posts 0 messages.
   - Risk: low. Does not block.
5. **The stale MCP status is shown as running.**
   - Fix: derive the shown status from the age of `last_ping_at`.
   - Test: a 22-day-old ping lists as `stale`.
   - Risk: low. Does not block.
6. **Discovery backlog growth while judging is paused.**
   - Fix: don't enqueue, or cap the backlog, when `DISCOVERY_RELEVANCE_PAUSED=true`.
   - Test: paused, then ingesting a discovery adds 0 backlog rows.
   - Risk: low. Does not block.
7. **Queue hygiene gaps** (OpenMythos running, explainer running, local shadow queued, prepared leases).
   - Fix: add TTL clauses in `queue-hygiene-service.ts`.
   - Test: a stuck row older than its TTL gets expired.
   - Risk: medium (it touches leases). Does not block.

Config-only items for the operator, with no code:
- unset the 8 unread flags
- unset the 4 closed-experiment flags
- read out ACE-001 and STE-001
- run the F1 benchmark (due 11-01)
- re-assess djimitsec admission before 11-27, and the 11 legacy admissions before 12-31

## 7. Open questions

- Is the goal lane (test_gap / exports / mutation_gap / finding_fix) stored somewhere other than `goals.metadata.lane`? Without it, per-lane value contracts cannot be computed.
- Why has the dependency lane merged 0 of 38 PRs in `act` mode? The decisions are mostly rebase_requested or wait_checks.
- Which machine client logs in about 140 times a day from the VPS (`node` user agent)?
- For the 11 armed schedulers without persisted evidence: is there no input, or no tick? Answer with one authorised `GET /api/health/schedulers`.
- Which field holds the GitHub webhook conclusion, given that `result_json.conclusion` is always null?
- Should `manual` and the 9 other probed runtimes have admission entries, or be explicitly exempt?
