# ASG-001 v1: results — Adaptive Skill Granularity for the oracle-lane maker

**Decision: INCONCLUSIVE.** Only a mechanism pilot ran: scripted agents, no model call. By the pre-registration (§7) that
makes H1–H3 and H5 INCONCLUSIVE whatever the numbers say. H4 (safety invariants) is the one hypothesis a pilot can test:
**0 violations in the ASG arms B–E** over 1,350 runs, including every injected fault. The model-backed run that
could decide ADOPT/REVISE/REJECT was not authorised. Its command, sample size and budget are in §8.

Pre-registration: `PREREG.md`, sha256 `5c8e4cb6d0019ded6f82c830b36e71ff9b4418074da8b8ace77891869bb5128a`, committed on its own
(fa1f8d0b) before any harness code, with its checksum in the next commit (d1875a9d). Deviations: §10.

## 1. Sources

- **Paper:** arXiv:2610.31461v1 (Zhang, Jiang, Wang, Zhou; 22 Oct 2026). Read in full (HTML v1).
  - It defines granularity as an admissible-action envelope (MICRO / MACRO / HYBRID with a one-way macro → micro downgrade).
  - It uses an option-like macro contract (applicability, side effects, verifier, failure classes, micro continuation).
  - It proposes a 5-class failure taxonomy and an FSM recovery executor.
  - Its pilot is small: 12 mixed tasks plus 7 fault tasks, 1 repetition. It promises confidence intervals and reports none.
- **Repository:** `github.com/Jayceon-3/Adaptive-Skill-Agent` at `1ab0dc346514c76bff7cab7a31e510ee67031397` (2026-06-28). Shallow-cloned into the scratchpad, read, never executed, then deleted.
  - **No licence file**, and no licence statement in the README, so all rights are reserved. **No code was copied.** Everything here is written from scratch.
  - **Benchmark:** 9 toy Python fixtures. 12 step-1 tasks (`step1_benchmark.py`), 7 step-2 fault tasks, 1 repetition by default.
  - **Splits:** none. The learned routers are trained on the evaluated tasks.
    - `models/router_model_summary.json` shows a mode router on 21 samples with leave-one-out accuracy 1.0.
    - It also shows a recovery router on 23 samples with leave-one-out accuracy **0.39**.
    - Table 4's "Emp. Match 1.000" is therefore in-sample.
  - **Reproducibility:** it needs a paid DeepSeek/OpenAI key (`openai_client.py`). The committed run logs carry absolute paths of the authors' machine.
  - Every macro failure is classified `recoverable: True` (`classify_macro_result`).
  - Mean tokens are reported over successful runs only, which differs from the paper's own eq. 11.
- **What we took (ideas only):**
  - the admissible-action envelope;
  - the contract fields;
  - the late-fault finding that unconditional downgrade wastes cost, which became our arm E, verify-before-recovery.
- **What we did not take:**
  - the learned router: the data does not justify it (§6 of the prereg);
  - the "everything is recoverable" taxonomy.

## 2. Real execution chain (oracle-lane maker) and reuse matrix

Chain (all wired unless noted). Paths are relative to `packages/server/src`.

1. **Goal.** `LoopDaemon.executeGoal` (`services/loop-daemon.ts`) runs a goal. Oracle lane means the proposal refs contain `test-gap:` or `mutation-gap:` (`ace-001.ts aceLane`).
2. **Loop run.** `startObjectiveLoop` → `LoopLifecycleService.continueLoopRun` → `createWorktree`, `writeWorkAssignment` (`assignmentContext`, `renderWorkAssignment`) and the maker lease.
3. **Runtime choice.** `LOOP_DAEMON_MAKER_RUNTIME`, or the bandit `chooseSpecies`. The genome stamp is `strategyGenomeFor`.
4. **Worker.** `LoopService.executeWorker` → `LoopWorkerExecutorService.executeMaker` → `runMaker`.
5. **Runtime dispatch.** `executeViaEngine` → `ExecutionEngine.executeTask`, which does `admitRuntime`, the policy/approval gate and the executor adapter.
6. **Effects.** Worktree diff and untracked files give `changed_files`. Then lockfile restore and `captureMakerDiff`.
7. **Maker gates.** `maker_runtime_exit_zero`, `diff_under_threshold`, `token_budget`, `runtime_warning_gate`, `no_automatic_merge`. The result is `metadata.failure` (`lease-failure.ts`).
8. **Checks.** `runDeterministicChecks`, then one G3 retry (`retryLoopRun`), the checker in its own worktree, and `verifyLoopRun`.
9. **Outcome.** `recordOutcomeAttribution`, `runGenome`, `skill_outcomes`. Offline: skill distillation (`skill_cards`), dream, and the playbook gene (gym trials only).

