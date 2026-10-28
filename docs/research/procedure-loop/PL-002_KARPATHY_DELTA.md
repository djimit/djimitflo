# PL-002 — what an external coding-guideline set adds to the gym maker (delta review + pre-registration)

Status: **delta review plus a pre-registered protocol, frozen in the PR that adds this file** (2026-10-26). Nothing has been
executed: no runner, no manifest, no attempt, no flag. This is preparation, not results. Starting PL-002 is an operator
decision (see Start condition).

No production maker instruction changes. `MAKER_TEMPLATE_RULES`, `renderWorkAssignment` / `writeWorkAssignment` and the
SOUL/AGENTS text a maker sees stay byte-identical; STE-001, ACE-001, X1, F2 and MAKER-DEPS-001 run on that surface and are
not touched. The candidate lines below exist only in this document and its fingerprint test.

## Source

- Repository `multica-ai/andrej-karpathy-skills`, pinned at `2c606141936f1eeef17fa3043a72095b4765b9c2` (2026-04-20).
  `git ls-remote … HEAD` on 2026-10-26 returned the same sha: upstream has not moved on.
- Licence: MIT, declared in the README's licence section, in the skill file's front matter and in the plugin manifest.
  The tree at that commit has no LICENSE file and no copyright line.
- Read (not run): the skill file `skills/karpathy-guidelines/SKILL.md`, its copies (`CLAUDE.md`, the Cursor rule), the
  README and `EXAMPLES.md`. The clone was shallow, lived in a scratch directory and was deleted after reading.
- **No upstream text is copied into this repository.** Every principle below is restated in DjimitFlo's own words, and
  the candidate lines are new text. There is no licence or attribution obligation to carry.

## Surfaces (what a maker actually sees)

| Surface | Reaches | Source |
|---|---|---|
| S1 — repo doctrine | interactive coding agents in this repo (not gym makers) | `AGENTS.md`, `SOUL.md`, `CLAUDE.md` |
| S2 — production assignment | production makers (`LOOP_WORK.md`, flattened for remote makers) | `renderWorkAssignment`, `MAKER_TEMPLATE_RULES` (loop-service.ts:297-349) |
| S3 — gym goal | remote gym makers (atomic@llama-router) | `gymGoal` + `Strategy:` lines (scripts/gym-worker.mjs:77-82) |

The gym maker receives only S3: one line built by `oneLine(gymGoal(task, writeTest, lines))` (gym-worker.mjs:49, 77-82,
116-117), run with `atomic-agent run --cwd /w --max-steps 40 --no-approval` (gym-worker.mjs:590). S1 and S2 are evidence of
doctrine, not of delivery. All file:line references are to `origin/main` at `d088425f`.

## 1. Principle table

Classes: **ALREADY_PRESENT** (an instruction or a gate already says it), **USEFUL_DELTA** (missing on S3 and worth testing),
**CONFLICT** (clashes with a DjimitFlo rule: no merges/pushes, diff limits, single-file or test-only scope, headless
operation), **NOT_PROVEN** (no verifier and no evidence that it changes outcomes; not added).

Upstream groups, in our words: G1 reason before editing; G2 write the least code that solves the task; G3 keep edits narrow;
G4 turn the task into a verifiable goal.

