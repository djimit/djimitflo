# Integration coverage: Djimitflo ecosystem paths (origin/main 7072c94b, 20-10)

Read-only. Code: `git show origin/main` (paths under `packages/server/src/` unless they say otherwise). Prod numbers come from
the parent's snapshots:
- **A** = align.json (30 d to 19-10)
- **V** = value-snapshot.json (7 d to 19-10)
- **P** = ecosystem-prod.json (30 d to 20-10)
- **U** = unit-economics.md (30 d to 17-10)

The node ids in brackets refer to `capability-graph.json`.

Each transition is graded on six columns:
- **Exists**: there is code on main.
- **Prod**: prod rows show it ran.
- **Indep**: an independent outcome measure exists for it.
- **Silent**: it can fail without a signal.
- **Prov**: it preserves provenance (commit sha, lease id, hash).
- **Idem**: recovery is idempotent (a unique key or dedupe).

Cell values are Y, N, P (partial) or ? (UNKNOWN).

---

## 1. Oracle test lanes (test-gap / exports / mutation), run by `doc-drift-and-small-fix-loop`

The only path with a VERIFIED end-to-end outcome. In 30 d, gap_analysis produced 329 proposals and 105 of them were verified (A). 66 were merged (U). Merge survival stands at 22/26 settled-survived (A `merge`).

