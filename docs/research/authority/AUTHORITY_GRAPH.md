# Djimitflo authority graph

CAUSAL-EVOLUTION-003, workstream F. Reviewed on 2026-10-22 against origin/main `5dfc6cdb`. This was a code review with small unit tests. Nothing ran against prod.

The machine-readable twin is [`authority-graph.json`](authority-graph.json). It holds 60 edges and 12 indirect paths, with the same IDs as this page.

**The rule.** A probabilistic model judgment never replaces deterministic authorization. jev never decides approval, promotion, code, risk or fitness.

## How to read this

Each edge records six things:

- **principal:** who acts.
- **capability:** what they reach.
- **enforcement:** `file:line`.
- **delegation:** how the authority is handed on.
- **policy version:** null with a reason when nothing is recorded.
- **audit evidence.**

Paths are relative to the repo; `S/` = `packages/server/src/`.

| Tag | Meaning |
|---|---|
| VERIFIED | Read end to end (`file:line`). For fixed findings, a test fails on main. |
| SUPPORTED | The cited lines were read, but not the full path or the prod state. |
| HYPOTHESIS | Plausible from the code, but not traced. |
| UNKNOWN | Evidence is missing. This never means "safe". |

**Roles** (`packages/shared/src/types/auth.ts:15-83`):

- **MAKER:** `create:task`, `execute:task`, `write:agents`, `write:skills`, `write:capability`, `write:claim`, `write:swarm_action`, `write:evidence`.
- **`approve:task`:** ADMIN and APPROVER only.
- **`write:governance`:** ADMIN only.
- **PLATFORM_ADMIN:** has `manage:config` but not `approve:task`.

**Prod.** All four users are admin (SECURITY_GAPS S12). Every least-role escalation below is therefore *latent* until service accounts exist. The fixes close those paths before that happens.

## Confirmed bypasses (proposal → promotion / execution)

Each one has a PR. Each PR's tests fail on main and pass with the fix. Each PR is green on tsc, lint and its related suites. Nothing is merged.