| # | Upstream principle (paraphrased) | Class | Evidence in our files |
|---|---|---|---|
| 1 | G1: name the assumptions the work rests on before starting | USEFUL_DELTA → candidate line 1 | Absent from S3 (gym-worker.mjs:80-81) and S2 (loop-service.ts:300-304). S1 only as prose: "Blind edits before orientation — status: unverified (prose only)" (SOUL.md:50); "Orientation before edit — status: unverified" (SOUL.md:59); "Read the file's git history … before changing it" (AGENTS.md:60, interactive agents only). |
| 2 | G1: when unsure, ask the person instead of guessing | CONFLICT | The gym maker is headless with `--no-approval` (gym-worker.mjs:590); nobody answers. A clean early exit without a change is scored as a failure, "no change (maker gave up)" (gym-worker.mjs:100), and classed `UNDERSTANDING_FAILURE` (tg-001.ts:330-332, the #609 "what would you like me to do?" pattern). Asking is reserved for money, security boundaries, data deletion and new services (AGENTS.md:98), all outside a maker's mandate anyway (loop-service.ts:301). Adapted: line 1 says "confirm yourself". |
| 3 | G1: when a request has several readings, lay them out instead of choosing one silently | USEFUL_DELTA (adapted) → candidate line 2 | Nothing on S2/S3 tells a maker how to resolve an ambiguous reading. Laying options out for a person conflicts with headless operation (row 2), so the delta is the decision rule: choose the reversible, smallest reading inside the existing mandate ("Change only ${task.source}", gym-worker.mjs:80-81; "Minimal reversible change", SOUL.md:60). |
| 4 | G1: say so when a simpler route exists; push back when warranted | NOT_PROVEN | The gym maker has no channel to the task author; its only output is a diff judged by the oracle and gates (gym-worker.mjs:597-607). No evidence that pushback text changes a gated outcome. |
| 5 | G1: when confused, stop, name the confusion and ask | CONFLICT | Stopping is a scored failure (gym-worker.mjs:100) and asking has no addressee (row 2). |
| 6 | G2: build nothing beyond what was requested | ALREADY_PRESENT | "Change only ${task.source}" (gym-worker.mjs:80-81); any other file is `out of scope` (gym-worker.mjs:101-102); "Keep the diff small and local to the finding." (loop-service.ts:300); "Scope expansion after completion" anti-pattern (SOUL.md:55). |
| 7 | G2: no abstraction for code used once | ALREADY_PRESENT | "Prefer essence over abstraction" (SOUL.md:29); "Premature abstraction" (SOUL.md:46); "Do not add orchestration layers, agent abstractions …" (SOUL.md:72-73). S1 only; the S3 effect is bounded by the diff limit (row 10). |
| 8 | G2: no unrequested options or configuration | ALREADY_PRESENT | "… route config or scheduler state before an existing caller or test proves the need" (SOUL.md:72-73). |
| 9 | G2: no error handling for cases that cannot occur | NOT_PROVEN | Whether a case "cannot occur" is itself a material assumption (row 1). Our rules point the other way for unknown data: "Missing data is reported as `null` … never as zero" (AGENTS.md:90); "Keep runtime checks …" (SOUL.md:74). The PL-001 candidate even prefers a null guard (procedure-selector.ts:39). Not added. |
| 10 | G2: if a solution could be a quarter of its length, rewrite it shorter | CONFLICT | Line count is never a goal in its own right. The diff limit is a ceiling, not a target: 200 lines, 400 for a test-only change (remote-gym-service.ts:80-81, gym-worker.mjs:195-212); subtraction is "measured, not gated" (SOUL.md:38-39). A shrink-the-code instruction invites whole-function rewrites, which raise the diff and the out-of-intent risk. |
| 11 | G2: ask whether an experienced engineer would call it overcomplicated | NOT_PROVEN | A self-judgment with no verifier. "Simplicity compounds" is only partly enforced by the diff gate (SOUL.md:31). |
| 12 | G3: leave neighbouring code, comments and formatting alone | ALREADY_PRESENT | loop-service.ts:300; "Opportunistic refactoring" anti-pattern, partly gated (SOUL.md:52-53); diff limit (gym-worker.mjs:208-212). |
| 13 | G3: do not refactor what works | ALREADY_PRESENT | SOUL.md:52-53; loop-service.ts:300. |
| 14 | G3: follow the existing style even if you would write it differently | ALREADY_PRESENT | "Ignoring existing codebase conventions — partly enforced by lint and tsc" (SOUL.md:51); the gym's production gates run `lint` and `type-check` (remote-gym-service.ts:86). |
| 15 | G3: report unrelated dead code, do not delete it | ALREADY_PRESENT (deletion part) | Deleting in another file is `out of scope` (gym-worker.mjs:101-102); inside the file, loop-service.ts:300. The "report it" part has no channel on S3 (row 4). |
| 16 | G3: remove only the imports and helpers your own change orphaned | ALREADY_PRESENT | `noUnusedLocals` / `noUnusedParameters` (tsconfig.json:16-17), enforced by the `type-check` production gate (remote-gym-service.ts:86). |
| 17 | G3: keep pre-existing dead code unless asked | ALREADY_PRESENT | As row 15. |
| 18 | G3: every changed line must trace back to the request | ALREADY_PRESENT | File-level: out-of-scope verdict (gym-worker.mjs:101-102) and hack flags `tests_touched`, `ci_or_config_touched`, `readme_only` (gym-hack-classifier.ts:8, 18); size: diff limit. Line-level tracing is not enforced. |
| 19 | G4: restate the task as a concrete, checkable success condition before working | USEFUL_DELTA → candidate line 3 | The task already names its criterion: "make ${tests} pass" (gym-worker.mjs:81) or "make it pass with: … npx vitest run …" (gym-worker.mjs:80). What is missing is the maker stating that condition, and the single file that may differ, before its first edit. The marginal value is uncertain; that is what PL-002 measures. |
| 20 | G4: for a bug, the maker first writes a test that reproduces it | CONFLICT (on S3); ALREADY_PRESENT on S1 | A repair maker may not edit or add tests: "The tests describe the intended behaviour; do not edit them." (gym-worker.mjs:81); a new test file is `out of scope` (gym-worker.mjs:101-102) and flagged `tests_touched` (gym-hack-classifier.ts:8). For interactive agents it is the definition of done (AGENTS.md:84). |
| 21 | G4: the verification must really discriminate — it fails without the fix and passes with it; a wrong fix must not pass | USEFUL_DELTA for repair → candidate line 4; ALREADY_PRESENT for write_test | write_test: "precisely enough that a subtly broken ${task.target} makes the test fail" (gym-worker.mjs:80) and the seeded-mutant kill (gym-worker.mjs:604-605). Repair: the oracle only proves red-before (gym-worker.mjs:579) and green-after (gym-worker.mjs:597); nothing asks the maker whether a plausible wrong edit would also turn the test green. |
| 22 | G4: for a refactor, the tests pass before and after | ALREADY_PRESENT | Oracle before/after (gym-worker.mjs:579, 597); "Related suites pass" (AGENTS.md:85). |
| 23 | G4: for multi-step work, write a short plan with a verification per step | NOT_PROVEN | Gym tasks are single-file, single-goal; a plan is unverifiable text. The PL-001 candidate already covers "re-run the named test after each edit" (procedure-selector.ts:40) and is tested separately. |
| 24 | G4: iterate until the success condition is verified | ALREADY_PRESENT | "Run relevant deterministic checks before handing off to checker." (loop-service.ts:303); "Checker approval is required before completion." (loop-service.ts:304); the gym goal names the command to make green (gym-worker.mjs:80). |
| 25 | Trade-off: prefer care over speed; use judgment on trivial tasks | NOT_PROVEN | The budget is fixed (`--max-steps 40`, gym-worker.mjs:590). Care versus speed is an outcome to measure (tokens and time per correct task, below), not an instruction. |
| 26 | Upstream's own success signs: fewer unneeded diff lines, fewer rewrites, questions before implementation | NOT_PROVEN | An unmeasured claim. The measurable parts (out of scope, diff limit, hack flags, tokens) become PL-002 secondary outcomes; "questions before implementation" does not apply headless (row 2). |

**Counts:** ALREADY_PRESENT 12 (rows 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 22, 24) · USEFUL_DELTA 4 (rows 1, 3, 19, 21) ·
CONFLICT 4 (rows 2, 5, 10, 20) · NOT_PROVEN 6 (rows 4, 9, 11, 23, 25, 26) · total 26.

## 2. The minimal candidate

Four lines in DjimitFlo's words, one per USEFUL_DELTA row, nothing else:

1. `Before the first edit, confirm yourself, in the source and the named test, each fact the fix depends on; nobody is available to answer questions.`
2. `When the task allows more than one reading, pick the one that keeps the edit smallest and easiest to undo inside the named file, then continue.`
3. `Before editing, state in one sentence the exact result that means done: which named test must pass and which single file may differ.`
4. `For a behaviour change, do not stop at green: ask whether a plausible wrong solution would also pass the named test, and if so, make your work match the intended behaviour.`

| Line | Covers | Row |
|---|---|---|
| 1 | look into material assumptions first, yourself (headless) | 1, replaces 2 and 5 |
| 2 | decide a reversible choice within the existing mandate | 3 |
| 3 | state the concrete acceptance condition before editing | 19 |
| 4 | for a behaviour change, the verification must also reject a plausible wrong solution | 21 |

- Content digest: `lines_sha256 = sha256(lines.join('\n'))` =
  `095c9c956066b57dbdd5114e0cedfd17ae09d05fd759cdf5697f5f474b9ac532`. Any other digest is a different treatment and is
  not PL-002.
- Lengths 145, 143, 132 and 172 characters; no newline and no double space, so `oneLine` and the worker's 300-character
  cut (gym-worker.mjs:78, 88) leave them byte-identical.
- **Guard result (run 2026-10-26 on this branch):** `guardLines` from `packages/server/src/services/dream-evolution.ts`
  (lines 146-158: at most 5 lines, at most 200 characters, none of the `FORBIDDEN` words, line 151) returns all four lines
  unchanged, and each line unchanged on its own. Negative control: `guardLines(['Run the type-check first.'])` returns
  `null`. The fingerprint test repeats both checks in CI. The wording avoids every forbidden word on purpose (for example
  it says "confirm" and "ask whether", never the banned verb for verifying, and never the banned words for the test file
  boundary).
- Not a skill and not a production rule. No skill card, `skill_outcomes` row, attribution or `strategyGenomeFor` record
  counts as delivery.

## 3. Delivery proof plan

The lines reach the maker in one way only: as genome strategy lines on a gym claim (`claim.genome = { id, lines }`,
remote-gym-service.ts:292), appended by the worker under `Strategy:` (gym-worker.mjs:78) and flattened by `oneLine`. Proof
of delivery, per attempt, is all of the following:

1. **Delivered-lines digest.** The claim records the `lines_sha256` of the lines it served; it must equal
   `095c9c95…9ac532` (arm B) or the empty treatment (arm A, no `genome` on the claim).
2. **Fire check.** The worker's `fire_check` (gym-worker.mjs:87-90) must show `genome_lines_found = genome_lines = 4` for
   arm B and `genome_lines = 0` for arm A. The server's `fireCheckVoid` rule (genome-registry.ts:293-298) applies: an arm B
   attempt without that evidence is VOID.
3. **Goal digest.** The manifest freezes, per task and arm, the expected `goal_sha256 = sha256(gymGoal(task, kind, lines) +
   '\n')` computed with the frozen worker version. The worker's reported `goal_sha256` must equal it. A mismatch (other
   worker version, other task text, lines cut or reordered) is VOID.

