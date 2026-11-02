# DI-001: failed and cancelled maker leases

**Status:** diagnosis complete; the fix for the dominant non-gate cause is built as the pre-registered randomised experiment MAKER-DEPS-001 v1 (`MAKER_DEPS_001_MODE=on`, default off; §6).
**Window:** 2026-09-14 .. 2026-10-14 07:33Z (prod `djimitflo-live`, read-only better-sqlite3 plus the lease stdout/stderr files; no app code ran in the container).
**Same method as** `REVIEWER_NO_VERDICT.md`: every lease is classified from its own stdout/stderr/metadata; missing outcomes stay UNKNOWN; reviewer, environment and orchestration failures are never relabelled as maker failures.

**Population:** `worker_leases` with role `maker` and status `failed` or `cancelled`, created in the window: **213 leases** on 171 runs.

| runtime | failed | cancelled |
|---|---|---|
| opencode | 94 | 30 |
| remote (workstation/atomic@llama-router) | 56 | 16 |
| atomic (local) | 15 | 1 |
| manual | 1 | 0 |

**7-day reconciliation (created ≥ 10-07):** opencode 23 failed / 2 cancelled, remote 21 failed. This matches the operator's numbers exactly.

**Fix cut-offs.** A fix counts from its *deploy*, not its merge. The deploy time is the mtime of `/srv/djimitflo/compose.yml.bak-<sha>`.

| fix | merged | deployed (era boundary) |
|---|---|---|
| #609 one-line remote/atomic prompt (931ad4b) | 10-03 22:50Z | **10-03 23:22Z** |
| #687 every failed lease names its reason (via 271790c) | 10-07 19:01Z | 10-07 19:45Z |
| #699 remote timeout from claim + cancel reasons (7be1d4d) | 10-08 12:19Z | **10-08 12:48Z** |
| #716 reviewer budget/parser (with 3eebe3b) | 10-09 17:31Z | **10-09 18:06Z** |

The eras are `pre609`, `609-699`, `699-716` and `post716`.

