# Ecosystem bottlenecks, ranked P0–P5 (origin/main 7072c94b, 20-10)

Every claim cites `file:line` on origin/main (paths under `packages/server/src/` unless otherwise noted) or a prod number.

Prod sources:
- **A**: align.json, 30 d to 19-10
- **V**: value-snapshot.json, 7 d
- **P**: ecosystem-prod.json, 30 d to 20-10
- **U**: unit-economics.md

**Code-verified by me** means I read the lines myself. The other code items come from four read-only inventories and are marked *(inv)*. UNKNOWN stays UNKNOWN.

Reading of the whole: the system has one verified capability. Oracle test lanes give 105 verified in 30 d (A) and 22/26 settled survivors (A). Everything else either has no independent oracle or its evidence can be self-asserted. The P0 list is mostly trust-boundary and provenance defects that would corrupt the G-phase scorecard (fleet value, allocator, survival) before it is read.

---

## P0: security, provenance, correctness defects

| # | Defect | Evidence | Exploit / impact | Prod exposure |
|---|---|---|---|---|
| P0-1 | **Federation: any logged-in user can exfiltrate any server env var.** `POST /federation/register` takes an arbitrary `url`, `trust_level` and `metadata`. `POST /federation/work` then sends `Authorization: Bearer ${process.env[metadata.auth_token_env]}` to that URL. | `routes/federation.ts:110-127`, `:184-191`; mounted with `requireAuth` only, `routes/index.ts:152` (code-verified). `requireAuth` accepts any active user JWT, any role (`middleware/auth.ts:27-53`). `/inbox/work` also lets any login start a `repo-maintenance-loop` run (`federation.ts:147-166`). | Any viewer, or any service account holding a user JWT (agent-gym bridge, MCP tokens), can do this. Example: register `https://attacker`, set `auth_token_env: "GITHUB_TOKEN"` or `"JWT_SECRET"`, then POST `/work`, and the secret leaves the server. The outbound guard only blocks the hosts in its deny list (`utils/outbound-guard.ts:11-47`). SECURITY_REVIEW K1 recorded "register login-only" as open; the env-var naming makes it a secret leak. Tests cover only the happy path (`__tests__/federation-routes.test.ts:17-89`). | Number of non-admin users or JWT holders in prod: UNKNOWN. The code path is live on main. |
| P0-2 | **MCP `okf_get` path traversal.** | `packages/mcp-server/src/tools/okf.ts:161` builds the path with `path.join(baseDir, conceptPath)` and no containment check, then reads it at `:170` with `readFileSync` (code-verified). OKF tools have no per-tool permission check *(inv)*. | Any MCP-authenticated principal can read `../../runtime.env`, the DB, keys, and so on. | Whether the MCP HTTP transport is exposed in prod: UNKNOWN. This session lists `okf_get`, so it is reachable by operator sessions. |
| P0-3 | **Fleet outcomes are forgeable and self-asserted.** The bus read carries no auth and events are unsigned. `success` is whatever the caller passes. | Read: `services/external-event-ingest-service.ts:142` (code-verified). Schema: `:27-36`. Writer: `:38-56`, which uses `success: o.data.success`. Emitter: `scripts/emit-agent-outcome.py:15,42` *(inv)*. | Anyone who can publish to the bus writes `skill_outcomes` domain=fleet. Those rows feed scorecards (`scorecards.ts:11`) and the value allocator. Phase G5.1 needs value-linked fleet outcomes, and this path cannot carry that. | 113/113 fleet successes over the top-8 skills in 30 d (A): 100 % success with zero verification. |
| P0-4 | **Manual reviewer attestation is not bound to the caller.** | The checker and security verdict routes need only `create:task` (`routes/loops.ts:306,318`, code-verified). The gate passes on any non-empty `reviewer` and `reason` string (`loop-verification-service.ts:287-291`, code-verified). `reviewer` comes from the request body and is not compared with `req.user` (`loop-service.ts:1009-1018,1067-1077`, *(inv)*). | A principal with `create:task` (the maker role) can pass `checker_verdict` and `security_checker_verdict` in any name. | Manual checker leases: 1 264, 929 completed (P). The share submitted through this route vs the PR-review stub is UNKNOWN. |
| P0-5 | **The PR-review heuristic is recorded as human attestation, and its green status counts for auto-merge.** | `services/github-pr-review-service.ts:171-174` writes `manual_attestation {reviewer:'roborev-webhook'}`. Accepted becomes Commit Status success at `:362-370`. `loop-auto-merge.ts:56-62` counts statuses toward green *(inv)*. | Review provenance is falsified: a heuristic presents as a human. It also inflates "valid reviewer verdicts" (`cost-ledger.ts:136`). | About 929 synthetic pairs in 30 d (P). |
| P0-6 | **Auto-merge does not bind the verified commit.** | `loop-auto-merge.ts:143,164` merges the PR head sha read at tick time. The draft PR stores no head sha (`loop-draft-pr-service.ts:112`) *(inv)*. | A push after verification is merged as long as the diff stays test-only. Settlement then credits a commit nobody verified. | Auto-merged share of the 66 merges (U): UNKNOWN. |
| P0-7 | **Lease runtime provenance is lost on engine fallback.** | `execution/execution-engine.ts:615-619` (circuit-open, no fallback event), `:718-724`, `:783-790`; `services/fallback-chain-service.ts:58-60` sends unlisted runtimes (remote, atomic, opencode) to the chain head, which is claude *(inv)*. `worker_leases.runtime` is never rewritten. | Bandit, skill_outcomes and the allocator attribute work to the requested runtime, not the one that ran. That corrupts the bandit (G1.3) and allocator inputs. | UNKNOWN. No event is recorded on the circuit-open path. The Claude maker figure (13 leases, 23.06M tokens, 0 ok; V) could not be separated from fallbacks. |
| P0-8 | **The daemon pass rule contradicts certification and attribution.** | `loop-daemon.ts:849` requires every gate to be `pass` (code-verified). A non-high-risk run's security gate is `skipped` (`loop-verification-service.ts:123-124`, code-verified). `certifyLoopRun` tolerates `skipped` (`:215-217`, code-verified). Attribution receives only fail/unknown gates (`loop-daemon.ts:875`), so it writes a `verified` credit. | The same run is `failed`/`regressed` in goal, skill_outcomes and bandit, but `verified` in outcome_credits, which feeds the value allocator. Non-high-risk lane runs can never be verified by the daemon. | Security leases (148) are nearly as many as checker leases (155) (P), so most lane runs are high-risk and the defect hits the remainder. Exact count: UNKNOWN. Query: `skill_outcomes WHERE evidence_refs_json LIKE '%security_checker_verdict:skipped%'`. |
| P0-9 | **The memory human gate accepts any `approved_by` string.** | `services/memory-candidate-service.ts:224`: `human_required && !human_approved && !approved_by` (code-verified). Machine callers pass `approved_by:'proof-run-service'` / `'memory_curator'` (`proof-run-service.ts:480,816,837,863,1253`) *(inv)*. | A "human required" rule can be promoted with no human. Those rules are injected into every maker prompt (`assignment-context.ts:78-101`). | 175 promoted, 850 reads in 30 d (A). Machine-promoted share: UNKNOWN. |
| P0-10 | **Task sandbox metadata is unvalidated: possible host bind-mounts and host networking.** | `execution/execution-engine.ts:628-640` copies `task.metadata.sandbox.{image,networkMode,bindMounts}` into `DockerSandboxExecutor` (code-verified). `routes/tasks.ts:141-166` reserves only `environment` (code-verified). | A `create:task` caller could run its executor with `-v /:/host:rw --network host`. | Docker CLI or socket in the prod container: UNKNOWN. Whether risk or approval stops it before execute: UNKNOWN. Latent until both are checked. |
| P0-11 | **Shadow judgments act, and the allocator measures "consumption" by label.** | KB ingest deletes or skips pages on `unsafe` even in shadow mode (`kb-corpus.ts:39-41`). Commons `threadGated` acts on shadow rows (`agent-social-autopilot-service.ts:387-396`). content_safety rows are always labelled `shadow`, even under enforce (`content-safety.ts:59-60`). The allocator counts `mode='enforce'` as consumed (`value-allocator.ts:124-125`). All *(inv)*. | The G0.1 allocator table will classify consumers wrongly: audit rows such as `telegram_access` (176/30 d, P) count as "consumed", and judgments that really act count as NO_CONSUMER. That is the plan's own falsifier ("table wrong on a known case → fix before trusting"). | The allocator flag goes live at the next recreate. |
| P0-12 | **The gym verdict is reported by the worker, and hack flags do not gate.** | `remote-gym-service.ts:234-246` accepts the worker's status without re-running anything. `gym-hack-classifier.ts:9` is shadow, and nothing in `dream-evolution.ts` or `genome-promotion.ts` reads `hack_flags`. Canaries are 0 by default and opt-in by the worker (`:50-64`). All *(inv)*. | Genome selection could promote on self-reported or hacked wins. | Dormant: `DREAM_EVOLUTION_ENABLED=false`, 0 promotions (A). This becomes live P0 at plan step G3.4, "evolution restart". |