The candidate is stored as a `maker_genomes` row with gene `procedure`, origin `procedure`, status `candidate` (never
`trial`, never `active`), as PL-001 does for its procedure (procedure-selector.ts:56-61), so no trial order, holdout epoch,
dream parent or production attribution can pick it. A skill registration or an attribution record alone proves nothing
about what the maker received.

## 4. Pre-registration (protocol)

**Hypothesis H-PL2:** for atomic@llama-router on fresh applicable gym tasks, adding the four candidate lines to the gym goal
raises the share of tasks with a gated verified completion.

### Arms

| Arm | Gym goal | Lines digest |
|---|---|---|
| A — control | today's gym goal from the frozen worker version, no strategy lines (the current instructions) | none |
| B — candidate | the same goal plus the four lines under `Strategy:` | `095c9c95…9ac532` |

Both arms: the same worker host and worker version, species atomic@llama-router, the same router model, `--max-steps 40`,
`GYM_MAKER_TIMEOUT_MS`, the same tools, the same oracle, seeded-mutant kills and production gates (`GYM_PROD_GATES`, worker
capability `prod_gates`), and the same budget per attempt. Arm order per task is fixed at freeze time: A first when the
first byte of `sha256('pl-002:' + task_key)` is even, else B first.

### Task set

- Fresh tasks, frozen in a manifest before any attempt; the freeze is the operator's.
- Applicable: TypeScript repair tasks on `packages/server/src/services/**/*.ts` (seeded mutants at tiers 3–6, mined repairs
  when available) and failure-derived `write_test` tasks, excluding `**/__tests__/**`, `**/*.test.ts`, `**/*.d.ts` and
  `**/*.generated.ts`. Kind is recorded per task.