**Token accounting.**
- **Provider-reported** (opencode `step_finish.tokens`): `runtime_usage.total_tokens` equals the sum of the step totals, as in the reviewer doc. Each step re-sends its context, so most of the total is cache-read: a 1.0 M brake lease has about 70 k input, 6 k output and 0.93 M cache read (8625224a).
- **Estimated:** never used here. `token_accounting.measurement_source` exists only on 1 lease (#818 shipped 10-14).
- **UNKNOWN:**
  - remote, atomic and manual makers report no tokens (72 + 16 + 1 leases);
  - 14 opencode failed leases have no stdout (before 09-25, or failed before the runtime ran);
  - all 30 opencode cancelled leases have no stdout recorded. For 2 of them the execution task message carries the brake total (1.04 M and 1.02 M). Those 2 are counted with `tokSrc = task_message(brake)`.
- **Duplicate accounting:** none. A retry or evolve sibling is its own lease and session.

## 1. Classification (all 213)

Counts per era. Tokens are the provider-reported total over the leases where it is known (known/leases). **env tok** is the subset of those tokens spent in *environment-bootstrap steps*, defined in §3.

| class | pre609 | 609-699 | 699-716 | post716 | total | tokens (known/leases) | env tok |
|---|---|---|---|---|---|---|---|
| manual_runtime | 1 | 0 | 0 | 0 | **1** | UNKNOWN (0/1) | 0.00 M |
| cancelled | 39 | 6 | 2 | 0 | **47** | 2.05 M (2/47) | 0.00 M |
| opencode_exit1_no_steps | 13 | 0 | 0 | 0 | **13** | UNKNOWN (0/13) | 0.00 M |
| checks_failed | 12 | 12 | 4 | 1 | **29** | 2.92 M (7/29) | 1.04 M |
| opencode_permission_denied_verification | 3 | 0 | 0 | 0 | **3** | 1.73 M (2/3) | 0.41 M |
| opencode_wall_timeout | 7 | 7 | 2 | 4 | **20** | 11.54 M (19/20) | 2.65 M |
| token_efficiency_gate | 14 | 0 | 0 | 0 | **14** | 5.73 M (14/14) | 2.11 M |
| opencode_token_brake | 9 | 2 | 5 | 6 | **22** | 22.97 M (22/22) | 8.24 M |
| infra_atomic_confirm_hang | 15 | 0 | 0 | 0 | **15** | UNKNOWN (0/15) | 0.00 M |
| infra_remote_base_not_on_origin | 17 | 0 | 0 | 0 | **17** | UNKNOWN (0/17) | 0.00 M |
| diff_over_limit | 6 | 0 | 0 | 0 | **6** | 3.28 M (6/6) | 0.90 M |
| infra_worktree_missing | 2 | 3 | 0 | 0 | **5** | UNKNOWN (0/5) | 0.00 M |
| infra_remote_timeout | 0 | 15 | 1 | 5 | **21** | UNKNOWN (0/21) | 0.00 M |
| **total** | 138 | 45 | 14 | 16 | **213** | **50.21 M** (72/213 known) | **15.36 M** |

**Owner** (column in the per-lease table) separates the causes:
- `maker+env`: the runtime ran the model, and the environment contributed.
- `gate`: a gate rejected the work and did its job.
- `maker_quality(gate)`: a check failed on the maker's change.
- `infra`, `env(permission rules)`, `orchestration`: not the maker.
- `UNKNOWN`: the evidence cannot separate maker from environment.

**Class definitions (verified from stderr/stdout/metadata):**

- **opencode_token_brake (22, 22.97 M).**
  - **Evidence:** stderr is `OpenCode token budget exceeded: N > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)`. Totals are 1.00–1.14 M, killed mid tool-loop (finish `tool-calls`, or `stop` on the step that crossed the cap).
  - **Recorded as:** `failure_reason` reads `maker_gate_failed:maker_runtime_exit_zero`, because the brake surfaces as runtime exit 1, not as the `token_budget` gate.
  - **Sub-reason:** 21 of 22 show environment bootstrap (sub `env_bootstrap`). The 22nd (29de65a9, 09-26) has no stdout.
- **opencode_wall_timeout (20, 11.54 M).**
  - **Evidence:** `OpenCode execution timed out after 300000/600000ms`.
  - **Sub-reason:** 19 of 20 show env bootstrap, and 13 of those also ran Stryker inside the maker loop (mutation lane). The 20th (3e487680, 09-24) has no stdout.
- **token_efficiency_gate (14, 5.73 M), a gate doing its job.**
  - **Evidence:** the post-run `token_budget` gate (tokens per diff line) failed on an exit-0 run.
  - **Sub-reason:** 2 of them had no change at all (45–47 k tokens, 3 steps).
  - **When:** the last one was on 10-01; none since.
- **diff_over_limit (6, 3.28 M), a gate doing its job.**
  - **Evidence:** 207–412 lines against a 200-line limit, the last on 09-30 (Y0a #557 raised test-only changes to 400 on 10-01).
  - **Status:** real oversize changes; **not touched**.
- **checks_failed (29; 2.92 M on 7 of 29).** The deterministic checks failed after the maker exited 0. Before #687 this was filed as `unspecified: caller supplied no reason`; the check list on the lease names the failure.
  - **mutation_gain_not_met (12):** `test:mutation:grounded` exit 1, the oracle gate doing its job.
  - **test:changed fail (8):** the maker's test fails (maker quality).
  - **test_timed_out (4, UNKNOWN maker vs env):** the check hit its timeout.
  - **tool_missing_exit127 (3, infra):** lint/type-check could not find their tool. 09-28, 10-03, 10-06.
  - **lint (1) and type-check (1).**
- **cancelled (47, orchestration; tokens UNKNOWN except 2):**
  - **evolve sibling cancelled when a winner was chosen, or when the sibling needed approval** (`LOOP_WORKER_APPROVAL_REQUIRED`, `LOOP_WORKER_EXECUTION_IN_PROGRESS`): 28;
  - **run cancelled before the maker started:** 11;
  - **sibling never ran:** 3;
  - **ran, then timed out and was cancelled:** 5.
  - **Date:** 39 of the 47 are before #609.
- **infra_remote_timeout (21, 0 reported tokens).**
  - **Before #699 (15):** `remote maker timed out after 1800000 ms (claimed|queued)`.
  - **After #699 (6):**
    - `remote_maker_cancelled:work_timeout`, claimed but not finished in 1 800 s: 3;
    - `queue_timeout`, not claimed in 2 700 s: 3, all three on 10-12 within 75 min.
  - **Outcome:** 11 of the 21 runs had another maker complete, and 5 runs were verified (via the opencode sibling).
- **infra_remote_base_not_on_origin (17, 09-27..10-01):** `infra: base commit is not on origin/main, the remote host cannot fetch it`, 0 s. No recurrence after 10-01.
- **infra_atomic_confirm_hang (15, 09-27..10-01):** a local `atomic` maker stopped on a command preview (`preview: npx vitest run … | affects: …`) until the 600 s timeout. No local atomic maker failed after 10-01.
- **opencode_exit1_no_steps (13):** exit 1 in ≤ 5 s with 0 steps.
  - **9 (09-25..27):** model `kimi-k2.6:cloud`, stderr `Process exited with code 1`; the provider or model was unavailable.
  - **4 (09-21):** no stdout or stderr at all.
  - Both groups are infra; no recurrence.
- **infra_worktree_missing (5, 09-28 and 10-05):** `maker_execution_error: ENOENT … stat '/data/loop-worktrees/…'`. The worktree directory was gone when the maker started; the window does not show why (cause UNKNOWN), and there is no recurrence after 10-05.
- **opencode_permission_denied_verification (3, 09-23..10-02, 1.73 M):** `verification failed: bash: vitest verification: The user has specified a rule which prevents…` The opencode permission ruleset denied the verification command.
- **manual_runtime (1):** `MANUAL_MAKER_REQUIRES_HUMAN`.

Classes that do **not** occur:
- **Output truncation:** finish reason `length` appears 0 times.
- **Missing dependencies reported as exit 127 by the maker runtime:** 0. Exit 127 only appears in the *checks* (3 cases).

## 2. Pre/post the known fixes

- **#609 (10-03 23:22Z):** remote makers now get the assignment as one line.
  - `infra_remote_base_not_on_origin` and the local `atomic` hang stopped by 10-01, before #609. They do not recur, but #609 is not what fixed them; the window does not show the cause of that change.
  - After #609 the remote failure mode moves to wall-clock timeouts: 15 between 10-03 and 10-08, all 1 800 s.
- **#699 (10-08 12:48Z):**
  - remote timeouts now carry a reason and count from the claim;
  - 6 remote timeouts after it: 3 `work_timeout`, 3 `queue_timeout`.
  - The rate falls from 15 in 4.6 d to 6 in 5.8 d.
  - These are host capacity, and remote makers report no tokens.
- **#716 (10-09 18:06Z):** a reviewer fix; it does not change makers.
  - The maker failure profile is unchanged after it: post716 has 6 brakes (6.24 M), 4 timeouts (2.26 M), 5 remote timeouts and 1 check failure.
  - **The maker-side equivalent of #716's cause (spending the tool loop on installs and re-runs) is still present. It is the cause below.**

## 3. Dominant cause: environment bootstrap inside the maker's tool loop

**What every brake/timeout trace shows.**
- **The starting worktree:** each opencode maker starts in a worktree with no `node_modules` and no `packages/shared/dist`. Each deploy mounts a fresh clone, and the runtime image's `/app/node_modules` is production-only.
- **The prompt:** it says `Install dependencies with npm ci --legacy-peer-deps if node_modules is missing`.
- **The runtime:** the container runs **npm 12.0.2**, which blocks dependency install scripts by default.

So the maker runs into this sequence, verbatim from the stdout of 0328565b (10-08), 6f7e8aec (10-13) and 8625224a (10-14):

1. The test fails at startup: `Cannot find package 'vite'` / `node_modules/.bin/vitest: No such file`.
2. It runs `npm ci --legacy-peer-deps`, which succeeds but prints `npm warn install-scripts 2 packages had install scripts blocked … better-sqlite3@13.0.3 (install: node-gyp rebuild), esbuild`.
3. It runs `npm install-scripts approve better-sqlite3`.
   - This **edits package.json** (`allowScripts`): 22 failed leases carry `package.json` in `changed_files`, an out-of-scope change.
   - On the next `npm ci` it then triggers a `node-gyp rebuild`, which fails because the image has no `make`.
4. `which make`, `apt-get install build-essential` (permission denied), `sudo` (not found), `npm rebuild`, `npm_config_build_from_source=false npm ci`, `npm ci --ignore-scripts`, and reading the npm debug logs.
   - The prebuilt binary works without any of this (`node -e "require('better-sqlite3')"` → OK after `--ignore-scripts`).
5. `Failed to resolve entry for package "@djimitflo/shared"`, then `npm run build:shared` (missing script), then `cd packages/shared && npm run build`.

Each of these steps re-sends the 35–50 k context, so 10–15 bootstrap steps cost 0.4–0.6 M. That is half of the 1.0 M brake.

**Attribution rule (conservative).**
- A step counts as environment bootstrap only when **every** tool call in it is an install/rebuild/approve/apt/`which`/`ls node_modules`/shared-build command, or a test run whose output is a missing-package or startup error.
- Its provider-reported step total is the env tokens.
- Reads, edits and real test runs are never counted.

| | failed opencode (94) | completed opencode (132) |
|---|---|---|
| tokens with stdout | 47.14 M (80 leases) | 50.03 M (113) |
| env-bootstrap step tokens | **15.36 M (33 %)**, 67 leases | 14.87 M (30 %) |
| conservative (minus one probe step per lease) | **13.32 M** | — |
| ran `npm install-scripts approve` | 29 | 16 |

**Post-#716 (4.56 d):**
- **Failed:** 10 failed opencode makers spent 8.51 M; 3.36 M of it was bootstrap (2.98 M conservative).
- **Completed:** 32 completed makers spent 17.41 M, of which 5.44 M was bootstrap.
- **`install-scripts approve`:** 9 of the 10 failures ran it, against 4 of the 32 successes (hypergeometric P = 1.4 × 10⁻⁵).

**Is the brake doing its job?** Partly.
- **The cap is right:** it stops runaways and is **not touched**.
- **But the work was often done:**
  - in 24 of 40 brake/timeout leases with stdout, the maker's **last test run had passed** before it was killed;
  - 21 of the 22 brake leases would have stayed under 1.0 M without their bootstrap steps (estimate: it assumes the remaining steps unchanged);
  - 12 of the 19 timeouts would have finished their recorded work inside the limit without bootstrap wall time (same caveat).
- **The rest is real maker tool-loop cost:** Stryker re-runs inside the maker on the mutation lane (23 of 42 brake/timeout leases are mutation-lane) and repeated verification. That is not addressed here.

**Run outcome despite the failure (evolve):**

| failure | leases | run verified via another maker |
|---|---|---|
| brake | 22 | 3 |
| timeout | 20 | 1 |
| remote timeout | 21 | 5 |
| checks failed | 29 | 8 |

## 4. Verified avoidable tokens per cause (30 d)

"Verified avoidable" means provider-reported tokens spent in the classified leases that the intervention provably would not have spent. Probabilistic recoveries are not counted.

| cause | leases | tokens spent (known) | verified avoidable | notes |
|---|---|---|---|---|
| env bootstrap in failed opencode makers (spread over brake / timeout / gates / checks) | 67 | 15.36 M of 47.14 M | **13.32–15.36 M** | the bootstrap steps themselves; conservative bound keeps one probe step per lease |
| token brake (rest of the run) | 22 | 22.97 M | 0 verified | 21/22 under the cap without bootstrap (estimate); the cap stays |
| wall timeout (rest of the run) | 20 | 11.54 M | 0 verified | Stryker inside the maker on 13; see intervention 3 |
| token-efficiency gate | 14 | 5.73 M | 0 (gate doing its job) | last on 10-01 |
| diff over limit | 6 | 3.28 M | 0 (gate doing its job) | last on 09-30 |
| checks failed | 29 | 2.92 M (7/29) | 0 (gate / maker quality; 4 UNKNOWN) | 3 infra exit-127 |
| permission-denied verification | 3 | 1.73 M | 0.41 M bootstrap only | none since 10-02 |
| cancelled | 47 | 2.05 M (2/47) | UNKNOWN | cancelled leases record no usage |
| remote timeouts / base-not-on-origin / atomic hang / provider exit | 66 | 0 reported | UNKNOWN (no usage from remote/atomic) | wall clock: 21 × 1 800–2 700 s remote |

## 5. Interventions ranked

| # | intervention | verified avoidable | cost / risk | status |
|---|---|---|---|---|
| 1 | **install worktree dependencies before a local maker starts** (the same `npm ci` the checks already run, plus the `@djimitflo/shared` build that `test:changed` runs first) | **13.3–15.4 M on failed makers / 30 d.** 14.9 M more on completed makers. | install time before the maker; maker timeout and caps unchanged; shifts the maker baseline of running experiments equally in every arm | **built** as MAKER-DEPS-001 (randomised, mode off) |
| 2 | stop `npm install-scripts approve` from editing package.json (follows from #1: nothing is blocked once installed) | the 22 package.json out-of-scope edits | — | covered by #1 |
| 3 | mutation-lane makers: no full Stryker inside the maker loop (the oracle check runs it anyway) | part of 11.54 M of timeouts, not separable from the stdout | changes the maker template (STE-001 / ACE-001 arms) | not built: experiment |
| 4 | remote capacity (work/queue timeouts) | 0 reported tokens; 21 × 30–45 min | host-side | not built (remote-gym-service / gym-worker are out of scope) |
| 5 | record usage on cancelled leases | makes 45 UNKNOWN measurable | — | recommendation |
| 6 | gates (token efficiency, diff, mutation gain) | 0 | — | doing their job; unchanged |

## 6. The fix: MAKER-DEPS-001 v1, a randomised experiment (`MAKER_DEPS_001_MODE=on`, default off)

**Operator decision:** dependency preparation is a randomised experiment, not a global switch. The global `LOOP_MAKER_PREPARE_DEPS` flag of the first commit is withdrawn.

The pre-registration is `MAKER_DEPS_001_PREREG.md`. It was committed alone, before any assignment code, and its sha256 is in `MAKER_DEPS_001_PREREG.sha256`.

**Assignment** (`maker-deps-001.ts`):
- **Arm:** the parity of `sha256('maker-deps-001:' + goal_id)`.
  - **A** = existing behaviour.
  - **B** = the daemon prepares dependencies before the maker starts.
  - The salt is orthogonal to ACE-001, STE-001, X1 and F2; a test checks this.
- **Eligible:** local `opencode` makers of goal runs only.
  - Never TG-001 (`loop_name` `tg-001`), the gym, or remote, mock, manual or other runtimes.
  - `tg-001.ts`, `remote-gym-service.ts` and `gym-worker.mjs` are unchanged.
- **Record:** made before the maker starts. It is one `maker_deps_arm` event plus `metadata.maker_deps_001` on the lease, holding `{experiment: 'MAKER-DEPS-001', version: 'v1', arm, goal_id, maker_lease_id}`.
  - The lease value is written only if absent.
  - A lease that already has an arm keeps it.

**Arm B** (`loop-service.ts` `prepareMakerWorktree`):
- **Install:** **the identical command the checks run**, `npm ci --legacy-peer-deps --no-audit --no-fund`, via the shared `WORKTREE_INSTALL_ARGS`. It runs only when there is a lockfile and no `node_modules`.
- **Build:** `npm run build --workspace=@djimitflo/shared`, only when `packages/shared/dist/index.js` is missing.
- **Event:** `maker_worktree_prepared` records:
  - provenance: lockfile sha256, `npm --version` and the command;
  - install and shared-build exit status and duration.
- **No `--ignore-scripts`:** the checks do not use it, and npm 12 already blocks install scripts.
- **Supply chain:** no registry is added and nothing is approved. Integrity rests on the lockfile.

**The same in both arms:**
- **Caps, gates and limits:** gates, `OPENCODE_MAX_RUN_TOKENS`, diff limits and the maker timeout. The install runs before `makerStartedAt` and outside the runtime timeout.
- **The prompt and template:** so the STE-001/ACE-001 arms and the genome template hash are unaffected.

**Failure handling:**
- **Install failure:** a warning event. The arm stays B (intent-to-treat), and the maker runs as in A.
- **Maker failure:** it stays a maker failure.
- **Mode unset:** behaviour is identical to today.

**Evidence:** `evolution-evidence.maker_deps_001` reports, per arm:
- goals, terminal, verified, regressed and censored;
- preparations and preparation failures;
- maker lease failures and timeouts, and mean tokens.

It also reports a descriptive cluster-bootstrap difference. Status is `collecting` until both arms reach 141 terminal goals. Nothing reads the result and nothing is promoted automatically.

**Tests** (`maker-deps-001.test.ts`):
- **Real shape:** a fake npm 12.0.2 replays the "install scripts blocked" output of 0328565b.
- **Arm B:**
  - the arm is recorded before the engine is called;
  - npm calls are exactly `--version`, the checks' `ci` command and the shared build;
  - provenance is recorded.
- **Arm A:** no npm calls.
- **Mode off:** nothing happens.
- **Immutable arm:** an arm already on the lease is kept.
- **Failure handling:**
  - an install failure leaves the arm recorded, the gates unchanged and no failure reason;
  - the brake reason stays the same.
- **Never assigned:** TG-001 runs, evolution-gym runs, remote makers and goal-less runs get no arm.
- **Independence:** 4 000 synthetic goals against ACE-001 r/s, STE-001, X1 and F2, χ² < 10.83.
- **Evidence:** ITT counts.

**Expected effect (estimate, labelled).**
- **Post-#716 rate:** bootstrap steps cost 3.36 M in failed and 5.44 M in completed makers over 4.56 d.
- **Projection:** that is about **22 M / 30 d on failed makers** (19.6 M conservative) if all makers were prepared, and about 58 M / 30 d over all opencode makers. Under the experiment only arm B (≈ 50 %) gets the saving.
- **Upper bound:** a prepared maker may still probe once or twice.
- **Outcome effect:** UNKNOWN until the pre-registered analysis (141 goals/arm).

## 7. Per-lease table (213)

Columns:
- **tok:** lease total, provider-reported (`runtime_stdout`) or UNKNOWN.
- **env tok:** bootstrap-step tokens (§3).
- **dur:** execution-task seconds.
- **tmo:** maker timeout in seconds.
- **relation:** retry, evolve-sibling and superseded links.
- **outcome:** the proposal status; `(verified)` means the run was still verified through another maker.

| # | lease | run | runtime | model | lane | when (UTC) | era | class / sub | owner | tok | src | steps | env tok | dur s | tmo s | diff | relation | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0b37cf04 | 328cca40 | manual | UNKNOWN | UNKNOWN | 09-20 22:44 | pre609 | manual_runtime | orchestration | UNKNOWN | UNKNOWN | - | - | - | - | - | - | UNKNOWN |
| 2 | 8dd5fc71 | 1aae80f5 | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 02:07 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 3 | 0465facb | f69ed444 | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 09:46 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | archived |
| 4 | 47784da7 | 819d9ad4 | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 15:11 | pre609 | opencode_exit1_no_steps / model UNKNOWN | infra(provider/runtime) | UNKNOWN | UNKNOWN | - | 0 | 1 | 300 | 0/200 | - | regressed |
| 5 | de89729e | 0720e771 | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 17:26 | pre609 | opencode_exit1_no_steps / model UNKNOWN | infra(provider/runtime) | UNKNOWN | UNKNOWN | - | 0 | 3 | 300 | 0/200 | - | UNKNOWN |
| 6 | 880b20df | 0c44ca4e | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 17:49 | pre609 | opencode_exit1_no_steps / model UNKNOWN | infra(provider/runtime) | UNKNOWN | UNKNOWN | - | 0 | 2 | 300 | 0/200 | - | UNKNOWN |
| 7 | 46738793 | a8d2f3a3 | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 17:56 | pre609 | opencode_exit1_no_steps / model UNKNOWN | infra(provider/runtime) | UNKNOWN | UNKNOWN | - | 0 | 2 | 300 | 0/200 | - | UNKNOWN |
| 8 | 4baf35b5 | f063d1ed | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 17:58 | pre609 | checks_failed / test_timed_out | UNKNOWN(maker_or_env) | UNKNOWN | UNKNOWN | - | 0 | 86 | 300 | 35/200 | superseded_by bfce943f | UNKNOWN |
| 9 | bfce943f | f063d1ed | opencode | UNKNOWN | Add one unit test to packages/ | 09-21 18:08 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 99 | 300 | - | retry_of 4baf35b5 | UNKNOWN |
| 10 | 79b6cafd | 32dc22c1 | opencode | UNKNOWN | Canary import and instantiatio | 09-22 00:34 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | archived |
| 11 | 5a00b49c | 5501723f | opencode | UNKNOWN | Add unit tests for services/se | 09-23 22:02 | pre609 | opencode_permission_denied_verification | env(permission rules) | UNKNOWN | UNKNOWN | - | 0 | 161 | 300 | 91/200 | - | UNKNOWN |
| 12 | 69f4e9cf | 57b6e1c6 | opencode | UNKNOWN | Add unit tests for services/pr | 09-23 22:02 | pre609 | checks_failed / type-check | maker_quality(gate) | UNKNOWN | UNKNOWN | - | 0 | 78 | 300 | 158/200 | superseded_by 941ab62d | UNKNOWN |
| 13 | 941ab62d | 57b6e1c6 | opencode | UNKNOWN | Add unit tests for services/pr | 09-23 22:18 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 67 | 300 | - | retry_of 69f4e9cf | UNKNOWN |
| 14 | 8d04b545 | 3978a793 | opencode | UNKNOWN | Investigate: Root cause of tsc | 09-23 23:12 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 15 | afa39525 | e0a6cf48 | opencode | UNKNOWN | Add unit tests for services/se | 09-23 23:23 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 16 | ae3074c2 | 3a231045 | opencode | UNKNOWN | Add unit tests for services/pr | 09-23 23:23 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 17 | 3e487680 | 714daca7 | opencode | UNKNOWN | Investigate: Root cause of tsc | 09-24 20:19 | pre609 | opencode_wall_timeout / no_env_bootstrap | maker+env | UNKNOWN | UNKNOWN | - | 0 | 300 | 300 | 0/200 | - | regressed |
| 18 | 17c59f26 | 84bc044b | opencode | UNKNOWN | Add unit tests for services/ex | 09-25 04:23 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 19 | d99a6f92 | 4c11f3f5 | opencode | UNKNOWN | Add unit tests for services/sw | 09-25 04:23 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | - | UNKNOWN |
| 20 | 7b50dbf0 | 0efa622c | opencode | UNKNOWN | mutation | 09-25 09:57 | pre609 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 1948533 | runtime_stdout | 49 | 419986 | 300 | 300 | 276/200 | - | UNKNOWN |
| 21 | faca84d8 | ca2afb21 | opencode | kimi-k2.6:cloud | mutation | 09-25 14:01 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | 0 | 2 | 600 | - | retry_of 2f825aa8; superseded_by 2f825aa8 | verified (verified) |
| 22 | 1ad1c479 | b8829b0a | opencode | kimi-k2.6:cloud | mutation | 09-25 15:29 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 43 | 600 | - | retry_of b2679d35; superseded_by b2679d35 | verified (verified) |
| 23 | e339aed3 | 6971829e | opencode | UNKNOWN | Evolution gym: make packages/s | 09-25 17:52 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 324760 | runtime_stdout | 18 | 207858 | 144 | 600 | 23/200 | - | UNKNOWN |
| 24 | f3720911 | 370d1df9 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-25 18:52 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 600 | - | - | UNKNOWN |
| 25 | e9cf79c5 | c5a06654 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-25 19:02 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 26 | 29de65a9 | ca69e463 | opencode | UNKNOWN | Verify testability and coverag | 09-26 09:59 | pre609 | opencode_token_brake / no_env_bootstrap | maker+env | 1022845 | task_message(brake) | - | 0 | 218 | 300 | - | - | archived |
| 27 | 0771aff2 | 95e2aa68 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-26 21:33 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 28 | 6270fa9b | fb6123a2 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-26 21:52 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 29 | f16af735 | cc7e3586 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-26 22:42 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 30 | 6e40efd1 | ffdf7dc6 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-26 23:09 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 31 | d526a80e | 9a1aa48d | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-26 23:59 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 32 | 279d31de | d0d94c25 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-27 00:28 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 33 | b12477df | 2da56a23 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-27 01:24 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 2 | 600 | 0/200 | - | UNKNOWN |
| 34 | 1c948a68 | 58328994 | opencode | kimi-k2.6:cloud | Evolution gym: make packages/s | 09-27 02:14 | pre609 | opencode_exit1_no_steps / ollama/kimi-k2.6:cloud | infra(provider/runtime) | UNKNOWN | UNKNOWN | 0 | 0 | 3 | 600 | 0/200 | - | UNKNOWN |
| 35 | 93c58f55 | 9680b935 | opencode | kimi-k3:cloud | UNKNOWN | 09-27 02:25 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | - | - | - | UNKNOWN |
| 36 | ea0ed6ec | 0f90f3f7 | atomic | UNKNOWN | UNKNOWN | 09-27 03:02 | pre609 | cancelled / run_cancelled_before_start | orchestration | UNKNOWN | UNKNOWN | - | - | - | - | - | - | UNKNOWN |
| 37 | a582abe5 | 95a3b643 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-27 03:38 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 261737 | runtime_stdout | 15 | 82338 | 78 | 600 | 15/200 | - | UNKNOWN |
| 38 | 59f55d95 | 1b6ce499 | opencode | kimi-k3:cloud | Evolution gym: make packages/s | 09-27 04:16 | pre609 | cancelled / ran_then_cancelled:timeout | orchestration | UNKNOWN | UNKNOWN | - | 0 | 600 | 600 | - | - | UNKNOWN |
| 39 | 7358a539 | 52d48c48 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-27 10:36 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 40 | 94153fbf | 0a503ede | opencode | UNKNOWN | mutation | 09-27 10:37 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1133623 | runtime_stdout | 48 | 328761 | 372 | 600 | 13/400 | superseded_by b69c4994 | archived |
| 41 | 1f84f8f0 | 1894dae5 | opencode | kimi-k3:cloud | Add unit tests for services/co | 09-27 10:40 | pre609 | opencode_wall_timeout / env_bootstrap | maker+env | 417723 | runtime_stdout | 19 | 85700 | 300 | 300 | 150/200 | retry_of f0d42eed; superseded_by f0d42eed | verified (verified) |
| 42 | b69c4994 | 0a503ede | opencode | kimi-k3:cloud | mutation | 09-27 10:43 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1026440 | runtime_stdout | 39 | 161202 | 385 | 600 | 104/400 | retry_of 94153fbf | archived |
| 43 | 5afb7373 | e1b5ce04 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-27 11:29 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 44 | dad8e2b2 | c6569d50 | opencode | UNKNOWN | Add unit tests for services/ag | 09-27 11:35 | pre609 | diff_over_limit | gate | 640512 | runtime_stdout | 14 | 161475 | 96 | 300 | 223/200 | superseded_by e19e86af | archived |
| 45 | 7030fd03 | 4185a44d | remote | workstation/atomic@llama-router | Add unit tests for services/au | 09-27 11:38 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | - | 770 | 300 | - | retry_of 87ef7fa6; superseded_by 68cb8543 | regressed |
| 46 | 3400616a | c6569d50 | opencode | kimi-k3:cloud | Add unit tests for services/ag | 09-27 11:38 | pre609 | diff_over_limit | gate | 606119 | runtime_stdout | 22 | 45771 | 145 | 300 | 211/200 | retry_of dad8e2b2 | archived |
| 47 | e19e86af | c6569d50 | remote | workstation/atomic@llama-router | Add unit tests for services/ag | 09-27 11:40 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | - | 1545 | 300 | - | retry_of dad8e2b2 | archived |
| 48 | c0f3c7ee | 8b4d8126 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-27 12:19 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 49 | a2795353 | b494a4aa | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-27 12:33 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 50 | 308f6c1d | 6087f91a | atomic | UNKNOWN | Evolution gym: make packages/s | 09-27 13:23 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 51 | ee6854f9 | c6688fbf | opencode | kimi-k3:cloud | Evolution gym: make packages/s | 09-27 13:56 | pre609 | cancelled / ran_then_cancelled:timeout | orchestration | UNKNOWN | UNKNOWN | - | 0 | 600 | 600 | - | - | UNKNOWN |
| 52 | d0307486 | 046705b1 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-27 14:56 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 258550 | runtime_stdout | 15 | 83996 | 78 | 600 | 37/200 | - | UNKNOWN |
| 53 | 24887e9c | 3b3455dc | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-28 03:55 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 54 | 115d4fdf | 41a818dc | atomic | UNKNOWN | Evolution gym: make packages/s | 09-28 04:55 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 55 | 02aa89eb | 9679857b | opencode | kimi-k3:cloud | Evolution gym: make packages/s | 09-28 05:55 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 433273 | runtime_stdout | 21 | 255080 | 101 | 600 | 14/200 | - | UNKNOWN |
| 56 | eea7819e | 3c515e42 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-28 06:55 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 57 | c335a120 | 689ebb80 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-28 07:55 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 58 | 503d3a2b | 6d1d62f3 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-28 08:15 | pre609 | token_efficiency_gate / no_change | gate | 47012 | runtime_stdout | 3 | 16604 | 15 | 600 | 0/200 | - | UNKNOWN |
| 59 | e5854eb6 | fbbe8eb6 | opencode | UNKNOWN | Add unit tests for services/re | 09-28 11:36 | pre609 | diff_over_limit | gate | 306876 | runtime_stdout | 13 | 99038 | 122 | 300 | 412/200 | superseded_by 63f31ba5 | regressed |
| 60 | 01a37d84 | 5e75951a | opencode | UNKNOWN | mutation | 09-28 11:36 | pre609 | checks_failed / tool_missing_exit127 | infra | 30977 | runtime_stdout | 2 | 0 | 9 | 300 | 0/200 | superseded_by ff8d99fa | regressed |
| 61 | 8aac13ca | 5e75951a | opencode | UNKNOWN | mutation | 09-28 12:03 | pre609 | cancelled / ran_then_cancelled:brake;sibling_approval_required | orchestration | 1036062 | task_message(brake) | - | 0 | 191 | 300 | - | retry_of 01a37d84 | regressed |
| 62 | 7605d37e | 5e75951a | opencode | kimi-k3:cloud | mutation | 09-28 12:03 | pre609 | cancelled / ran_then_cancelled:brake;sibling_approval_required | orchestration | 1015748 | task_message(brake) | - | 0 | 244 | 300 | - | retry_of 01a37d84 | regressed |
| 63 | ff8d99fa | 5e75951a | remote | workstation/atomic@llama-router | mutation | 09-28 12:03 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 475 | 300 | - | retry_of 01a37d84 | regressed |
| 64 | 81dd3d05 | fbbe8eb6 | opencode | kimi-k3:cloud | Add unit tests for services/re | 09-28 12:43 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | 0 | 181 | 300 | - | retry_of e5854eb6 | regressed |
| 65 | 63f31ba5 | fbbe8eb6 | remote | workstation/atomic@llama-router | Add unit tests for services/re | 09-28 12:43 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 868 | 300 | - | retry_of e5854eb6 | regressed |
| 66 | acf5908a | 1cc0f8d3 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-28 14:19 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 67 | 52db7424 | 18c2faad | atomic | UNKNOWN | Evolution gym: make packages/s | 09-28 14:35 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 68 | 15944dfa | a221f30b | opencode | UNKNOWN | Add unit tests for services/sw | 09-28 14:42 | pre609 | infra_worktree_missing | infra | UNKNOWN | UNKNOWN | - | 0 | 220 | 300 | - | - | archived |
| 69 | 6709fb14 | ac23dd05 | opencode | UNKNOWN | Add unit tests for services/ex | 09-28 14:42 | pre609 | infra_worktree_missing | infra | UNKNOWN | UNKNOWN | - | 0 | 113 | 300 | - | - | archived |
| 70 | 81cf0a04 | bcd96bf9 | opencode | kimi-k3:cloud | Evolution gym: make packages/s | 09-28 15:20 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 774372 | runtime_stdout | 32 | 295408 | 165 | 600 | 66/200 | - | UNKNOWN |
| 71 | 5a2d5c99 | 84774da4 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-28 16:10 | pre609 | token_efficiency_gate / no_change | gate | 45060 | runtime_stdout | 3 | 0 | 12 | 600 | 0/200 | - | UNKNOWN |
| 72 | bdfa1f6b | fd8dd709 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 06:33 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 73 | 0fc275d9 | 0055ad9b | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 07:02 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 74 | 87b5ee6d | fcb89c4b | atomic | UNKNOWN | Evolution gym: make packages/s | 09-29 07:33 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 75 | 0fc80b9d | d3e72879 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-29 08:23 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 76 | 360af05c | 033e44bb | opencode | UNKNOWN | Evolution gym: make packages/s | 09-29 08:55 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 588412 | runtime_stdout | 19 | 122288 | 162 | 600 | 33/200 | - | UNKNOWN |
| 77 | 6e45f08b | 973d1972 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 09:45 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 78 | 57e458bc | 0516652f | atomic | UNKNOWN | Evolution gym: make packages/s | 09-29 10:45 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 79 | c24dd8c5 | 11ea0bc6 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-29 11:45 | pre609 | cancelled / ran_then_cancelled:timeout | orchestration | UNKNOWN | UNKNOWN | - | 0 | 600 | 600 | - | - | UNKNOWN |
| 80 | de8ee8be | 7951ce7b | opencode | UNKNOWN | mutation | 09-29 11:45 | pre609 | diff_over_limit | gate | 483228 | runtime_stdout | 14 | 128069 | 84 | 300 | 249/200 | superseded_by eb712b4e | regressed |
| 81 | eb712b4e | 7951ce7b | remote | workstation/atomic@llama-router | mutation | 09-29 12:39 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1220 | 300 | - | retry_of de8ee8be | regressed |
| 82 | fb626951 | f2f86c35 | remote | workstation/atomic@llama-router | Add unit tests for services/re | 09-29 12:40 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 392 | 300 | - | retry_of a4e1acbd; superseded_by a4e1acbd | verified (verified) |
| 83 | 4f160bd1 | 1d65c4c4 | opencode | UNKNOWN | Add unit tests for services/in | 09-29 14:45 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1063305 | runtime_stdout | 23 | 626419 | 229 | 300 | 361/200 | superseded_by 9e9ffecb | infra_failed |
| 84 | 441ee30c | 47c74a32 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 15:45 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 85 | 08511faf | 8c6169bd | remote | workstation/atomic@llama-router | Add unit tests for services/sw | 09-29 16:41 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1804 | 300 | - | retry_of 6b521b78; superseded_by 6b521b78 | regressed |
| 86 | 9e9ffecb | 1d65c4c4 | remote | workstation/atomic@llama-router | Add unit tests for services/in | 09-29 16:41 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 945 | 300 | - | retry_of 4f160bd1 | infra_failed |
| 87 | ad67b5a2 | 437f4b22 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-29 17:35 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 88 | 068e8fd2 | ae8b0fef | opencode | UNKNOWN | mutation | 09-29 17:41 | pre609 | opencode_permission_denied_verification | env(permission rules) | 947018 | runtime_stdout | 28 | 249834 | 270 | 600 | 37/400 | superseded_by 85e3d279 | infra_failed |
| 89 | eb9cb8a7 | e7c2bbde | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 18:25 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 90 | 85e3d279 | ae8b0fef | remote | workstation/atomic@llama-router | mutation | 09-29 18:34 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1458 | 600 | - | retry_of 068e8fd2 | infra_failed |
| 91 | 63efd755 | 886d33aa | opencode | UNKNOWN | Evolution gym: make packages/s | 09-29 19:25 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 312869 | runtime_stdout | 15 | 189721 | 106 | 600 | 26/200 | - | UNKNOWN |
| 92 | 9dda36e7 | a136bf2b | atomic | UNKNOWN | Evolution gym: make packages/s | 09-29 20:25 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 93 | 5102ba30 | df16fb60 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-29 20:54 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 94 | 111faf72 | 964ea0d3 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-29 21:44 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 452384 | runtime_stdout | 19 | 114892 | 87 | 600 | 45/200 | - | UNKNOWN |
| 95 | 2dbd0ad1 | 8abf0d66 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-30 09:18 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 96 | 164665b3 | 839cd41b | atomic | UNKNOWN | Evolution gym: make packages/s | 09-30 10:26 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 97 | 88870610 | cec4b866 | opencode | UNKNOWN | Evolution gym: make packages/s | 09-30 11:16 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 324200 | runtime_stdout | 16 | 61617 | 75 | 600 | 60/200 | - | UNKNOWN |
| 98 | 3152f4e4 | 7470a906 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-30 12:16 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 99 | 85ddae89 | f5688ed7 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-30 13:16 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 100 | f9ed15ec | f934d77a | opencode | UNKNOWN | Evolution gym: make packages/s | 09-30 14:16 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1026094 | runtime_stdout | 19 | 371871 | 114 | 600 | 59/200 | - | UNKNOWN |
| 101 | c59adfbd | bbbf76a5 | opencode | UNKNOWN | Add unit tests for services/kn | 09-30 16:17 | pre609 | diff_over_limit | gate | 396429 | runtime_stdout | 11 | 159567 | 96 | 300 | 207/200 | superseded_by eb5386b9 | regressed |
| 102 | 132d1ff0 | 239cd6ce | opencode | UNKNOWN | Add unit tests for services/us | 09-30 16:17 | pre609 | diff_over_limit | gate | 844489 | runtime_stdout | 22 | 306049 | 206 | 300 | 335/200 | superseded_by 2e52c338 | regressed |
| 103 | eb5386b9 | bbbf76a5 | remote | workstation/atomic@llama-router | Add unit tests for services/kn | 09-30 18:29 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1275 | 300 | - | retry_of c59adfbd | regressed |
| 104 | 2e52c338 | 239cd6ce | remote | workstation/atomic@llama-router | Add unit tests for services/us | 09-30 18:31 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 171 | 300 | - | retry_of 132d1ff0 | regressed |
| 105 | 590d47a2 | 7c36e291 | remote | workstation/atomic@llama-router | Add unit tests for services/sw | 09-30 19:27 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1327 | 300 | - | retry_of ce3343b8; superseded_by ce3343b8 | verified (verified) |
| 106 | 30e41d24 | 389afa3d | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-30 20:16 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 107 | 3056c7b4 | 8d464b84 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-30 20:57 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 108 | ca27581d | b538833e | opencode | UNKNOWN | Add unit tests for services/re | 09-30 21:03 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1025720 | runtime_stdout | 20 | 274763 | 148 | 300 | 295/200 | superseded_by 34a98ada | infra_failed |
| 109 | 34a98ada | b538833e | remote | workstation/atomic@llama-router | Add unit tests for services/re | 09-30 21:18 | pre609 | cancelled / ran_then_cancelled;sibling_approval_required | orchestration | UNKNOWN | UNKNOWN | - | - | 1095 | 300 | - | retry_of ca27581d | infra_failed |
| 110 | 740b9607 | 8902f05d | opencode | UNKNOWN | Evolution gym: make packages/s | 09-30 21:47 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 615622 | runtime_stdout | 31 | 252311 | 253 | 600 | 21/200 | - | UNKNOWN |
| 111 | 2598f209 | 18d82596 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 09-30 22:49 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 112 | d89e05fd | 65a5de87 | atomic | UNKNOWN | Evolution gym: make packages/s | 09-30 23:39 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 113 | 87848d7c | fb6fa217 | opencode | UNKNOWN | Evolution gym: make packages/s | 10-01 00:10 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 906871 | runtime_stdout | 23 | 211457 | 292 | 600 | 37/200 | - | UNKNOWN |
| 114 | 1a614e83 | eff053a0 | remote | workstation/atomic@llama-router | Evolution gym: make packages/s | 10-01 11:36 | pre609 | infra_remote_base_not_on_origin | infra | UNKNOWN | UNKNOWN | - | - | 0 | 600 | 0/200 | - | UNKNOWN |
| 115 | 7c6c593a | 10b292e5 | atomic | UNKNOWN | Evolution gym: make packages/s | 10-01 12:36 | pre609 | infra_atomic_confirm_hang / stuck_on_command_preview | infra | UNKNOWN | UNKNOWN | - | - | 601 | 600 | 0/200 | - | UNKNOWN |
| 116 | 86a1fbc7 | c83bf2b7 | opencode | UNKNOWN | Evolution gym: make packages/s | 10-01 13:20 | pre609 | token_efficiency_gate / tokens_per_diff_line | gate | 388996 | runtime_stdout | 19 | 218687 | 141 | 600 | 26/200 | - | UNKNOWN |
| 117 | d6fbad9a | 62f4314f | opencode | UNKNOWN | mutation | 10-01 14:46 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1003741 | runtime_stdout | 41 | 281035 | 527 | 600 | 89/400 | superseded_by de71c945 | no_change |
| 118 | de71c945 | 62f4314f | opencode | UNKNOWN | mutation | 10-01 15:13 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | 0 | 0 | 355 | 600 | 0/400 | retry_of d6fbad9a | no_change |
| 119 | cfb0d2f0 | a4013c56 | opencode | UNKNOWN | test-gap | 10-01 18:00 | pre609 | cancelled / evolve_sibling_never_ran | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 300 | - | retry_of da0706e9 | needs_more_evidence |
| 120 | 149f203c | b808ea6a | opencode | UNKNOWN | mutation | 10-01 18:07 | pre609 | cancelled / evolve_sibling_never_ran | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 600 | - | retry_of 148e7e53 | needs_more_evidence |
| 121 | e4455a40 | 4b5a6e14 | opencode | UNKNOWN | mutation | 10-01 18:43 | pre609 | cancelled / evolve_sibling_never_ran | orchestration | UNKNOWN | UNKNOWN | - | 0 | - | 600 | - | retry_of 70d931d8 | needs_more_evidence |
| 122 | 62fd1ad9 | 8176c00a | opencode | workstation/atomic@llama-router | mutation | 10-01 22:28 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | 0 | 0 | 623 | 600 | 26/400 | superseded_by 024a1716 | needs_more_evidence |
| 123 | 01e9d358 | 8176c00a | opencode | glm-5.2:cloud | mutation | 10-01 22:39 | pre609 | cancelled / ran_then_cancelled:timeout | orchestration | UNKNOWN | UNKNOWN | - | 0 | 600 | 600 | - | retry_of 62fd1ad9 | needs_more_evidence |
| 124 | 024a1716 | 8176c00a | remote | workstation/atomic@llama-router | mutation | 10-01 22:39 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 810 | 600 | 26/400 | retry_of 62fd1ad9 | needs_more_evidence |
| 125 | 4cd33349 | 3d7dbc93 | opencode | glm-5.2:cloud | test-gap | 10-02 19:51 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1139525 | runtime_stdout | 22 | 412765 | 147 | 300 | 108/400 | superseded_by 420d9a0c | infra_failed |
| 126 | 10708729 | 8e237bd7 | opencode | glm-5.2:cloud | mutation | 10-02 19:51 | pre609 | opencode_permission_denied_verification | env(permission rules) | 782424 | runtime_stdout | 28 | 164216 | 347 | 600 | 68/400 | superseded_by f185a2a6 | infra_failed |
| 127 | f185a2a6 | 8e237bd7 | remote | workstation/atomic@llama-router | mutation | 10-02 19:57 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1706 | 600 | 26/400 | retry_of 10708729 | infra_failed |
| 128 | 9151410d | 09177464 | opencode | glm-5.2:cloud | mutation | 10-02 22:15 | pre609 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 416671 | runtime_stdout | 20 | 58778 | 600 | 600 | 69/400 | superseded_by f9b3efd0 | infra_failed |
| 129 | f9b3efd0 | 09177464 | remote | workstation/atomic@llama-router | mutation | 10-02 22:25 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1493 | 600 | 26/400 | retry_of 9151410d | infra_failed |
| 130 | 1513a344 | fab1f528 | remote | workstation/atomic@llama-router | mutation | 10-02 23:29 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1539 | 600 | 26/400 | retry_of b8dd4d11; superseded_by b8dd4d11 | verified (verified) |
| 131 | 2516c970 | 3398875b | opencode | glm-5.2:cloud | mutation | 10-03 05:11 | pre609 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 444545 | runtime_stdout | 23 | 119849 | 600 | 600 | 96/400 | superseded_by f9eebc99 | infra_failed |
| 132 | f9eebc99 | 3398875b | remote | workstation/atomic@llama-router | mutation | 10-03 05:21 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 360 | 600 | 26/400 | retry_of 2516c970 | infra_failed |
| 133 | ff1fc0e2 | 9af58f8e | opencode | glm-5.2:cloud | test-gap | 10-03 20:15 | pre609 | checks_failed / tool_missing_exit127 | infra | 698867 | runtime_stdout | 29 | 343835 | 152 | 300 | 75/400 | superseded_by c2eb6a5d | infra_failed |
| 134 | aceee509 | 9af58f8e | opencode | glm-5.2:cloud | test-gap | 10-03 20:18 | pre609 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 73 | 300 | - | retry_of ff1fc0e2 | infra_failed |
| 135 | bf59dccb | 19d43dfc | remote | workstation/atomic@llama-router | mutation | 10-03 20:21 | pre609 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 859 | 600 | 0/400 | retry_of 49fe4c4e; superseded_by 49fe4c4e | verified (verified) |
| 136 | 73752f21 | af5aae69 | opencode | glm-5.2:cloud | Fix: type-check failed (exit 1 | 10-03 20:31 | pre609 | opencode_wall_timeout / env_bootstrap | maker+env | 73002 | runtime_stdout | 5 | 29107 | 301 | 300 | 0/200 | - | infra_failed |
| 137 | e62cd9dd | 1cf157a0 | opencode | glm-5.2:cloud | Fix: lint failed (exit 127) fo | 10-03 20:31 | pre609 | opencode_wall_timeout / env_bootstrap | maker+env | 102473 | runtime_stdout | 7 | 42515 | 300 | 300 | 0/200 | - | infra_failed |
| 138 | 0894aec6 | faf4109d | opencode | glm-5.2:cloud | test-gap | 10-03 22:33 | pre609 | opencode_token_brake / env_bootstrap | maker+env | 1000116 | runtime_stdout | 32 | 190308 | 198 | 300 | 77/400 | superseded_by cd53b3b9 | regressed |
| 139 | 4b6c0852 | 88f94e53 | opencode | glm-5.2:cloud | test-gap | 10-03 23:37 | 609-699 | opencode_token_brake / env_bootstrap | maker+env | 1010843 | runtime_stdout | 33 | 129118 | 183 | 300 | 146/400 | superseded_by 361cddb0 | regressed |
| 140 | 6f2e870c | b35fa0c3 | remote | workstation/atomic@llama-router | test-gap | 10-03 23:39 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1273 | 300 | 79/400 | retry_of 8ab10f25; superseded_by 8ab10f25 | verified (verified) |
| 141 | 361cddb0 | 88f94e53 | remote | workstation/atomic@llama-router | test-gap | 10-03 23:40 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1804 | 300 | 0/200 | retry_of 4b6c0852 | regressed |
| 142 | c5b2bded | 5eccf722 | remote | workstation/atomic@llama-router | mutation | 10-03 23:42 | 609-699 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 1802 | 600 | 0/400 | retry_of 40a2dc4f; superseded_by 40a2dc4f | regressed |
| 143 | 29bcaf2d | e2d0c4b4 | opencode | glm-5.2:cloud | mutation | 10-04 22:05 | 609-699 | opencode_token_brake / env_bootstrap | maker+env | 1006703 | runtime_stdout | 39 | 116802 | 279 | 600 | 152/400 | superseded_by e40b56cf | regressed |
| 144 | 5e2d77ff | 75d301b9 | remote | workstation/atomic@llama-router | test-gap | 10-04 22:08 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1029 | 300 | 121/400 | retry_of e4a56526; superseded_by e4a56526 | verified (verified) |
| 145 | e40b56cf | e2d0c4b4 | remote | workstation/atomic@llama-router | mutation | 10-04 22:10 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1800 | 600 | 0/400 | retry_of 29bcaf2d | regressed |
| 146 | df2e80ce | 443160d4 | opencode | glm-5.2:cloud | Add unit tests for agent-catal | 10-05 01:31 | 609-699 | infra_worktree_missing | infra | UNKNOWN | UNKNOWN | - | 0 | 234 | 300 | - | - | needs_more_evidence |
| 147 | 95682d02 | 6fc483b5 | opencode | glm-5.2:cloud | Add unit tests for mcp-server/ | 10-05 01:31 | 609-699 | infra_worktree_missing | infra | UNKNOWN | UNKNOWN | - | 0 | 134 | 300 | - | - | needs_more_evidence |
| 148 | bb234dd3 | 1d761e4e | opencode | glm-5.2:cloud | Add unit tests for mcp-server/ | 10-05 01:31 | 609-699 | infra_worktree_missing | infra | UNKNOWN | UNKNOWN | - | 0 | 111 | 300 | - | - | needs_more_evidence |
| 149 | a544b068 | 1210788b | opencode | glm-5.2:cloud | mutation | 10-05 01:32 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 902536 | runtime_stdout | 34 | 111482 | 600 | 600 | 178/400 | superseded_by 62da0547 | infra_failed |
| 150 | 62da0547 | 1210788b | remote | workstation/atomic@llama-router | mutation | 10-05 01:42 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 864 | 600 | 208/400 | retry_of a544b068 | infra_failed |
| 151 | 690a7b09 | b97d6604 | opencode | glm-5.2:cloud | mutation | 10-05 02:13 | 609-699 | checks_failed / test_timed_out | UNKNOWN(maker_or_env) | 472042 | runtime_stdout | 24 | 189804 | 98 | 600 | 182/400 | superseded_by 3d702623 | regressed |
| 152 | b982f7ed | b97d6604 | opencode | glm-5.2:cloud | mutation | 10-05 02:20 | 609-699 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 239 | 600 | - | retry_of 690a7b09 | regressed |
| 153 | 3d702623 | b97d6604 | remote | workstation/atomic@llama-router | mutation | 10-05 02:20 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1804 | 600 | 0/400 | retry_of 690a7b09 | regressed |
| 154 | 51263766 | b7384207 | remote | workstation/atomic@llama-router | mutation | 10-05 09:18 | 609-699 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1409 | 600 | 0/400 | retry_of 4dd443b1; superseded_by 4dd443b1 | regressed |
| 155 | e9121cdf | 67330883 | remote | workstation/atomic@llama-router | Add unit tests for agent-catal | 10-05 23:30 | 609-699 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | - | 0 | 300 | - | retry_of e57b9ea8 | regressed |
| 156 | f2820847 | d85d8df6 | remote | workstation/atomic@llama-router | Add unit tests for mcp-server/ | 10-05 23:30 | 609-699 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | - | 0 | 300 | - | retry_of 62b2fb0f | regressed |
| 157 | 1e0e5465 | b651f4bf | remote | workstation/atomic@llama-router | Add unit tests for mcp-server/ | 10-05 23:31 | 609-699 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | - | 0 | 300 | - | retry_of 75f6c17f | regressed |
| 158 | 9550d8a7 | 222551cc | remote | workstation/atomic@llama-router | mutation | 10-06 02:52 | 609-699 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1277 | 600 | 0/400 | retry_of 646c433f; superseded_by 646c433f | verified (verified) |
| 159 | e6296e72 | 428f6db8 | remote | workstation/atomic@llama-router | mutation | 10-06 03:40 | 609-699 | checks_failed / test:changed+lint | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 887 | 600 | 169/400 | retry_of 6aa4acca; superseded_by 6aa4acca | verified (verified) |
| 160 | 00cbfd36 | 4418f34d | opencode | glm-5.2:cloud | test-gap | 10-06 07:46 | 609-699 | checks_failed / tool_missing_exit127 | infra | 116063 | runtime_stdout | 7 | 33468 | 88 | 300 | 71/400 | superseded_by ba1665ff | regressed |
| 161 | a18242ef | f946abbf | opencode | glm-5.2:cloud | test-gap | 10-06 07:46 | 609-699 | checks_failed / lint | maker_quality(gate) | 322965 | runtime_stdout | 15 | 67174 | 106 | 300 | 99/400 | superseded_by 801f7b4f | regressed |
| 162 | aff754eb | 4418f34d | opencode | glm-5.2:cloud | test-gap | 10-06 07:48 | 609-699 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 60 | 300 | - | retry_of 00cbfd36 | regressed |
| 163 | c953c4d3 | f946abbf | opencode | glm-5.2:cloud | test-gap | 10-06 07:48 | 609-699 | cancelled / ran_then_cancelled:timeout | orchestration | UNKNOWN | UNKNOWN | - | 0 | 300 | 300 | - | retry_of a18242ef | regressed |
| 164 | 801f7b4f | f946abbf | remote | workstation/atomic@llama-router | test-gap | 10-06 07:48 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1801 | 300 | 0/200 | retry_of a18242ef | regressed |
| 165 | 31ea4dbd | b30d3189 | opencode | glm-5.2:cloud | Fix: type-check failed (exit 1 | 10-06 08:02 | 609-699 | opencode_wall_timeout / env_bootstrap | maker+env | 130334 | runtime_stdout | 9 | 42297 | 300 | 300 | 0/200 | - | infra_failed |
| 166 | bbd80643 | fa51af1f | opencode | glm-5.2:cloud | mutation | 10-06 10:31 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 836280 | runtime_stdout | 27 | 170286 | 600 | 600 | 246/400 | superseded_by 045e66a2 | infra_failed |
| 167 | 045e66a2 | fa51af1f | remote | workstation/atomic@llama-router | mutation | 10-06 10:41 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1803 | 600 | 0/400 | retry_of bbd80643 | infra_failed |
| 168 | 36ed81d8 | 040dcae9 | opencode | glm-5.2:cloud | mutation | 10-07 04:44 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 528606 | runtime_stdout | 24 | 117640 | 605 | 600 | 8/400 | superseded_by d6f4b244 | infra_failed |
| 169 | 80487d0c | 7e9f66a5 | remote | workstation/atomic@llama-router | test-gap | 10-07 04:46 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1131 | 300 | 93/200 | retry_of b3b03216; superseded_by b3b03216 | verified (verified) |
| 170 | d6f4b244 | 040dcae9 | remote | workstation/atomic@llama-router | mutation | 10-07 04:54 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1803 | 600 | 0/400 | retry_of 36ed81d8 | infra_failed |
| 171 | 7f8593bb | 6d044c9e | remote | workstation/atomic@llama-router | test-gap | 10-07 10:46 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1832 | 300 | 0/200 | retry_of 6e9b0228; superseded_by 6e9b0228 | regressed |
| 172 | 241b5012 | 2bc0935c | remote | workstation/atomic@llama-router | test-gap | 10-07 10:47 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 732 | 300 | 75/400 | retry_of 97e1d072; superseded_by 97e1d072 | regressed |
| 173 | c55c7e48 | 5c0a3386 | remote | workstation/atomic@llama-router | mutation | 10-07 10:49 | 609-699 | checks_failed / test:changed | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1587 | 600 | 188/400 | retry_of df1f65d8; superseded_by df1f65d8 | verified (verified) |
| 174 | 5f867e2c | 1e224f65 | opencode | glm-5.2:cloud | mutation | 10-07 12:40 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 714255 | runtime_stdout | 30 | 120165 | 600 | 600 | 209/400 | superseded_by ee55176a | infra_failed |
| 175 | ee55176a | 1e224f65 | remote | workstation/atomic@llama-router | mutation | 10-07 12:50 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1802 | 600 | 0/400 | retry_of 5f867e2c | infra_failed |
| 176 | 45dcd11b | edf524de | opencode | glm-5.2:cloud | mutation | 10-07 18:27 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 795403 | runtime_stdout | 21 | 186567 | 600 | 600 | 241/400 | superseded_by 0f55f513 | regressed |
| 177 | 7f377833 | b980f01b | remote | workstation/atomic@llama-router | test-gap | 10-08 08:29 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1801 | 300 | 0/200 | retry_of 6f48302f; superseded_by 6f48302f | regressed |
| 178 | 3364d8d7 | 777bae79 | remote | workstation/atomic@llama-router | test-gap | 10-08 08:30 | 609-699 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 1804 | 300 | 0/200 | retry_of 87e4b310; superseded_by 87e4b310 | regressed |
| 179 | ac430fdf | 85bb0607 | remote | workstation/atomic@llama-router | mutation | 10-08 08:32 | 609-699 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 1805 | 600 | 0/400 | retry_of fa3e461c; superseded_by fa3e461c | regressed |
| 180 | 061793c6 | 5c549474 | opencode | glm-5.2:cloud | mutation | 10-08 11:18 | 609-699 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 578152 | runtime_stdout | 26 | 170079 | 600 | 600 | 14/400 | superseded_by 6bf5d779 | infra_failed |
| 181 | c0f69e0d | 3083115d | remote | workstation/atomic@llama-router | test-gap | 10-08 11:21 | 609-699 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1800 | 300 | 0/200 | retry_of 38efa59c; superseded_by 38efa59c | regressed |
| 182 | ea84cdf5 | fe3fa85b | remote | workstation/atomic@llama-router | test-gap | 10-08 11:22 | 609-699 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 1805 | 300 | 0/200 | retry_of 8a2a9c1b; superseded_by 8a2a9c1b | verified (verified) |
| 183 | 6bf5d779 | 5c549474 | remote | workstation/atomic@llama-router | mutation | 10-08 11:28 | 609-699 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 1803 | 600 | 0/400 | retry_of 061793c6 | infra_failed |
| 184 | 0328565b | b624e80d | opencode | glm-5.2:cloud | test-gap | 10-08 13:03 | 699-716 | opencode_token_brake / env_bootstrap | maker+env | 1024584 | runtime_stdout | 28 | 667201 | 191 | 300 | 13/200 | superseded_by b72974ee | verified (verified) |
| 185 | fd946901 | e645d26f | opencode | glm-5.2:cloud | mutation | 10-08 13:03 | 699-716 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 680912 | runtime_stdout | 24 | 185415 | 600 | 600 | 151/400 | superseded_by a00d33e1 | regressed |
| 186 | f22fb146 | 5c3a3fee | opencode | glm-5.2:cloud | mutation | 10-08 19:22 | 699-716 | opencode_token_brake / env_bootstrap | maker+env | 1027456 | runtime_stdout | 22 | 365205 | 356 | 600 | 36/400 | superseded_by 58023843 | regressed |
| 187 | 58023843 | 5c3a3fee | remote | workstation/atomic@llama-router | mutation | 10-08 19:28 | 699-716 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 1338 | 600 | 0/400 | retry_of f22fb146 | regressed |
| 188 | 7e8e3ace | 161f7840 | opencode | glm-5.2:cloud | mutation | 10-09 08:07 | 699-716 | checks_failed / test_timed_out | UNKNOWN(maker_or_env) | 637192 | runtime_stdout | 19 | 132331 | 284 | 600 | 179/400 | superseded_by ece52aeb | regressed |
| 189 | 0d02c81d | 3ee23cef | opencode | glm-5.2:cloud | mutation | 10-09 08:08 | 699-716 | opencode_token_brake / env_bootstrap | maker+env | 1038039 | runtime_stdout | 40 | 700219 | 545 | 600 | 113/400 | - | regressed |
| 190 | d2f624a8 | a57a6f4c | opencode | glm-5.2:cloud | mutation | 10-09 08:08 | 699-716 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 707376 | runtime_stdout | 29 | 176697 | 600 | 600 | 26/400 | superseded_by 4f762008 | infra_failed |
| 191 | ca215095 | 5b91e689 | opencode | glm-5.2:cloud | mutation | 10-09 08:08 | 699-716 | opencode_token_brake / env_bootstrap | maker+env | 1121092 | runtime_stdout | 28 | 495744 | 314 | 600 | 14/400 | superseded_by 28adfda4 | regressed |
| 192 | ab613c2b | 161f7840 | opencode | glm-5.2:cloud | mutation | 10-09 08:18 | 699-716 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 154 | 600 | - | retry_of 7e8e3ace | regressed |
| 193 | 4f762008 | a57a6f4c | remote | workstation/atomic@llama-router | mutation | 10-09 08:28 | 699-716 | checks_failed / test:changed+test:mutation:grounded | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 3181 | 600 | 255/400 | retry_of d2f624a8 | infra_failed |
| 194 | 2cfe2008 | cda88a02 | opencode | glm-5.2:cloud | test-gap | 10-09 13:08 | 699-716 | opencode_token_brake / env_bootstrap | maker+env | 1050785 | runtime_stdout | 24 | 373338 | 120 | 300 | 169/400 | - | regressed |
| 195 | c88706ed | 421b2fbf | opencode | glm-5.2:cloud | test-gap | 10-09 13:09 | 699-716 | checks_failed / test_timed_out | UNKNOWN(maker_or_env) | 638567 | runtime_stdout | 20 | 271644 | 134 | 300 | 97/200 | superseded_by 803e9ad5 | regressed |
| 196 | df634caf | 421b2fbf | opencode | glm-5.2:cloud | test-gap | 10-09 13:16 | 699-716 | cancelled / ran_then_cancelled | orchestration | UNKNOWN | UNKNOWN | - | 0 | 62 | 300 | - | retry_of c88706ed | regressed |
| 197 | 803e9ad5 | 421b2fbf | remote | workstation/atomic@llama-router | test-gap | 10-09 13:16 | 699-716 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1807 | 300 | 0/200 | retry_of c88706ed | regressed |
| 198 | 7ad82dd8 | 366d480b | opencode | glm-5.2:cloud | test-gap | 10-09 18:22 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1122167 | runtime_stdout | 25 | 483537 | 165 | 300 | 110/400 | - | regressed |
| 199 | 0ce0fadc | 0260f7e6 | opencode | glm-5.2:cloud | mutation | 10-10 15:49 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1023989 | runtime_stdout | 31 | 455496 | 505 | 600 | 39/400 | - | regressed |
| 200 | 71ea7ecc | bd962a2a | opencode | glm-5.2:cloud | mutation | 10-10 19:24 | post716 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 974380 | runtime_stdout | 24 | 113777 | 600 | 600 | 373/400 | superseded_by a578f33a | infra_failed |
| 201 | adef7ac9 | 40e931ce | remote | workstation/atomic@llama-router | test-gap | 10-10 19:26 | post716 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1939 | 300 | 0/200 | retry_of 03ea68e3; superseded_by 03ea68e3 | verified (verified) |
| 202 | a578f33a | bd962a2a | remote | workstation/atomic@llama-router | mutation | 10-10 19:34 | post716 | checks_failed / mutation_gain_not_met | maker_quality(gate) | UNKNOWN | UNKNOWN | - | - | 905 | 600 | 268/400 | retry_of 71ea7ecc | infra_failed |
| 203 | d8e73bc1 | e1f4a3ab | opencode | glm-5.2:cloud | test-gap | 10-12 16:54 | post716 | opencode_wall_timeout / env_bootstrap | maker+env | 582703 | runtime_stdout | 21 | 177186 | 300 | 300 | 151/400 | - | infra_failed |
| 204 | f181adfe | 55fa5dbf | opencode | glm-5.2:cloud | test-gap | 10-12 16:54 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1081351 | runtime_stdout | 27 | 211631 | 169 | 300 | 137/400 | - | regressed |
| 205 | 424cff9d | 78877a48 | opencode | glm-5.2:cloud | test-gap | 10-12 17:44 | post716 | opencode_wall_timeout / env_bootstrap | maker+env | 317214 | runtime_stdout | 11 | 192584 | 300 | 300 | 98/200 | superseded_by 32c4cf54 | infra_failed |
| 206 | 0bcf0953 | 00b04d07 | opencode | glm-5.2:cloud | mutation | 10-12 17:44 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1001357 | runtime_stdout | 18 | 277073 | 442 | 600 | 71/400 | - | regressed |
| 207 | 32c4cf54 | 78877a48 | remote | workstation/atomic@llama-router | test-gap | 10-12 17:49 | post716 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 2703 | 300 | 0/200 | retry_of 424cff9d | infra_failed |
| 208 | 9d5e6ae9 | 96c3a57d | remote | workstation/atomic@llama-router | test-gap | 10-12 19:00 | post716 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 2703 | 300 | 0/200 | retry_of 0bb5e4f6; superseded_by 0bb5e4f6 | verified (verified) |
| 209 | 033af793 | a72bc908 | remote | workstation/atomic@llama-router | mutation | 10-12 19:04 | post716 | infra_remote_timeout / queued_never_claimed | infra | UNKNOWN | UNKNOWN | - | - | 2702 | 600 | 0/400 | retry_of 3e92e281; superseded_by 3e92e281 | verified (verified) |
| 210 | 6e0e46cc | b1411c0e | opencode | glm-5.2:cloud | mutation | 10-12 20:06 | post716 | opencode_wall_timeout / env_bootstrap+stryker | maker+env | 388162 | runtime_stdout | 18 | 132476 | 600 | 600 | 0/400 | - | infra_failed |
| 211 | 6f7e8aec | a8f53a5a | opencode | glm-5.2:cloud | test-gap | 10-13 18:01 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1014509 | runtime_stdout | 24 | 567366 | 227 | 300 | 137/200 | superseded_by 83c56a4f | verified (verified) |
| 212 | 12c434c7 | 8e7a1d6f | remote | workstation/atomic@llama-router | test-gap | 10-13 18:04 | post716 | infra_remote_timeout / claimed_not_finished | infra | UNKNOWN | UNKNOWN | - | - | 1857 | 300 | 0/200 | retry_of 2df27db1; superseded_by 2df27db1 | verified (verified) |
| 213 | 8625224a | 69785628 | opencode | glm-5.2:cloud | mutation | 10-14 01:03 | post716 | opencode_token_brake / env_bootstrap | maker+env | 1001056 | runtime_stdout | 34 | 749656 | 138 | 600 | 26/400 | superseded_by 956a1c5d | verified (verified) |