| part | status | how ASG-001 uses it |
|---|---|---|
| oracle-lane maker | PARTIAL: a lane class (refs), no dedicated module | integration point: `runMaker`, around `executeViaEngine` |
| loop-worker-executor-service | EXISTS (wired); retries live in the daemon | hook before/after the runtime; gates extended only in `on` |
| skill cards (#862) | EXISTS (record-only, shadow); never injected | lineage field `skill_card_refs` (empty: no prod access) |
| playbook gene / genome registry / maker-genome | EXISTS; lifecycle trial/active/retired/inconclusive; gym-only | lifecycle mapping (`EXISTING_STATE_EQUIVALENTS`) |
| assignment-context | EXISTS (wired) | untouched (prompt and template unchanged: ACE-001/STE-001 arms safe) |
| deterministic checks / checker | EXISTS (wired) | unchanged; run after ASG in every mode |
| outcome attribution / provenance | EXISTS (flagged) | unchanged; ASG records sit on the lease |
| effort controller | PARTIAL (shadow, X1 arm acting) | untouched |
| leases / claims / fencing | PARTIAL: no fence token or CAS on `worker_leases`; CAS only on the remote queue | ASG adds a workspace lock + write-ahead ledger in its executor; the prod hook relies on the lease being `running` |
| runtime admission | EXISTS (enforced) | unchanged; runs before any ASG step |
| failure capture `metadata.failure` | EXISTS | kept; a rescued maker keeps it as `asg.incident_failure` |
| route decision / macro procedures / recovery FSM | MISSING before this PR | built: `services/asg/` |
| per-action allow-list in runtime adapters | MISSING | not built (see §6); the executor's own CapabilityGate enforces it where ASG dispatches |

**Integration point chosen:** `LoopWorkerExecutorService.runMaker`, the two lines around the single runtime call. It is the
smallest point that sees the lease, the worktree, the runtime result and the gates. It does not change the daemon, the
retry or the checks. No second orchestrator was added.

## 3. Macros (3, chosen for the oracle lanes)

| skill | lanes | effect | idempotent | why |
|---|---|---|---|---|
| `asg:inspect_target_module@1` | both | read the source module only | yes | every oracle maker starts by reading its target; read-only, so it is safe as a HYBRID prefix |
| `asg:write_test_file_and_verify@1` | test-gap | create the one declared test file, then run its targeted test | yes (key: path + content + base digest) | the test-gap proposal's whole change: one new test file, verified by one command (`test-gap-source-service.ts` grounding) |
| `asg:replace_in_test_and_verify@1` | mutation | replace one exact occurrence in the unchanged test file, then run it | **no**, so it is guarded by the ledger | the mutation lane strengthens one existing test file; the base-digest precondition protects user changes |

- **Real-trace grounding:** `MAKER_FAILURES.md` §3 names "repeated verification" as the remaining maker tool-loop cost after environment bootstrap. The cycle is edit test → run targeted test → re-edit.
- **Verifying the frequencies:** the prod tool-call frequencies would confirm the choice. That needs the read-only query `trace-mine.js` against `execution_events`.
  - In this session it was **denied by the permission classifier (prod reads)** and was not worked around.
  - The selection therefore rests on the published trace analysis, not on fresh counts: **UNCONFIRMED**.
- **Exclusions:** no publish, deploy, merge, install, network or bootstrap macro. Bootstrap is the MAKER-DEPS-001 experiment.
- **Contract fields:** every contract carries `skill_id`, an immutable version + sha256 digest, input/output schema, preconditions, read/write/exec effects, required capabilities, runtime compatibility, postconditions + verifier ref, timeout and budget, failure taxonomy, idempotency/compensation, micro fallback + required recovery context, and lineage.
- **Lifecycle:** every macro is at `candidate`.

## 4. Routing, executor, effects

- **Router** (`router.ts`):
  - Seven fixed rules. Policy v1 hash `04ca63d0770d6532`, feature-schema hash in every decision.
  - Decision-time features only. No field of the task spec can carry the verifier, mutant, solution or results (test: `asg-contract-router.test.ts`).
  - A policy refusal is **STOP**. A contract mismatch, missing adapter, several targets or a non-executable lifecycle is **MICRO**, within the same permissions.
  - No learned router.
- **Executor** (`executor.ts`):
  - States: SELECT → CHECK_PRECONDITIONS → EXECUTE → VERIFY → SUCCEEDED, or CLASSIFY_FAILURE → RECONCILE → MICRO_RECOVERY → VERIFY → SUCCEEDED | STOPPED. BUDGET_EXHAUSTED or INTERRUPTED can follow from any phase.
  - **Verify before recovery:** after an exception, the end state is checked first. A verified end state is SUCCEEDED with an incident.
  - **Partial macro:** reconciled from the observed workspace, never by re-running it.
  - **Write-ahead ledger:** a key over (skill, version, key fields, base digests). A crash or restart resumes from the ledger and keeps its original decision. A duplicate delivery returns the recorded result.
  - **Workspace lock** outside the workspace: no concurrent execution or recovery.
  - **Budget:** one shared total budget and at most 16 transitions.
  - **No return:** micro never returns to macro.
  - **Separate fields:** execution status, verification status and incident.
  - **Compensation** (pre-image restore) runs only when the end state does **not** verify. The pilot caught a first version that undid correct late-fault work (§10).
- **Effects** (`effects.ts`):
  - base snapshot and hashes, attempt id, action id, idempotency key, expected vs observed digests;
  - a CapabilityGate on every macro write and every micro write, fixed at creation (task capability ∩ contract effects);
  - recovery outputs are redacted with `redactSecrets`.

## 5. Production hook (ASG_MODE)

- **off** (default): `asgMode() === 'off'` short-circuits before any ASG code. The unset-vs-off lease is identical, apart from wall-clock fields (`asg-oracle-lane.test.ts`).
- **shadow:**
  - Records `metadata.asg`: decision, base HEAD, target digests and the declared write set, plus an `asg_route` event.
  - After the runtime it records expected vs observed effects.
  - No command runs and no outcome changes.
- **on:** a maker stopped by its timeout or token brake is `succeeded_with_incident` only when all of these hold:
  - its effects are bounded to the worktree (codex `workspace-write` without skip-permissions, or mock);
  - its only change is the declared test file;
  - the daemon's own `vitest run <file>` passes.

  Under those conditions:
  - gate `asg_end_state_verified` passes;
  - `maker_runtime_exit_zero` stays `fail` as evidence;
  - every other gate, the checks and the checker still decide.

  Unbounded runtimes are never rescued.
- **on is blocked:** it runs as shadow and records `blocked_by` while ACE-001, STE-001, MAKER-DEPS-001, F2 or X1 is on. Those experiments run on the same oracle-goal population.

## 6. Per-runtime capability (honest)

| runtime | macro contracts | per-action permissions | verifiable effects + checkpoints | safe interrupt / recovery | missing |
|---|---|---|---|---|---|
| opencode | no | no per-task allow-list (`--auto` on skip; repo-wide permission rules only) | worktree diff yes; external effects unknown (no sandbox) | timeout/brake kill; no resume | macro tool adapter, per-action allow-list, sandbox |
| codex | no | no per-tool list; `--sandbox workspace-write` bounds the filesystem (unless skip-permissions → bypass) | yes inside the sandbox | timeout kill; ASG verify-after-stop possible | macro tool adapter |
| claude | no | `acceptEdits` / skip only; the adapter passes no `--allowedTools` | worktree diff; external unknown | timeout kill | macro adapter, allowedTools wiring, sandbox |
| hermes | no | `--yolo` on skip only | worktree diff; external unknown | timeout kill | all of the above |
| atomic | no | `--no-approval` on skip only (prod history: command-preview hang) | worktree diff; external unknown | timeout kill | all of the above |
| remote | no | host-side; only a patch comes back | the patch is verifiable; host effects unknown | queue cancel | host adapter |
| mock / asg-harness | harness only (`runtime_compat: ['asg-harness']`) | yes (CapabilityGate) | yes | yes (ledger, lock, fence) | — |

Only the one coding path (oracle-lane maker in `runMaker`) is implemented. In production that path always executes MICRO.

## 7. Mechanism pilot (scripted agents, no model) — raw results with provenance

**This is a mechanism pilot, not an effect estimate.**
- The agents are scripted: each fixture fixes the micro solution and the macro plan.
- Some macro plans are deliberately wrong: `money` carries a wrong expectation, `csvsplit` a stale find text, and `dirty` is a user-changed file.
- Cost is in scripted units, one per agent action (table hashed in the manifest), never tokens.
- Every difference between arms follows from those choices. The pilot shows that the mechanism behaves as specified. It does not show that ASG helps.

**Provenance**, from `pilot/manifest.json`:

| field | value |
|---|---|
| command | `npx tsx packages/server/src/scripts/asg-001-pilot.ts --seed 20261024 --repetitions 3` |
| git HEAD | `0189c373dd284e15407c85cafbf6e2d9ecadf036` (`git_dirty: false`) |
| prereg sha256 | `5c8e4cb6…128a` |
| policy hash | `04ca63d0770d6532` |
| fixtures digest | `dc9ce654…4cd0` |
| cost table hash | `cc06b21bc724d89c` |
| node | v22.23.2 |
| runs | 1,395 (465 per repetition) |

**Raw data:** `pilot/rows.jsonl` (one row per run) and `pilot/analysis.json`.

**Fixtures:**
- 15 tasks in 7 families.
- **Split** (sha256 `asg-001:` + family, fixed in the prereg before the fixtures were written):
  - train: slug, clamp, csvsplit;
  - dev: dirty;
  - test: money, pair, config.
- The oracle is hidden from the router and the agents. A task succeeds only when every declared test passes, every declared test fails against a hidden mutant, user changes survive, and nothing changed outside the capability.
- A sanity test proves that every solution passes the oracle and every start state fails it.

**Repetitions:** 0 of 465 (task, arm, condition) units differ across the 3 repetitions. The scripted pilot is deterministic, so repetitions add no information. The tables use repetition 1, as pre-registered.

**Natural condition** (n = 15 paired tasks per arm):

| arm | verified | rate (Wilson 95 %) | total cost | cost / verified (family-cluster bootstrap 95 %) | macro adoption | recovered |
|---|---|---|---|---|---|---|
| A current | 13 | 0.87 [0.62, 0.96] | 47 | 3.62 [3.00, 5.00] | 0 | – |
| B micro-only | 13 | 0.87 [0.62, 0.96] | 43 | 3.31 [3.00, 4.00] | 0 | – |
| C macro-only | 5 | 0.33 [0.15, 0.58] | 26 | 5.20 [2.57, ∞] | 0.87 | – |
| D routed, no recovery | 7 | 0.47 [0.25, 0.70] | 32 | 4.57 [2.60, 15.0] | 0.73 | 0 |
| E routed + verify-before-recovery | 13 | 0.87 [0.62, 0.96] | 50 | 3.85 [2.67, 5.00] | 0.73 | 6/6 |

The 2 failures in every arm are the `config` policy tasks, which cannot be solved inside their permissions.
- Arms B–E STOP them with cost 0.
- Arm A writes `package.json` anyway, because today's path has no dispatch boundary. These are the only invariant violations (§9, H4).

**Paired comparisons** (exact McNemar on discordant pairs; Newcombe hybrid-score CI; cost ratio with the same family draws for both arms):

| comparison | both / x only / y only / neither | McNemar p | success diff [95 % CI] | cost-per-verified ratio [95 % CI] |
|---|---|---|---|---|
| **E − A (primary)** | 13 / 0 / 0 / 2 | 1.000 | 0.00 [−0.15, 0.15] | 1.06 [0.70, 1.47] |
| D − B | 7 / 0 / 6 / 2 | 0.031 | −0.40 [−0.60, −0.13] | 1.38 [0.81, 4.67] |
| C − B | 5 / 0 / 8 / 2 | 0.0078 | −0.53 [−0.71, −0.24] | 1.57 [0.81, ∞] |
| E − D | 7 / 6 / 0 / 2 | 0.031 | +0.40 [0.13, 0.60] | 0.84 [0.33, 1.03] |

**Cost per family** (natural, repetition 1; verified / units):

| family | B | C | D | E |
|---|---|---|---|---|
| slug (macro fits) | 3 / 9 | 3 / 6 | 3 / 6 | 3 / 6 |
| clamp (macro fits) | 2 / 6 | 2 / 4 | 2 / 4 | 2 / 4 |
| csvsplit, dirty, money (macro mismatch) | 6 / 18 | 0 / 12 | 0 / 12 | 6 / 30 |
| pair (two targets) | 2 / 10 | 0 / 4 | 2 / 10 | 2 / 10 |

**Injected faults** (repetition 1, reported apart from the natural condition; verified / n, total cost):

| fault | C | D | E | E recovered | E incidents |
|---|---|---|---|---|---|
| precondition mismatch | 0/15, 26 | 2/15, 32 | 13/15, 65 | 11/11 | 0 |
| partial change | 0/15, 26 | 2/15, 32 | 13/15, 65 | 11/11 | 0 |
| failure after correct completion | 5/15, 26 | 7/15, 32 | 13/15, 50 | 6/6 (natural) | 5 |
| invalid tool schema | 0/15, 26 | 2/15, 32 | 13/15, 65 | 11/11 | 0 |
| timeout, uncertain outcome | 3/15, 26 | 5/15, 32 | 13/15, 56 | 8/8 | 3 |
| crash + restart (same attempt) | 5/15, 26 | 7/15, 32 | 13/15, 50 | 6/6 (natural) | 5 |
| duplicate delivery | 5/15, 26 | 7/15, 32 | 13/15, 50 | – | 0 |
| concurrent execution | 0/15, 0 | 0/15, 0 | 0/15, 0 | – | – |

Arm B under duplicate delivery: 13/15, cost 43. Under concurrent execution: 0/15, cost 0.

Notes on the fault rows:
- **Late faults** (failure after correct completion, timeout after the effects, crash after the write) fired on 5, 3 and 5 macro-fit tasks.
  - On exactly those tasks E entered no micro recovery and cost the same as D: 10/10, 6/6 and 10/10 units.
  - D stops with execution `stopped` and verification `passed`. Its end state is correct and is not undone.
  - E records SUCCEEDED with an incident.
- **Concurrent execution:** every arm refuses to touch a workspace locked by another attempt. 0 actions, 0 effects; the verdict is "not run", not a failure of the task.
- **Duplicate delivery:** returns the recorded result, with 0 extra cost and 0 effects.
- **Crash and restart:** the macro procedure ran exactly once per idempotency key in every run.

## 8. Model-backed run (NOT run: not authorised)

**Not run.** A model-backed run (Ollama Cloud credits or the workstation GPU the gym uses) was not authorised.
- `asg-001-pilot.ts` refuses `--agent` other than `scripted` with exit 2.
- The run also needs four components that do not exist yet. They are listed here and none of them was built.

**Prerequisites (not built):**
1. **Async executor port.** `runAsg` and `AgentPort` are synchronous in v1, and a model call is async. Make both async; the state machine is unchanged.
2. **Model AgentPort.**
   - Prompt: the task, the active envelope (micro tools, or the macro contracts), the recovery context, and one JSON action per step.
   - Parsing is strict: a malformed action is an `invalid` action.
   - Provider-reported tokens per step: Ollama `prompt_eval_count` + `eval_count`, OpenAI-compatible `usage`.
   - A global token cap that ends a run as BUDGET_EXHAUSTED and stops the experiment when reached.
3. **Fixture generator.** At least 80 families × 10 variants, each with a hidden mutant. At ~40 % test share that gives ≥ 314 test tasks in ≥ 30 test families, so the family-cluster bootstrap has enough clusters.
4. **Operator authorisation**, recorded in the manifest (approval id and budget).

**Exact command once 1–4 exist:**
```
ASG_001_AUTHORISATION=<approval id> OLLAMA_BASE_URL=<workstation llama-router/Ollama, or https://ollama.com> \
  npx tsx packages/server/src/scripts/asg-001-pilot.ts --agent ollama --model <model> \
  --tasks generated:800 --seed 20261024 --repetitions 1 --token-cap 60000000 --out docs/research/asg-001/model-run
```

**Model choice:**
- The gym's species is `atomic@llama-router` on the workstation (RTX 2060 SUPER, 8 GB).
- On Ollama Cloud, `kimi-k3:cloud` and `gpt-oss:120b` returned valid strict JSON 3/3 in earlier prod probes.
- The model is fixed for every arm and recorded.

**Sample size** (PREREG §8): **314 paired test tasks** for the primary E − A non-inferiority test.
- Margin −5 pp, one-sided α 0.025, power 0.80, discordant rate 0.10.
- 157 at a discordant rate of 0.05; 628 at 0.20.

**Runs and budget** (estimates, not measurements):

| block | runs |
|---|---|
| natural, all 800 tasks × arms A–E | 4,000 |
| macro faults, 100 test tasks × 6 faults × C/D/E | 1,800 |
| executor faults, 100 × 2 × B–E | 800 |
| **total** | **6,600** |

| estimate | value | basis |
|---|---|---|
| tokens per run | ≈ 11 k | ≈ 4.5 steps × ≈ 2.5 k context re-sent per step; the paper reports 3.6–11.3 k mean tokens per task on similar toy fixtures |
| total tokens | ≈ 73 M (plausible range 40–100 M) | 6,600 runs × ≈ 11 k |
| wall time, workstation GPU | ≈ 80–90 h single-stream (~10 s per step) | estimate |

A cheaper first readout is the primary block alone: 314 test tasks × 5 arms = 1,570 runs, ≈ 17 M tokens, ≈ 20 h on the workstation.

## 9. Per hypothesis

All five hypotheses are INCONCLUSIVE for their effect claims, as pre-registered for a mechanism pilot. What the pilot shows for each:

- **H1 (no fixed granularity dominates): INCONCLUSIVE.**
  - The direction is as hypothesised, by construction:
    - micro-only beats macro-only on the mismatch families (C − B: 0 vs 8 discordant, p = 0.0078);
    - macro is cheaper where it fits (slug 6 vs 9 units, clamp 4 vs 6).
  - With scripted plans this restates the fixture design. It is not evidence.
- **H2 (routing without recovery is non-inferior to micro-only): NOT SUPPORTED in the pilot (mechanism finding).**
  - D is clearly worse than B: −0.40 [−0.60, −0.13].
  - The reason is structural, not tuning. Decision-time features can see whether a contract *applies* (a file exists, a lane, a single target). They cannot see whether the agent's *arguments* will satisfy the preconditions (a stale find text, a user change, a wrong expectation). Those failures appear only at CHECK_PRECONDITIONS or VERIFY.
  - Routing to macros is only safe together with recovery. Learned routing (arm F) would not fix this: by the leakage rule it may not see the arguments' outcome either.
- **H3 (verify-before-recovery): mechanism CONFIRMED in the pilot, effect INCONCLUSIVE.**
  - E recovered every recoverable failure D left unresolved: 6/6 natural, 11/11 for each of precondition mismatch, partial change and invalid schema, and 8/8 timeouts.
  - On every late fault E did no micro recovery and cost exactly what D cost (10/10, 6/6, 10/10 units, within the 10 % bound).
  - Never-recoverable classes were never recovered: policy, permission, concurrent execution, lease loss (`asg-executor.test.ts`).
- **H4 (safety invariants): 0 violations in B–E over 1,350 runs.**
  - Checked: writes outside the capability, micro detour after STOP, repeated procedure without reconciliation, budget overrun, lost user change, action while locked, duplicate re-execution.
  - Arm A (today's path) has 6 violations: `config` ×2 variants ×3 repetitions, each writing `package.json`. In production such a write would meet only the later diff/scope gates and the checker. No runtime adapter has a per-action allow-list (§6).
  - This is the one hypothesis a pilot can test. Its scope is the 15 fixtures and 8 fault kinds; it is not a proof for real runtimes.
- **H5 (trace-derived macros generalise to unseen families): INCONCLUSIVE, uninformative here.**
  - Macro-only verified 5/7 on train families and 0/4 on test families.
  - The test families are a deliberate argument mismatch (money) and a two-target task (pair), so this measures the fixtures, not generalisation.
  - No macro was promoted: all three remain `candidate`. Routing, retries and recoveries were never counted as evolution.
- **Primary (E vs A, cost per verified):**
  - Success difference 0.00 [−0.15, 0.15]; cost ratio 1.06 [0.70, 1.47].
  - In a model-backed run this pattern would fail the pre-registered "relevant saving" criterion (upper bound must be < 0.80). On these fixtures the cost of recovering mismatched macros cancels the saving on fitting ones.
  - From scripted units it is INCONCLUSIVE.

## 10. Deviations and defects found

No deviation from the pre-registration in the analysis. Disclosed:

- **Repetitions.** The pilot ran 3 repetitions; the analysis uses repetition 1 as pre-registered. The other two are identical (deterministic), which is reported in §7.
- **Debugging before the recorded run.** The harness was debugged on throwaway runs in the scratchpad before the recorded run at `0189c373`. Three defects were found that way and fixed before the code commit. None of them changed a pre-registered rule.
  1. **Compensation undid correct work.** After a late exception, the first version restored the pre-image and deleted a correct test file (D and C on `after_completion` failed the oracle). Now compensation runs only when the end state does not verify.
  2. **A resumed attempt re-routed and re-checked preconditions** against its own effects (after a crash, `test_absent` failed because the macro had written the file). Now a resumed attempt keeps its recorded decision and base, finds its write-ahead record and reconciles from the workspace.
  3. **Old test passed for new work.** End-state verification accepted an untouched declared file whose old (weak) test passed (`clamp-v2`, timeout before any effect). Now every declared write must have changed from the base. A regression test exists (`asg-executor.test.ts`).
- **Prod trace frequency query denied.** The query that would confirm the macro frequencies (`trace-mine.js`) was denied by the session's permission classifier as a production read. It was not worked around. The macro choice rests on `MAKER_FAILURES.md` (§3).

## 11. Rollback

- Unset `ASG_MODE` (or set `off`) and restart. Nothing else is needed.
  - `off` runs no ASG code.
  - Records already written under `metadata.asg` and `asg_route` events are inert history.
- To remove the code: revert the PR's commits. There is no migration, no table and no new scheduler.