- Disjoint from: the PL-001 manifest and every key with a `pl-001` run; every holdout key of any table and any epoch
  (`gym_holdout`, `gym_mutant_holdout`, `gym_write_test_holdout`); every TG-001 key (`tg_attempts`, `tg_experiments`); every
  trial-attempted and dream-exposed commit or source (`holdoutExclusions`, holdout-exposure.ts:15-57); every key with an
  earlier `evolution-gym` attempt by this species; canaries.
- One base commit per task, the same for both arms (`task.base` for a mutant or write_test task, `task.commit` for a mined
  one), frozen with the task bytes (mutant content, test list), their sha256 and the two expected goal digests.
- Size: 120 tasks (100 pairs plus a margin for censoring), served in order of `sha256('pl-002:' + task_key)`.
  write_test supply is thin (12 fresh on 2026-10-17, about 6 more per 5 days), so most tasks will be repairs; the share per
  kind is reported, never rebalanced after the freeze.

### Isolation

- Own loop name: `loop_runs.loop_name = 'pl-002'`, never `'evolution-gym'` or `'pl-001'`. Gym statistics, the species
  breaker, IRT, the hack rate, the graded pool, trial deciding sets, dream inputs (dream-evolution.ts:163-170) and the
  bandit read `evolution-gym` only (the TG-001 provenance pattern, remote-gym-service.ts:282-285).