| ID | Bypass | Severity | PR |
|---|---|---|---|
| MEM-03 / IP-01 | `ProofRunService` promoted its own distilled `engineering_rule`s with `approved_by: 'proof-run-service' \| 'memory_curator'` (`S/services/proof-run-service.ts:838, 864, 1254`). Any `approved_by` string satisfies `review_required` (`S/services/memory-candidate-service.ts:233`). Promoted rules are written into maker prompts (`S/services/assignment-context.ts:78-108`). The failure rule embeds raw error text: on main the test sees `fatal: not a git repository` promoted. The initiator needed only `write:governance`, while the promote route needs `approve:task` + `human_approved`. | MEDIUM | **#963** |
| EXE-11 | Proof-run loop completion took `body.human_approval_ref` (`proof-run-service.ts:142, 737`). | LOW | **#963** |
| CAP-01 / IP-02 | A MAKER could `POST /swarms/intelligence/capabilities` with `status: 'validated'`, `eval_score: 1`, risk `critical` and `allowed_actions: ['spawn_runtime_worker']`. That gives `live_route_allowed`, so `planLoopRun` (`loop-service.ts:726`) and nested spawns (`nested-spawn-service.ts:561`) can route it. The capability skips promotion entirely. The upsert also overwrote a validated capability and dropped its `outcome_hold`, which otherwise needs a two-person release. | MEDIUM (HIGH for least-role MAKER accounts) | **#965** |
| CAP-02 | The high/critical promotion "human gate" accepted any non-empty `human_approval_ref` from the body (`S/services/swarm-intelligence-service.ts:364-372`). That is SECURITY_GAPS S17. The fix binds it to `operator:<user id>` for a caller holding `approve:task`. | MEDIUM | **#965** |
| EXE-06 / IP-03 | `reviewerInheritsRunApproval` trusted task tags and `metadata.loop_run_id` (`S/execution/execution-engine.ts:1557-1580`). Both are free input on `POST/PATCH /tasks`. A task tagged `checker` therefore executed under another task's maker approval, with any executor, sandbox or working directory. The fix requires a reviewer lease of the run that names the task. It needs `LOOP_REVIEWER_APPROVAL_INHERIT=true`; the prod value was not checked here. | MEDIUM | **#967** |
| CFG-04 / IP-04 | `manage:config` could map a Telegram id to **any** user (`S/routes/self-improvement.ts:203-215`). The bot then mints that user's JWT (`S/services/telegram-api-service.ts:20-24`). This let PLATFORM_ADMIN reach `approve:task`. It needs an allowlisted Telegram account, and no PLATFORM_ADMIN exists today. | LOW-MEDIUM | **#968** |
| KNW-05 | `POST /segml/federation/receive` wrote fleet-wide peer patterns under `read:evidence` (any VIEWER) (`S/routes/segml-federation.ts:46`). That is S19. The table is absent in prod. | LOW | **#968** |
| EXP-01 / IP-05 | `discovery_relevance` (jev, rows labelled `shadow`) decides expert-unit creation under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true`. FE2 is at `S/services/expert-source-units-service.ts:131-149`; KE-2 is at `:111-129` and `:300-313`. DI-001 B calls unit creation a *promotion*. It was not in `GATE_READ_JUDGMENTS`. The backlog re-judge lacked the recorded-provenance check that the live path has. **Paused** (`DISCOVERY_RELEVANCE_PAUSED=true`, #825) and not unpaused here. #964 does the honest accounting and the fail-closed provenance check. | MEDIUM (rule conflict; no live effect while paused) | **#964** |
| EXP-02 | After insert, the verdict row was re-pointed to `expert_unit` (`:146, :178, :310`), while `provenance_json.evidence_reference` still named the discovery. The provenance now records `subject_rewrite {from, to, at, reason}`. | LOW | **#964** |
| SCH-01 | `threadGated` read `commons_contribution` verdicts although that judgment is off (since 09-30) (`S/services/agent-social-autopilot-service.ts:387`). Stale rows gated threads forever. A judgment that is off now gates nothing, and the gate registry follows the same rule. | LOW | **#964** |
| EXE-15 | `/mcp-permissions` decisions are **catalog only**. No live code path is an MCP client. `ToolBroker.evaluateToolCall` (`S/services/tool-broker.ts:184`) has no caller. Djimitflo's own MCP server checks roles, not `mcp_tool_permissions`. No enforcement layer was added, because there is no call site to enforce at. The dashboard now says "Catalog only — not enforced". | LOW (honesty of display) | docs PR |

## Lead-by-lead answers

1. **Proof-run memory flywheel.** CONFIRMED (VERIFIED). The bypass is the promotion itself (MEM-03). `PROOF_RUN_MEMORY_FLYWHEEL` (unset = on, `memory-candidate-service.ts:330`) gates only the Qdrant write-back that follows.
   - The fix keeps `MemoryCandidateService.promote` as it is: P0-9 deliberately lets machine callers promote non-human rules, and `memory-review-and-gate.test.ts` pins that.
   - Instead it removes the self-approval at the caller (#963). The rules stay `review_required` for the operator.
2. **discovery_relevance.** CONFIRMED in code, paused in prod. Fixed as directed (#964):
   - the judgment is recorded in `GATE_READ_JUDGMENTS`;
   - the re-point now records `subject_rewrite` in provenance;
   - the backlog path now fails closed.

   **Operator decision required before any reopen.** This is a promotion-bearing jev decision. Classify it against the jev rule. Either keep jev advisory and admit units by a deterministic rule, or record why relevance classification is acceptable here.
3. **threadGated / commons_contribution.** CONFIRMED (VERIFIED), fixed in #964.
4. **MCP permissions / ToolBroker.** No live call path executes external MCP tools (VERIFIED). The only JSON-RPC client call is `tools/list` in `S/services/federation/adapter.ts:55`, which is flag-gated and test-only. Sidecar HTTP use is limited to health probes and OpenAPI fetches. Fix: a "catalog only" notice in the UI plus this document.
5. **Other bypasses.** CAP-01/02, EXE-06, CFG-04 and KNW-05 were found and fixed (table above). The remaining findings are listed below.

## Edges by capability class

Full fields for every edge are in the JSON. Only the load-bearing points are repeated here.

### Execute tools / commands / agents; approve executions

| ID | Principal → capability | Enforcement | Delegation · policy version | Audit | Tag |
|---|---|---|---|---|---|
| EXE-01 | `execute:task` → run a task | `S/routes/tasks.ts:434, 441`; `S/execution/execution-engine.ts:252, 320, 328, 329, 389` | approval_policies; the version is bumped but not bound to the decision | `execution-engine.ts:372, 423`, `risk_assessments` | SUPPORTED |
| EXE-02 | `approve:task` → approve execution | `S/routes/approvals.ts:160, 195`; `S/services/approval-service.ts:180, 200-202` | `decided_by = req.user.sub` · none | `approval-service.ts:234` | VERIFIED |
| EXE-03/04 | loop-daemon / gym → auto-approve | `S/services/loop-daemon.ts:386-393`; `S/services/autonomy-shadow-service.ts:58-71`; `S/services/evolution-gym-service.ts:271` | `autonomy:test-gap-rule-v1`, `autonomy:oracle-lane-v1`, `autonomy:gym-rule-v1` (deterministic rules) | judgments, audit `autonomy:*` | SUPPORTED |
| EXE-05 | loop-daemon → retry inherits approval | `S/services/approval-inheritance.ts:24-44` | `inherit:<id>`; machine deciders excluded (`:35`) | loop_events | SUPPORTED |
| EXE-06 | reviewer task → inherits the run approval | `S/execution/execution-engine.ts:1557-1580` | was tags + `loop_run_id`; **lease-bound after #967** | `:1575` | VERIFIED |
| EXE-07 | `create:task` → loop run, workers | `S/routes/loops.ts:183, 270, 282, 294`; `S/services/loop-worker-executor-service.ts:581-604` | `requested_by = 'system'` | loop_events | SUPPORTED |
| EXE-08/09 | `approve:task` → checker verdict / completion | `S/routes/loops.ts:307, 321, 346-352` | JWT user / `operator:<sub>` | loop_events only | SUPPORTED / VERIFIED |
| EXE-10 | automated LLM checker → `checker_verdict` gate | `S/services/loop-daemon.ts:771-831`; `S/services/loop-verification-service.ts:343-353` | model verdict (code class) · none | `worker_leases.metadata.verdict` | SUPPORTED |
| EXE-12 | `write:swarm_action` → worker pool, spawns | `S/routes/swarm-workers.ts:43-80`; `S/routes/spawns.ts:51` | spawn tokens; engine approval still applies | loop_events, spawn rows | SUPPORTED |
| EXE-13 | `manage:config` + `approve:task` → fleet root command | `S/routes/host-agent.ts:80, 83`; `S/services/fleet-commands.ts:43-54` | sha256-bound; self-approval recorded (operator decision 10-10) | `fleet-commands.ts:53` | VERIFIED |
| EXE-14 | `create:task` → goal qualifying for objective mode | `S/services/objective-loop-gate.ts:39-46`; `S/services/goal-service.ts:307` | `metadata.source='self-improvement'` | none | SUPPORTED |
| EXE-15 | any → external MCP tool | none (no client); `S/services/tool-broker.ts:184` uncalled | — | — | VERIFIED |

### Merge PRs, deploy code

| ID | Principal → capability | Enforcement | Notes | Tag |
|---|---|---|---|---|
| MRG-01 | loop-auto-merge → squash-merge test-only loop PRs | `S/services/loop-auto-merge.ts:49-198`; eligibility at `:118` accepts `ready_for_human_merge` | `LOOP_AUTO_MERGE_TEST_ONLY=act`. The `no_automatic_merge` gate is hard-coded `pass` (`S/services/loop-verification-service.ts:164-168`). Audit at `:192`. | VERIFIED |
| MRG-02 | dependency-lane → merge Dependabot PRs | `S/services/dependency-lane.ts:148-256`; green on any status context (`:118-121`) | prod `shadow` (#961) | SUPPORTED |
| MRG-03 | `manage:config` → re-enable act modes | `S/routes/loops.ts:113, 133` | audited | SUPPORTED |
| DEP-01 | root systemd timer → deploy main | `scripts/auto-deploy.sh:60-70` fetches `deploy-vps.sh` **from the commit being deployed** | So merge authority equals root deploy authority. Kill switch: `AUTO_DEPLOY_DISABLED`. | VERIFIED |

### Promote memory

| ID | Principal → capability | Enforcement | Delegation | Tag |
|---|---|---|---|---|
| MEM-01 | `approve:task` → promote | `S/routes/swarm-governance.ts:198-213`; `S/services/memory-candidate-service.ts:229-233` | `human_approved` + `req.user.sub` (P0-9); audit at `:208` | VERIFIED |
| MEM-02 | review scheduler (LLM panel) → promote non-sensitive operational memory | `S/services/memory-candidate-review-scheduler.ts:135-149`; `memory-candidate-service.ts:166-178` | `agent:memory-approver:<run>`; the panel is not independent, so a MAKER can fill its seats (`S/routes/swarms.ts:169`, `specialist-panel-service.ts:390-408`) | SUPPORTED |
| MEM-03 | proof run → promote engineering rules | `S/services/proof-run-service.ts:838, 864, 1254` | string `approved_by` | VERIFIED → **#963** |
| MEM-04 | proof run → promote the proof-chain operational memory + Qdrant | `proof-run-service.ts:481, 817` | unattended-eligible class; unchanged | VERIFIED |
| MEM-05 | promoted rules → maker prompts | `S/services/assignment-context.ts:78-108` (seal `:110-123`) | the read side does not check `approver_type` | VERIFIED |

### Admit knowledge, create expert units

| ID | Principal → capability | Enforcement | Tag |
|---|---|---|---|
| KNW-01 | knowledge publish → candidate capability / spawn request | `S/routes/knowledge.ts:24`; `S/services/capability-acquisition.ts:27-75` (`write:claim` fix in #948) | SUPPORTED |
| KNW-02 | `write:claim` vote → claim confirmed | `S/services/knowledge-sharing-service.ts:102-120`: `agentId` comes from the body and is not deduplicated | SUPPORTED |
| KNW-03 | unauthenticated event bus → work items, discoveries, skill_outcomes | `S/services/external-event-ingest-service.ts:147-248`; `FLEET_EVENT_SIGNATURES` default off (`fleet-event-signatures.ts:32-33`) | SUPPORTED (S3, #954 prepared) |
| KNW-04 | `write:swarm_action` OKF sync → frontmatter-complete skills `validated` | `S/routes/swarm-knowledge.ts:62`; `S/services/knowledge-runtime-service.ts:152-180, 498, 506` | SUPPORTED |
| KNW-05 | VIEWER → federated peer patterns | `S/routes/segml-federation.ts:46` | VERIFIED → **#968** |
| EXP-01/02 | jev relevance → expert unit; subject rewrite | `S/services/expert-source-units-service.ts:111-149, 146, 178, 300-313` | VERIFIED → **#964** |
| EXP-04 | `write:swarm_action` human session → expert APPROVED/ACTIVE | `S/routes/swarms.ts:279, 286`; `S/services/frontier-expert-registry-service.ts:237-265, 314-332` | SUPPORTED |

### Change agent capabilities / skills

| ID | Principal → capability | Enforcement | Tag |
|---|---|---|---|
| CAP-01 | `write:capability` → register as validated / overwrite | `S/routes/swarm-intel.ts:237-240`; `S/services/swarm-intelligence-service.ts:230-316` | VERIFIED → **#965** |
| CAP-02 | `write:capability` → high/critical promotion via a string | `S/routes/swarm-intel.ts:263-265`; `swarm-intelligence-service.ts:364-372` | VERIFIED → **#965** |
| CAP-03 | `write:capability` → low/medium promotion | `swarm-intelligence-service.ts:354, 360`: caller-asserted `eval_score` and `evidence_refs` | VERIFIED |
| CAP-04 | proof run → `autoPromoteFromEvidence` | `swarm-intelligence-service.ts:727-772`; no prod writer of `worker_leases.capability_id`, so dead in practice | SUPPORTED |
| CAP-06 | `write:capability` → release `outcome_hold` | `S/services/outcome-learning-service.ts:260-300`: two-person approvals row; `released_by` comes from the body | SUPPORTED |
| CAP-07 | `write:skills` + `write:agents` → assign an admitted skill | `S/routes/skills.ts:49`; admission by env allowlist; no SKILL.md prompt injection found | SUPPORTED |
| CAP-08 | `manage:config` → create/approve agents | `S/routes/agents.ts:66, 282, 301`; no approver recorded | SUPPORTED |
| CAP-09 | `write:swarm_action` → model routing for the council | `S/routes/multi-model.ts:31, 64` → `council-orchestrator.ts:467`; no audit | SUPPORTED |

### Modify production configuration

| ID | Principal → capability | Enforcement | Tag |
|---|---|---|---|
| CFG-01 | `manage:config` → approval_policies CRUD, which can turn require_approval into allow | `S/routes/policies.ts:55, 100, 156`; the version is not bound to decisions; create is not audited | SUPPORTED |
| CFG-02/03 | MCP decision PATCH (`manage:config`); `GET /mcp/servers?refresh=true` writes catalog rows (requireAuth only) | `S/routes/mcp.ts:85-125, 302-340` | SUPPORTED |
| CFG-04 | `manage:config` → Telegram identity for any user | `S/routes/self-improvement.ts:203-215` | VERIFIED → **#968** |
| CFG-06 | `write:governance` → quarantine release / breaker reset | `S/routes/runtime-governance.ts:74, 93`; no actor recorded | SUPPORTED |
| CFG-07 | users / roles | env bootstrap only (`S/services/auth-service.ts:290-315`) | SUPPORTED |
| CFG-08 | `manage:backups` (incl. PLATFORM_ADMIN) → stage restore | `S/routes/backup.ts:78`; confirmation is the literal `RESTORE` | SUPPORTED |

## Not confirmed / not fixed

- **IP-06 (SUPPORTED):** PLATFORM_ADMIN can loosen `approval_policies` and so reach execution without approval. Not tested.
- **IP-07 (HYPOTHESIS):** a MAKER fills the non-independent memory review panel to get operational memory promoted. Not exercised.
- **IP-08 (SUPPORTED):** a test-only change can reach main and prod with no human. The chain is: autonomy rule → LLM checker → auto-merge → auto-deploy. It is configured by operator flags.
- **IP-09 (SUPPORTED):** a goal forged with `create:task` reaches an objective-mode maker run. It skips proposal approval only; execution approval is still human.
- **IP-12 (UNKNOWN):** what consumes a ballot-stuffed `confirmed` knowledge claim.
- **CAP-04:** dead in practice, because nothing writes `worker_leases.capability_id`.
- **CAP-07:** no MAKER path to skill install or prompt injection was found.
- **MCP:** no external MCP tool execution exists.

## Operator decisions needed

1. **discovery_relevance:** classify the jev unit-creation decision against the jev rule before lifting `DISCOVERY_RELEVANCE_PAUSED` (#964).
2. **Read-side memory trust (S14):** `assignment-context` injects any promoted `engineering_rule`, whatever its `approver_type`. Requiring a human approver there would change the pool the running **memory holdout** samples. Decide after the readout on 10-27.
3. **Machine deciders count as the "human" maker approval in reviewer inheritance** (`execution-engine.ts:1567`, `autonomy:*` / `inherit:*`). Restricting this stops checker inheritance in the auto-approved lanes.
4. **Self-asserted promotion evidence.** Low/medium capability promotion (CAP-03) and the OKF sync that validates skills (KNW-04) both skip deterministic evaluation. Decide whether `validated` needs a server-checked eval.
5. **Model verdicts as gates.** The LLM checker satisfies the code-class `checker_verdict` gate (EXE-10). The LLM panels approve proposals and operational memory (MEM-02; self-improvement auto-review, #961 §6.1). All of these are operator-enabled autonomy. They are recorded here as conflicts with the rule, not changed.
6. **Autonomous path to prod (IP-08):** `no_automatic_merge` reports `pass` while auto-merge acts. `auto-deploy.sh` runs the deploy script of the commit it deploys, as root.
7. **Separation of duties.** One APPROVER can approve and check the same run (EXE-07). Expert APPROVED/ACTIVE needs only `write:swarm_action` (EXP-04). Fleet commands allow self-approval (EXE-13).
8. **Permission-level gaps without a confirmed escalation:**
   - The caller sets `risk_level`, `execution_mode` and sandbox metadata on its own tasks (EXE-01).
   - `GET /mcp/servers?refresh=true` writes the catalog (CFG-03).
   - Model routing is writable by MAKER (CAP-09).
   - The notebook MCP tools have no checks (MCP-01, S6).

## Policy versions and audit gaps

**Policy versions.** Only these edges record a policy version:

- autonomy rule ids (`*-rule-v1`);
- judgment `policyVersion` (+ prompt hash in `provenance_json`);
- OKF/skill content hashes;
- `approval_policies.version`, which no decision references.

No capability promotion, memory promotion, expert transition, merge or deploy records the policy it was decided under. These are `null` in the JSON, never 0.

**No `audit.record` on:**

- checker verdicts and loop completion;
- proposal approval;
- capability registration and promotion;
- NL agent approval;
- quarantine release;
- MCP decision PATCH and server registration;
- approval-policy create;
- model routing writes;
- fleet command requests.

## Method

- **Leads.** #961 `JEV_CAPABILITY_FORENSICS.md` §6 and #948 `SECURITY_GAPS.md`.
- **Route sweep.** All 63 route files plus the daemons that act without a user, split across three read-only passes (execution/merge/deploy; memory/knowledge/skills; config/MCP).
- **Confirmation.** Every bypass in the first table was re-read here and reproduced by a failing test on main.
- **Out of scope.** Running experiments (ACE-001, STE-001, MAKER-DEPS-001, F2 v2, memory holdout, genome trials, D5-NO, JEV-114) and `tg-001.ts` / `remote-gym-service.ts` / `scripts/gym-worker.mjs` were not touched.
