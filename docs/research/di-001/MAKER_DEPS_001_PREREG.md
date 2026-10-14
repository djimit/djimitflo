# MAKER-DEPS-001 v1: pre-registration

**Status:** pre-registered before any arm is assigned. The implementation ships in a later commit with `MAKER_DEPS_001_MODE` off by default. This file's sha256 is in `MAKER_DEPS_001_PREREG.sha256`.

**Question:** does preparing a local opencode maker's worktree dependencies *before* the maker starts change verified completion?

**Origin:** `MAKER_FAILURES.md`. 15.36 M (33 %) of failed opencode makers' provider-reported tokens went to dependency-bootstrap steps inside the tool loop. 21 of 22 token-brake leases show this.

**Status of the global flag:** the operator decided this must be a randomised experiment. `LOOP_MAKER_PREPARE_DEPS` (the global flag of the first #839 commit) is withdrawn.

## 1. Units, eligibility, assignment

- **Unit:** the goal. Every run, retry and evolve sibling of a goal lands in the goal's arm, and the goal is the cluster for every CI.
- **Eligible:** a maker lease where all of the following hold:
  - runtime `opencode`, role `maker`;
  - the run has a `goal_id`;
  - the run's `loop_name` is neither `tg-001` (TG-001) nor `evolution-gym`;
  - `MAKER_DEPS_001_MODE=on`.
- **Not eligible, untouched:**
  - remote makers, which run on the compute host's own checkout;
  - gym and TG-001 paths (`remote-gym-service.ts`, `gym-worker.mjs`, `tg-001.ts`);
  - mock and manual runtimes;
  - every other runtime.
- **Arm:** parity of the first 8 hex digits of `sha256('maker-deps-001:' + goal_id)`.
  - Even = **A** (existing behaviour); odd = **B** (dependency preparation).
  - The salt is distinct from those of ACE-001 (`ace-001:`), STE-001 (`ste-001:`), X1 (`effort-x1:`) and F2 (`checker-family:`).
  - A test checks independence on 4 000 synthetic goal ids: each 2×2 cross-tab with those arms has χ² p > 0.001, and each arm share is within 0.45–0.55.
- **Record (immutable, before the maker starts):**
  - one `maker_deps_arm` loop event per maker lease, with `{experiment: 'MAKER-DEPS-001', version: 'v1', arm, goal_id, maker_lease_id}`;
  - the same object under `metadata.maker_deps_001` on the lease, written only if absent.
  - A lease that already has an arm keeps it, even if the code changes.

## 2. Treatment

- **A:** today's behaviour. The maker starts in the worktree as it is; the prompt still says to `npm ci` if `node_modules` is missing.
- **B:** before the maker starts, the daemon runs **the identical command the deterministic checks already run**, `npm ci --legacy-peer-deps --no-audit --no-fund`.
  - It runs only when the worktree has a lockfile and no `node_modules`.
  - It then runs `npm run build --workspace=@djimitflo/shared`, only when `packages/shared/dist/index.js` is missing. This is the build `test:changed` runs first.
- **Not `--ignore-scripts`:** the checks do not use it. npm 12 already blocks dependency install scripts by default, so the maker's environment equals the checks' environment.
- **Provenance recorded** (event `maker_worktree_prepared`, B only):
  - lockfile sha256, `npm --version` and the exact command;
  - install exit status and duration;
  - shared-build exit status and duration.
- **Supply chain:**
  - The only integrity control is the lockfile. `npm ci` installs exactly the lockfile with its integrity hashes.
  - No registry, mirror or package is added, and nothing is approved (no `install-scripts approve`).
- **Failure:** an install or build failure is recorded with a warning. The arm stays B, intent-to-treat, and the maker runs as in A.
- **Same in both arms:**
  - prompt and template text (so the STE-001 and ACE-001 arms are untouched);
  - `OPENCODE_MAX_RUN_TOKENS`, the maker timeout and the diff limits;
  - gates, checkers and the scope gate.
- **Wall time:** B's install runs before the maker's own clock (`makerStartedAt`) and outside its timeout. The extra wall time is part of the treatment and is reported (secondary 5).

## 3. Endpoints

**Primary (intent-to-treat by goal):** the verified completion rate.
- **Numerator:** goals whose proposal reaches `verified`.
- **Denominator:** assigned goals whose proposal reached a terminal status: `verified`, `regressed`, `infra_failed`, `no_change`, `needs_more_evidence` or `archived`.
- **Comparison:** B − A, with a cluster bootstrap 95 % CI (resampling goals, 10 000 draws, seed 20261014).

**Secondary:**
1. **Build success:** the share of B preparations with install exit 0 and shared build ok (or not needed).
2. **Dependency-related failure rate:** maker leases per arm that ran `npm ci`, `npm install-scripts`, `npm rebuild`, `apt-get` or a shared build inside the tool loop, or that hit a startup error (`ERR_MODULE_NOT_FOUND`, `Failed to resolve entry for package "@djimitflo/shared"`). The classifier is the one in `MAKER_FAILURES.md` §3.
3. **Regression rate:** goals settled `regressed`, divided by terminal goals.
4. **Token brake and timeout rate per maker lease.**
5. **Duration:** maker runtime seconds and run wall seconds, including B's preparation.
6. **Tokens/compute:** provider-reported tokens per maker lease and per verified goal, plus env-step tokens. Remote and other tokens are UNKNOWN and are not imputed.
7. **Human intervention:** operator approvals, requeues and cancels per goal.
8. **14-day merge survival** of the draft PRs per arm, settled survival only.

Every secondary is reported with n. Any figure with fewer than 20 per arm is labelled INSUFFICIENT.

## 4. Sample size and stopping

- **Base rate** (prod, after #716, 10-09..10-14):
  - 33 of 42 eligible goals verified, **p₀ = 0.786**;
  - about 9.2 eligible goals per day.
- **Target n:** **141 goals per arm** (282 in total). This detects +12 pp (0.786 → 0.906) with two-sided α = 0.05 and power 0.80 (two-proportion normal approximation). At the current rate that is about 31 days.
- **Not powered to detect:**
  - +10 pp would need 215 per arm;
  - +15 pp would need 83 per arm.
- **Interim looks:** weekly, **for harm only**. Stop and switch the mode off if, with ≥ 30 terminal goals per arm, any of these holds:
  - (a) **regression guardrail:** B's regression rate exceeds A's by more than 10 pp with one-sided Fisher p < 0.01;
  - (b) B's verified rate is below A's by more than 15 pp with one-sided Fisher p < 0.01;
  - (c) any B lease has a stored failure_reason or gate result that differs from what the maker produced. This is audited and is impossible by construction.
- **No efficacy early stop:** reaching the target is the only stop for efficacy.
- **Operational stop (not an outcome):** more than 20 % of B preparations fail after 20 preparations. That is an environment defect: fix it, then restart under v2.
- **No automatic promotion:**
  - The result is analysed once, at the target n, with exactly this file.
  - Adopting B for everyone is a separate operator decision and a new change.
  - Nothing in code reads the result.

## 5. Analysis rules

- **ITT:** a goal is analysed in its assigned arm, whether or not B's preparation succeeded or was needed.
- **Pre-specified subgroups:** lane (mutation / test-gap / other), and the STE-001 and ACE-001 arms (stratified, not tested). They are descriptive only.
- **Excluded from the primary:** goals still running at analysis are listed as censored and not imputed.
- **Missing data:** missing tokens stay UNKNOWN. Reviewer and environment failures are never counted as maker failures or the reverse; this is the `MAKER_FAILURES.md` owner rule.
- **Evidence:** `evolution-evidence.maker_deps_001` reports the per-arm counts while collecting. It shows interim differences as descriptive only and sets `status` to `analysable` once both arms reach 141.