- A fresh atomic state per attempt, deleted afterwards (EV1, gym-worker.mjs:45-48). No shared writable memory between
  attempts: no `skill_outcomes` row, no memory or knowledge write, no `maker_genomes` row with status `trial`, no dream input.
  The npm cache is mounted only for `npm ci`, not for the maker (gym-worker.mjs:576 versus 590).
- No line reaches a production maker. `GENOME_APPLY_MODE` stays shadow; skill cards stay record-only.

### Outcomes

**Primary:** gated verified completion: `gym_result.status = 'success'` on a claim with production gates, carrying the
per-check `prod_gates` map (`ELIGIBLE_GATED`), not VOID, not quarantined. Per arm, paired by task, intention to treat (a
censored arm counts as not verified).

**Secondary** (descriptive only, no multiplicity correction, no claim; unknown is never 0 — an unknown is counted apart and
excluded from rates, with coverage per arm):

- **Wrong-assumption failures** (rule-based, from existing reason strings only, gym-worker.mjs:100-103, 157-165, 186-187):
  a scored failure whose reason starts with `out of scope:` (the maker assumed the fix lives in another file), is
  `test does not import …` or `test mocks …` (it assumed how the target is reached), or is `test kills no mutant` (green on
  the target, but it asserts the wrong behaviour). `tests still red`, `no change (maker gave up)`, `prod_gate_failed:*` and
  every other reason are "other". Gym attempts have no checker, so checker notes are unavailable: that input is `null`,
  not 0.
- **Unnecessary questions:** expected to be 0, because the maker is headless (`--no-approval`, no addressee). Measured as
  attempts with no change, exit 0 and maker time under 60 s (the `UNDERSTANDING_FAILURE` rule, tg-001.ts:330-332). This needs
  the per-attempt metrics block (`tg_metrics`), which the worker sends only for claims that carry `tg` today
  (gym-worker.mjs:550); without it the count is unknown, not 0.
- **Unrelated changes:** `out of scope` results, `prod_gate_failed:diff_limit`, and hack flags `tests_touched`,
  `ci_or_config_touched`, `readme_only`, `assertion_removed`, `skip_or_only_added` (gym-hack-classifier.ts:8).
- **Repair work:** physical attempts per observation (infra or VOID re-serves). The maker's own edit-and-rerun cycles are not
  observable (atomic reports no tool calls; `tool_calls` is null): reported as unknown.
- **Cost per correct task:** total tokens over all physical attempts of an arm divided by its gated verified completions,
  with token coverage; total maker wall time likewise. With 0 completions the ratio is undefined (null), not 0.

### Missing data and infra

An infra discard (`infra:` reason, discarded, lost or orphaned run) or a VOID attempt re-serves the arm, at most 2 retries
(3 physical attempts). The first non-infra, non-VOID result is the observation. After 3 infra or VOID attempts the arm is
**INFRA_CENSORED**: not verified in the primary analysis, pair dropped in the sensitivity analysis. Every physical attempt,
failed and inconclusive ones included, is kept and reported.

### Analysis

- Pairs: b = tasks where B is verified and A is not; c = tasks where A is verified and B is not.
- Test: exact one-sided McNemar, p = P(X ≥ b), X ~ Bin(b + c, ½) (`mcnemarOneSided`), α = 0.05. H-PL2 is supported iff
  b > c and p < 0.05. No other test decides.