| Transition | Where | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|---|
| TASK | `test-gap-source-service.ts:108` creates gap proposals; the self-improvement funnel takes them in | Y | Y (329/30 d) | – | N | P (file + command) | P (proposal dedupe 0.92, `proposal-dedupe.ts:16-31`) |
| CAPABILITY SELECTION | loop name is fixed per lane. No capability registry is consulted: `swarm_capabilities` is not read here, and `agent_skills` has 0 rows (P) | P | Y | N | – | – | – |
| AGENT ASSIGNMENT | runtime bandit `loop-daemon.ts:595-611` → `runtime-bandit.ts:35-53`; leases are created at `loop-lifecycle-service.ts:73-104` | Y | Y (opencode 316, remote 147 maker leases, P) | N (bandit effect NOT_MEASURED; #907 unmerged) | P (`bandit_skipped` event; a missing table returns null silently, `:44`) | **N**: an engine fallback switches runtime without rewriting `worker_leases.runtime` (`execution-engine.ts:615-619,718-790`) | **N**: no UNIQUE(run, finding, role); the claim is check-then-set (`loop-worker-lease-repo.ts:91`) |
| DELEGATION | evolve siblings / X1 (`loop-daemon.ts:690-741`); remote queue (`remote-maker-queue.ts`); nested spawn is off (`SPAWN_DEPTH_BUDGET=0`) | Y | Y (X1 randomised) | P (X1 arm, n small) | Y (retry-maker failure swallowed, `loop-daemon.ts:668`) | P (remote: only the requested species is recorded; the host reports what it ran) | P |
| EXECUTION | `execution-engine.ts:320` (admission) and adapters | Y | Y | – | P (admission shadow allows; a missing version probe allows, `runtime-admission.ts:104-106`) | P | ? |
| EVIDENCE | `runDeterministicChecks` `loop-service.ts:1095-1189` | Y | Y | Y (executed tests) | N (a missing script fails; zero passing checks fails) | **P**: stdout paths are kept, but no worktree HEAD or diff hash travels with the check result | Y |
| VERIFICATION | `loop-verification-service.ts:49-208`; LLM checker; security checker on high-risk runs | Y | Y (checker opencode 155/133, security 148/134, P) | Y for the checker (F1 AUC 0.875 offline); N for security (no discrimination test) | N for missing evidence. However, **daemon `allGatesPass` (`loop-daemon.ts:849`) needs every gate to be `pass`, and a non-high-risk run's security gate is `skipped` (`loop-verification-service.ts:123-124`). That fails the run, while `certifyLoopRun` (`:215-217`) tolerates `skipped`.** | Y (lease ids) | Y |
| DECISION | goal completed/failed `loop-daemon.ts:957-962`; the draft PR opens only on allGatesPass `:925`; human merge or auto-merge `loop-auto-merge.ts:44-176` | Y | Y | P | P (auto-merge revocation fails open when GitHub is unreachable, `:54,193-199`) | **N**: auto-merge merges the current head sha, not the verified one (`:143,164`) | Y (class state) |
| SETTLEMENT | `merge-survival.ts:196-302` | Y | Y (26 settled per A) | Y (14-d line survival) | P | **N**: no merge sha stored; line-presence heuristic (`:276-277`) | **N**: outcome write (`:289`) happens before the metadata update (`:297`), so a crash duplicates it |
| LEARNING | skill_outcomes → bandit; outcome_credits; memory-rule fitness; ACE/STE/F2/memory-holdout arms | Y | Y | P (arms collecting; 0/11 loops closed per the plan) | Y (`catch {}` at `loop-daemon.ts:916`; attribution swallows, `outcome-attribution.ts:190`) | P | P (skill_outcomes dedupe by SELECT only; outcome_credits has a PK) |

Notes:
- **Gaps.** No worktree sha links evidence to verification to merge, so provenance breaks at three places: evidence, auto-merge and settlement.
- **Learning that disagrees with itself.** Attribution writes a `verified` credit for any run with no fail/unknown gate (`loop-daemon.ts:875`). The daemon writes `success=0` for the same run when its security gate is `skipped`. Prod impact is UNKNOWN. Security leases (148) are nearly as numerous as checker leases (155) (P), so most lane runs are high-risk and the defect touches only the remainder. The check is `skill_outcomes` with `evidence_refs_json LIKE '%security_checker_verdict:skipped%'`.

## 2. Doc-drift / reflection / refinement / feedback proposals

The same loop as §1, but fed by LLM-originated proposals.

| Transition | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|
| TASK: reflection / refinement / feedback proposals | Y | Y: 416 + 307 + 32 in 30 d (A) | – | – | P | P |
| SELECTION: jev `proposal_prescreen` (enforce) → panel (`specialist-panel-service.ts:580-640`) | Y | Y (2 631 specialist_reviews, P) | N (panel AUC 0.98 is leakage) | P (closed seats shrink `required`) | Y | Y |
| ASSIGNMENT → SETTLEMENT | as §1 | Y | as §1 | as §1 | as §1 | as §1 |
| Outcome | – | **reflection 1/416 verified; refinement 0/307; feedback 0/32 (A)** | – | – | – | – |

- **Diagnosis.** The ideas have no independent oracle; the maker writes its own test (PHASE0 §2).
- **Governance note.** The panel's risk ceiling was removed on purpose (`specialist-panel-service.ts:614-623`). Unanimous consensus now authorises a goal for any risk class, and the same `goal` result promotes memory (`memory-candidate-review-scheduler.ts:142-143`).

## 3. GitHub PR review (webhook → djimitflo-review status)

| Transition | Where | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|---|
| TASK | `routes/github-webhooks.ts:76-191` (HMAC timingSafeEqual, delivery dedupe) | Y | Y | – | N | Y (delivery id, head sha) | **P**: a second delivery for the same head sha throws on UNIQUE *after* the goal and run were committed (`github-pr-review-service.ts:95-98`); those orphans are later failed as stale_planning |
| ASSIGNMENT | synthetic manual maker plus one manual checker (`:145-177`) | Y | Y (maker manual 930/929, checker manual 1264/929, P) | – | – | – | – |
| EXECUTION / EVIDENCE | Phase-1 heuristic stub (`:298-310`); Phase 2 LLM (`:217-256`) is built but disabled | P | Y (stub) | N | – | – | – |
| VERIFICATION | the stub verdict is recorded as `manual_attestation {reviewer:'roborev-webhook'}` (`:171-174`) | Y | Y | **N**: a heuristic is presented as human attestation | – | **N** | – |
| DECISION | Commit Status accepted→success (`:362-370`) | Y | Y | N | – | – | – |
| SETTLEMENT | run forced to `completed` even when it is blocked (`:184-192`) | Y | Y | – | Y | – | – |
| LEARNING | counted as "valid reviewer verdicts" in `cost-ledger.ts:136`; whether it feeds dream inputs is UNKNOWN (`dream-evolution.ts:230`) | P | ? | – | – | – | – |

- **On the manual security_checker 257/0 (P).** Code shows the PR-review path creates **no** security_checker lease (`git log -S security_checker` on these files is empty).
- **Where manual security leases come from.** They are created for high-risk lane runs:
  - `loop-lifecycle-service.ts:96-103`
  - `loop-lifecycle-service.ts:219-226` (retries and evolve siblings)
  - `loop-daemon.ts:779-789` (reviewer retry)
- **Why they never run.** They stay `manual` unless the daemon dispatches them. Dispatch requires all of:
  - `LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED` (`loop-daemon.ts:822`)
  - a decisive checker under `LOOP_REVIEWER_STRATEGY=bounded` (`:824-832`)
  - a maker that did not fail
- **Who cancels them.** Sweepers, without a reason: queue-hygiene (`queue-hygiene-service.ts:128-130`), self-healing (`self-healing-service.ts:228-232`) and evolve-loser cleanup (`evolve-selection.ts:113-126`).
- **Verdict.** Mostly a superseded or dead placeholder, not a designed "checker passed" cancel. The prod split per site is UNKNOWN; the parent can run the breakdown query in the verification inventory.

## 4. Evolution gym (remote, local, subscription) → dream genomes

| Transition | Where | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|---|
| TASK | mined fixes / mutants / write_test (`gym-task-miner.ts:44`, `gym-mutants.ts:63`, `gym-failure-tasks.ts:36`) | Y | Y | – | – | Y (gym commit) | ? |
| ASSIGNMENT / DELEGATION | worker pull `routes/remote-gym.ts:35-70` with HMAC token | Y | Y (atomic 41, claude 10, codex 5 in 7 d, V) | – | – | P (no lease id for gym runs) | ? |
| EXECUTION / EVIDENCE | `scripts/gym-worker.mjs:63-66,188` | Y | Y | – | – | **N**: no harness hash except TG-001 (`tg-001.ts:242`); no worker version | – |
| VERIFICATION | the server accepts the worker's `status` (`remote-gym-service.ts:234-246`); hack classifier is shadow (`gym-hack-classifier.ts:9`); canaries default to 0 and are opt-in (`:50-64`) | P | Y | **N**: no server-side re-run | Y | N | – |
| DECISION | dream settlement (McNemar/graded) `dream-evolution.ts:600-710` → `promoteGenome` `genome-promotion.ts:44-52` | Y | **N** (`DREAM_EVOLUTION_ENABLED=false`; 0 promotions) | N | Y (fail-soft writes `:684-708`) | P | Y (status guard `AND status='trial'`) |
| SETTLEMENT / LEARNING | genome → lease `metadata.genome_id` → knowledge-fitness | Y | N | **N**: gym 78.8 % vs prod 7.0 % for the same species (CODEX_REPORT) | – | – | – |

Hack flags never reach promotion. `committee_genomes` changes status outside the single promotion boundary (`committee-swarm.ts:202,216`). Subscription makers are 0/15 in the gym (V).

## 5. Committee (forecast) swarm

| Transition | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|
| TASK: `enqueueCommittee`, called unconditionally (`self-improvement-auto-review-scheduler.ts:153`) and returns early when off (`committee-swarm.ts:58`) | Y | Y: 134 jobs in 30 d (P); **off since 19-10** | – | – | – | – |
| EXECUTION: workstation pull (`remote-gym.ts:59,63`) | Y | Y | – | Y: context recipes return '' on error (`:82`); unguarded JSON.parse (`:154`) | P | ? |
| VERIFICATION: Brier skill vs base rate (`forecast-scoring.ts:36`) | Y | Y | Y (scored) | – | – | – |
| DECISION: member weights, `evolveCommittee` (runs hourly even when off, `bootstrap/autonomous-services.ts:255`), `arenaGate` (flag), `fleetSourceGate` (no flag, `:291`) | Y | P | – | – | – | – |
| LEARNING | Y | Y | **0/20 forecasters decision-grade** | – | – | – |

Risk: with the committee off, residents get no questions (`:249`). The arena "no measurable call" rule can then retire them (`:277-279`).

## 6. Agent Commons (residents)

| Transition | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|
| TASK / ASSIGNMENT: resident selection reads `agents.status IN ('active','idle')` (`agent-social-autopilot-service.ts:228`) | Y | Y earlier; `SOCIAL_AUTOPILOT_RUNTIME` now off | – | – | – | – |
| EXECUTION: `resident:<id>:<kind>` LLM calls | Y | Y (≈ 80–109 calls per resident in 30 d, A) | – | Y (every step is `catch { failures++ }`) | P | – |
| EVIDENCE: `commons_contribution` 1 368 and `commons_idea` 1 327 shadow rows (P) | Y | Y | N | – | **N**: raw INSERTs bypass `buildProvenance` | – |
| DECISION: `threadGated` acks and skips on **shadow** rows with no mode check (`:387-396`) | Y | ? | N | – | – | – |
| SETTLEMENT / LEARNING: `groundFromCommons` (`self-improvement-service.ts:399`), APPLY off | P | N | **0 verified from Commons** | – | – | – |

`agents` has 32 rows, all `active` (P). That is registration, not liveness. `agentLiveness` is used for display only (`routes/agents.ts`, `scorecards.ts`).

## 7. Frontier Experts

| Transition | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|
| TASK: discovery units (`external-event-ingest-service.ts:192`) and scheduler (`frontier-expert-scheduler.ts:72`) | Y | Y: 4 401 papers, 138 repos (A) | – | – | P | Y (INSERT OR IGNORE) |
| SELECTION: jev `discovery_relevance`; mode-agnostic readers (`technique-card-service.ts:85`, `interest-feedback.ts:113`) | Y | Y: 3 930 shadow rows (P) | N (83 % uncertain) | – | – | – |
| EXECUTION: `expert-council-service.ts:104-120` through `selectingRunner` | Y | Y: 37 calls in 7 d (V) | – | – | **N**: ledger rows have no provider or tokens (V shows tok 0) | – |
| EVIDENCE: claims, 2 265 (A) | Y | Y | N | – | – | – |
| DECISION / LEARNING: claims feed committee context, technique cards and knowledge-fitness | P | P | **N**: 0 proposals cite knowledge; F4 shows decisions unchanged | – | – | – |

## 8. Fleet agents (other hosts and repos)

| Transition | Where | Exists | Prod | Indep | Silent | Prov | Idem |
|---|---|---|---|---|---|---|---|
| TASK | host crons (hermes-macmini, hermes-eve-v, eve-maintainer, kbwiki, scout); no repo code for the crons | P | Y | – | – | – | – |
| EXECUTION | host-local | ? | Y | – | – | – | – |
| EVIDENCE | `scripts/emit-agent-outcome.py:14-21,42`: the caller passes `--success`, there is no auth, and it exits 0 even when the bus is down | Y | Y | **N**: self-asserted | Y | **N**: optional `ref` only | – |
| TRANSPORT | bus GET without Authorization and with unsigned events (`external-event-ingest-service.ts:142`) | Y | Y | – | Y (poll errors are only logged, `:225`) | N | Y (INSERT OR IGNORE by event id) |
| VERIFICATION | none | N | – | – | – | – | – |
| SETTLEMENT / LEARNING | `scoreAgentOutcomes` → `skill_outcomes` domain fleet (`:38-56`) → scorecards / value allocator | Y | Y: top-8 fleet skills 113/113 success in 30 d (A) | **N** | Y (malformed rows skipped silently) | N | Y (NOT EXISTS by task_id) |

Measured value of fleet discovery: scout 199/2 664 relevant; hermes-macmini 0/105; hermes-eve-v 0/16 (`expert-source-units-service.ts:30`).

roborev path:
1. emit to the pending JSONL on the cockpit
2. `ship-to-djimitflo.sh --live` (manual)
3. bus `roborev.finding`
4. `external-event-ingest-service.ts:116-131` → work_items candidate (errors swallowed `:130`)

Three readers also read the local JSONL inside the prod container and get nothing, because the file is not there:
- `roborev-findings-service.ts:14-45`
- `bootstrap/operator-services.ts:14`
- `dennis-agent-service.ts:887`

Supply today is 0 `review_fix` events (finding-fix-lane-design.md).

---

## Disconnected capabilities (no live consumer that changes a decision, or no producer)

| Capability | Evidence |
|---|---|
| `agent_skills` | 0 rows (P); `execution-engine.ts:1386-1452` selection always falls through |
| `swarm_capabilities` | 510 rows (P). The only gate (`integration-inbox-service.ts:176-183`) needs `validated`, and auto rows are never validated |
| skill_cards (77) | the only consumer is `DREAM_PLAYBOOK_GENE` (off) with dream off (`lane-playbook.ts:50,72`) |
| skill_genomes | 0 rows, unread (FITNESS_AUDIT #18) |
| reasoning bank / Qdrant | write-only; `searchReasoning`/`getTrajectoryContext` have no callers (`reasoning-bank-service.ts:204,220`) |
| consensus_debates | 0 rows; manual route only (`routes/agi.ts:33-59`) |
| swarm_sessions | 0 rows ever; throws |
| council | 4 sessions in 30 d (P); `requires_human_approval` is returned but not enforced (`council-orchestrator.ts:259-260`) |
| shadow judgments | 96 % of 30-d judgments are shadow (A judg30: 18 570 / 19 342). No consumer for `checker_second_opinion`, `risk_atomic`, `failure_cause`, `commons_idea`, `value_allocation` |
| value allocator | record-only (`value-allocator.ts:9-10`); flag live at next recreate |
| hack classifier | reports only; promotion never reads it |
| nested spawn | `SPAWN_DEPTH_BUDGET=0` default. The prod probe used the wrong table name (`nested_spawns`); the real tables are `sub_agent_spawns` and `spawn_trees` (`migrate.ts:689-722`) |
| `mcp_servers.status` | display / doctor only |
| roborev local readers | file absent in prod |
| finding-fix lane | not on main (#909 open) |
| value-anomaly alarm, learning ledger, € ledger | not on main (#905/#906/#907 open) |

## Duplicated mechanisms

| Mechanism | Copies (file:line) |
|---|---|
| Multi-LLM deliberation | panel `specialist-panel-service.ts:580`; council `council-orchestrator.ts:76`; committee `committee-swarm.ts`; consensus `multi-agent-consensus-service.ts:55`; Frontier expert council `expert-council-service.ts`; swarm sessions |
| Failover | engine chain `fallback-chain-service.ts:13-18`; outage fallback `ollama-outage-fallback.ts:52`; `llm-fallback.ts:95-123`; `llm-router-service.ts` (apex only); panel claude fallback; Ollama auto-failover `inference-failover.ts` |
| Model choice | `model-selector.ts` and a re-implementation inside `self-improvement-agent-review-service.ts:319-332`; runtime bandit; llm-router Thompson |
| Agent registries | `agents`; `registry_agents`; OKF `agents/*.md`; `council_models`; `committee_genomes`; `fleet_hosts` |
| Liveness | fleet_hosts at 120 s (`fleet-commands.ts:92`) vs connection state at 24 h (`agent-connection-state.ts:65`) vs `agents.status` (never decays) |
| Skills | skill-loader/agent_skills; skill-service; skill_cards; `swarm_capabilities kind=skill`; strategy genomes |
| Genomes / promotion | `maker_genomes` + `promoteGenome` vs `committee_genomes` status writes |
| Experiment lists | `experiment-registry.ts:41` vs `evolution-feedback.ts:41-43` (4 of 9) |
| Embeddings | 4 stacks: NVIDIA `proposal-dedupe.ts:16`; Ollama `reasoning-bank-service.ts:15`; `ollama-embedding-provider.ts`; `embedding-provider.ts:79`; plus a hash fallback `vector-memory-service.ts:41` |
| ExecutionEngine instances | `index.ts:221`, `bootstrap/core-services.ts:48`, and lazy in `loop-worker-executor-service.ts:494` |
| Lease inserts outside the repo | `proof-run-service.ts:1060`, `cs-skill-swarm-harness-service.ts:773` |
| Holdout validity | strict `genome-promotion.ts:20-41` vs lenient `evolution-evidence.ts:147-172` |
| roborev intake | bus ingest vs three JSONL readers |
| DB schema owners | djimitflo `migrate.ts` vs `djimit/loop-engineering tools/config.py:14` (own `loop_runs` DDL, opens the sqlite file directly) |