Further P0-class items, lower blast radius *(inv)*:
- MCP catalog sync overwrites operator tool-permission decisions, and its regex marks `notebook_delete` as allowed (`packages/mcp-server/src/tools/governance.ts:123-169,350-384,476-510`).
- Lease claim is non-atomic check-then-set (`loop-worker-lease-repo.ts:91`; `loop-worker-executor-service.ts:113,156`).
- The codex `--dangerously-bypass-approvals-and-sandbox` flag can void a reviewer's read-only sandbox (`execution/executors/codex-executor.ts:210-215`).
- The event outbox payload can override `event_id` and `source` (`event-outbox-service.ts:56`).
- `djimit/loop-engineering` opens the djimitflo sqlite directly with its own `loop_runs` DDL (`tools/config.py:14`).

## P1: broken integrations that block verified outcomes

| # | Bottleneck | Evidence |
|---|---|---|
| P1-1 | **Only one verifier family exists. LLM-originated work almost never verifies.** | 30 d (A): gap_analysis 105/329 verified. Reflection 1/416, refinement 0/307, feedback 0/32. 99 % of verified work comes from oracle lanes (plan Phase G). |
| P1-2 | **Three of five maker runtimes produce nothing.** | 30 d (P): claude 0/13 (fixed by #898, no post-fix data), codex 0/5 (sandbox flags, `codex-executor.ts:210-215`), atomic 0/16. In the gym (V), claude 0/10 and codex 0/5. #905, the alarm that would catch this, is unmerged. |
| P1-3 | **The second repo is blocked by discovery shape.** | `test-gap-source-service.ts:108` is the only extra-repo discovery: node:test only (since #899), no vitest (second-repo-pilot.md). No repo is live (G1.1 needs an operator token). |
| P1-4 | **The finding-fix lane is not on main.** | #909 is open. roborev supply is 0 `review_fix` events (finding-fix-lane-design.md §1). The three roborev JSONL readers return `[]` in prod (`roborev-findings-service.ts:14-45`, `bootstrap/operator-services.ts:14`, `dennis-agent-service.ts:887`) *(inv)*. |
| P1-5 | **Manual security_checker is a dead path (257/0, P).** | Created for high-risk runs (`loop-lifecycle-service.ts:96-103,219-226`, `loop-daemon.ts:779-789`). Dispatched only when `LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED` is set and the bounded strategy finds a decisive checker (`loop-daemon.ts:822-832`). Otherwise it is swept without a reason by hygiene, self-healing or evolve-loser cancels (`queue-hygiene-service.ts:128-130`, `self-healing-service.ts:228-232`, `evolve-selection.ts:113-126`). The gate then fails the run (`loop-verification-service.ts:121-131`). PR review creates none. Split per cancel site: UNKNOWN. |
| P1-6 | **Self-healing can kill live remote makers.** | `self-healing-service.ts:228-232` cancels running leases idle for more than 1 h, sends no stop and records no reason. Remote maker latency averages 892 s, and the queue timeout is 45 min (`remote-maker-queue.ts:11`) *(inv)*. 30 d remote maker: 147 leases, 66 completed (P). Share killed this way: UNKNOWN. |
| P1-7 | **The gym does not transfer to production.** | Gym 78.8 % vs prod 7.0 % for the same species (CODEX_REPORT §5). Gym attempts have no harness hash or lease id (`remote-gym-service.ts:242-246`) *(inv)*. |
| P1-8 | **Commons and Frontier produce nothing verified.** | 0 verified from Commons. Residents are off. Frontier has 4 401 papers, 138 repos and 2 265 claims (A), yet 0 proposals cite knowledge (CODEX_REPORT). Fleet discovery yield is 0/105 for hermes-macmini and 0/16 for hermes-eve-v (`expert-source-units-service.ts:30`) *(inv)*. |

## P2: evidence and settlement bottlenecks

| # | Bottleneck | Evidence |
|---|---|---|
| P2-1 | **Settlement volume and integrity.** | 26 merge outcomes (A) against 66 merged (U). Merge survival is not atomic (`merge-survival.ts:289` vs `:297`), stores no merge sha, uses a line-presence heuristic (`:276-277`), and fetches unpaginated (`:259-261`) *(inv)*. |
| P2-2 | **Most judgment volume has no reader.** | 18 570 / 19 342 judgments in 30 d are shadow (96 %, A). No decision consumer for `checker_second_opinion`, `risk_atomic`, `failure_cause`, `commons_idea` or `value_allocation` *(inv)*. content_safety alone is 6 092 shadow rows (P). |
| P2-3 | **Token and cost evidence has holes.** | Lease usage reported on 177/289 and 263/428 (U). `tok_unknown` covers 38/76 opencode maker leases and every checker lease (V). `frontier_experts` rows show 0 tokens (V; the `model-selector.ts:195-198` rows carry no provider or tokens). `list_price_cost` is NULL everywhere (U). Council tokens are estimated (`council-orchestrator.ts:284`). |
| P2-4 | **Learning loops: 0/11 closed.** | #907 (learning ledger) is unmerged. 9 experiments share about 4.5 oracle goals per day. ACE-001 delivered its treatment in 2/11 slots (CODEX_REPORT). The experiment registry does not check that flags are on (`experiment-registry.ts:41-99`), and a second list exists (`evolution-feedback.ts:41-43`) *(inv)*. |
| P2-5 | **Memory and knowledge are unproven.** | 175 rules promoted, 850 reads (A). Memory holdout F3 trends against. Memory-rule fitness has no baseline (FITNESS_AUDIT #2). KB is cited in 44/52 panels with decisions unchanged (F4). |
| P2-6 | **Earned autonomy counts pending as neutral.** | `earned-autonomy.ts:55-60` *(inv)*: a class can be "earned" with 0 verified outcomes. |
| P2-7 | **Silent failure on learning writes.** | `loop-daemon.ts:916` (`catch {}` around skill_outcomes). `outcome-attribution.ts:182-190` (check-then-insert, swallowed). `dream-evolution.ts:684-708` (fail-soft). `model-selector.ts:77` (ledger swallowed). |
| P2-8 | **The deploy verdict fails open.** | `scripts/auto-deploy.sh:38` (restarts default 0), `:48-57` (an empty stalls probe reads as ok) *(inv)*. |

## P3: selection and delegation

| # | Bottleneck | Evidence |
|---|---|---|
| P3-1 | **No capability-based selection exists.** | The lane is fixed and the bandit picks only the runtime (`runtime-bandit.ts:35-53`). `swarm_capabilities` has 510 rows, never validated (P; `integration-inbox-service.ts:176-183`). `agent_skills` has 0 rows (P). There are three agent registries (agents, registry_agents, OKF). Per PHASE_PLAN this stays DEFER until a router picks between two or more measured capabilities. |
| P3-2 | **Bandit inputs are biased.** | Stats are keyed on lease runtime (see P0-7). Outage-fallback outcomes are not excluded (`runtime-bandit.ts:41-43`) *(inv)*. Effect: NOT_MEASURED. |
| P3-3 | **The model selector is a proxy, and its shadow sampling costs latency.** | Agreement ≠ correctness (FITNESS_AUDIT #12). Shadow calls are awaited inline (`model-selector.ts:209`; panel `self-improvement-agent-review-service.ts:330`). The selector is duplicated in the panel service (`:319-332`) *(inv)*. |
| P3-4 | **Failover crosses trust boundaries silently.** | `llm-fallback.ts:114-118` fails over to an OpenAI-compatible third party on any error. The Ollama auto-failover probe host (`inference-failover.ts:139`) differs from the LAN host used by panel and council (`self-improvement-agent-review-service.ts:121`) *(inv)*. |
| P3-5 | **Three ExecutionEngine instances.** | `index.ts:221`, `bootstrap/core-services.ts:48`, and lazy in `loop-worker-executor-service.ts:494`. Circuit-breaker state is not shared *(inv)*. |
| P3-6 | **Delegation is mostly off or unmeasured.** | Nested spawn is off by default (`nested-spawn-service.ts:137`, `SPAWN_DEPTH_BUDGET=0`). The prod probe used a nonexistent table name; the real tables are `sub_agent_spawns`/`spawn_trees` (`database/migrate.ts:689-722`). X1 siblings interim result is 0/3 vs 8/11, n 15 (AGENT_SWARM_EVALUATION). |
| P3-7 | **Committee off, arena side effects.** | `evolveCommittee` still runs hourly (`bootstrap/autonomous-services.ts:255`). `fleetSourceGate` acts with no flag (`committee-swarm.ts:291`). The arena gate can retire residents for lack of questions (`:249,277-279`) *(inv)*. |
| P3-8 | **Liveness is not used where selection happens.** | `agents.status` never decays (P: 32/32 `active`). Resident selection reads it (`agent-social-autopilot-service.ts:228`, `agent-lure-service.ts:46`) *(inv)*. |

## P4: new specialist review configurations (candidates, each with an oracle)

1. **security_checker discrimination test**, F1-style, using planted vulnerabilities. Today it costs 14.6M tokens per 7 d with no measured discrimination (AGENT_SWARM_EVALUATION).
2. **Finding-fix reviewer.** The oracle is a scanner re-run plus anti-gaming rules: no rule disabling, no suppression comments, no test deletion (#909 design). security-review-commons serves as a regression-only gate because of its ~86 % false-positive rate (finding-fix-lane-design.md §2a).
3. **Per-repo check profile** for extra repos (`EXTRA_REPO_CHECKS_<SLUG>`), with branch-protection preconditions (second-repo-pilot.md).
4. **PR-review Phase 2 (LLM)** replaces the stub only after P0-5 is fixed, with the verdict bound to a model and lease, not to "human".
5. **Cross-family checker (F2)**: keep running to its target of 93 per arm before any default change.

## P5: new architecture (only after P0–P2)

- **Signed, authenticated event bus.** Producer keys and a per-event signature replace the self-claimed `source`. The deep-agent fabric's signed contracts (`execution/executors/deep-agent-executor.ts:56-97`) are the in-house pattern to reuse.
- **End-to-end commit-sha provenance**: maker diff hash → check results → reviewed sha → merged sha → survival.
- **Capability contract and registry**: only when a router has two or more measured alternatives (PHASE_PLAN DEFER trigger).
- **Multi-tenant isolation** before external repos (G4.2). Canary deploy: DEFER, since there is a single instance.

---

## Top 5 (cross-priority, by expected effect on verified, surviving outcomes)

1. **P0-1 federation env-var exfiltration**: the only finding that leaks secrets; fix before anything else.
2. **P0-3 / P0-5 / P0-6 provenance of outcomes**: forgeable fleet success, the PR-review stub posing as a human, and auto-merge not binding the verified sha. All three feed the G-phase scorecard.
3. **P0-8 + P0-11 learning signals disagree**: the daemon says failed while attribution says verified, and the allocator measures consumption by label. Fix these before reading the allocator table (G0.1).
4. **P1-1 / P1-3 / P1-4 verifier and supply starvation**: one verifier family on one repo. LLM-originated proposals are 1/755 verified (A). The finding-fix lane and the second repo are the only near-term additions.
5. **P1-2 + P0-7 runtime yield and attribution**: claude, codex and atomic are 0/34 in prod, and engine fallback hides which runtime actually ran.