- Sensitivity: the same test on pairs with no censored arm. Descriptive split by kind (repair, write_test).
- Verdicts: `SUPPORTED`; `NOT_SUPPORTED` (100 pairs, not significant); `INCONCLUSIVE` (day 21 before 100 pairs; analysis
  reported on the completed pairs); `STOPPED_FOR_HARM`.

### Sample size and power

- Base rate from the plan file (`~/.claude/plans/eventual-brewing-cray.md`): gated pass 34/91 = 0.37 since 10-08; the
  epoch-1 parent 18/39 = 0.46 on mutant tasks; mutant tiers 3–6 gated 0.35–0.39. Planning value 0.37–0.46, discordance
  0.30–0.44 (PL-001 assumed 0.32–0.40).
- Exact power over the paired trinomial, one-sided α 0.05 (computed for this protocol):

  | Discordance | +10 pt, n 100 | +15 pt, n 100 | +20 pt, n 100 | +15 pt, n 60 |
  |---|---|---|---|---|
  | 0.30 | 0.51 | 0.85 | 0.98 | 0.63 |
  | 0.36 | 0.45 | 0.78 | 0.96 | 0.55 |
  | 0.44 | 0.39 | 0.69 | 0.91 | 0.48 |

  Type I error at the null with n 100 is 0.035–0.037 for discordance 0.30–0.44 (the exact test is conservative).
- n = 100 completed pairs. Four generic lines are expected to act less than PL-001's task-specific procedure, so PL-002 is
  sized for about +15 pt (power 0.69–0.85), not +20 pt; it is **not powered for +10 pt** (≤ 0.51), and a null result
  cannot rule out an effect of that size.
- Volume: about 225 claims including about 12 % infra — about 11 days at 20 claims a day with the whole gym cap, about 6
  days at 40.

### Stop rule

- Stop at 100 completed pairs or at day 21 after the first attempt, whichever comes first.
- Early stop **for harm only**, checked after every completed pair: the e-value for "control beats candidate" over the
  discordant pairs (`ePaired`, control wins coded +1) reaches 20; or any canary is solved; or arm B has 3 or more
  out-of-scope or hack-flagged results more than arm A. Never an early stop for success.

### Start condition

- PL-002 starts only after PL-001's runner exists, and never at the same time as PL-001. Both draw from the same rolling
  remote gym cap, which counts every claim with a remote host regardless of loop name (stall-watch.ts:36-41), so concurrent
  runs would compete for slots, and a maker version or task pool shared in time would confound both.
- It also needs: the PL-002 runner (a separate PR: loop name, manifest freeze, lines row, fire and goal digest checks,
  `tg_metrics` on its claims), no genome trial in progress unless the operator grants a share of the cap, and the manifest
  freeze. Building the runner, freezing, the flag in `runtime.env` with a backup, the WIP slot and GPU budget are all the
  operator's decision.

### Recommendation (conditional on the result)

- **Keep** — `SUPPORTED`, and arm B is not worse on unrelated changes and cost per correct task: propose delivering the lines
  to applicable gym tasks through the procedure selector, as a separate operator decision. Production makers are a separate
  experiment with its own pre-registration.
- **Adapt** — `NOT_SUPPORTED` or `INCONCLUSIVE` with b > c, or `SUPPORTED` with a secondary harm: a line-ablation follow-up
  under a new pre-registration; no delivery meanwhile.
- **Do not add** — b ≤ c at 100 pairs, or `STOPPED_FOR_HARM`: record the lines and their digest as negative evidence for this
  species and do not propose them again without new evidence.

### Rollback

The runner's flag goes off; claims are then byte-identical to claims without PL-002 (the selector's off/shadow test
pattern).

## 5. Kept separate

PL-002 tests instruction text only. Step budget (`--max-steps`), model routing (species, router model, bandit) and the
evaluator (oracle, mutant kills, production gates, hack classifier, VOID rules) are held fixed. A change to any of them
during the run is not part of PL-002: the run stops as `INCONCLUSIVE` and the change is recorded as an amendment.

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.

---
PREREG_SHA256: 4d080a682fdcb75018b2295294e23013de091745f31a6133fb9f98aac94bad42 (sha256 of everything above this line; computed 2026-10-26 before any PL-002 runner, manifest or attempt existed)
