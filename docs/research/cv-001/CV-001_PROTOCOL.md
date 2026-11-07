# CV-001 step 2 — a discipline control vector for the gym repair maker (pre-registration)

Status: **pre-registered, frozen before any code that can produce an outcome** (2026-11-07). This document is the first
commit of the PR that adds the CV-001 runner (`CV_001_MODE`, branch `feat/cv-001-control-vector-arm`). Not started.
Starting CV-001 is an operator decision.

## Why this exists, and what it is not

- Step 1 (workstation `~/cv-001/REPORT.md`, 2026-11-07) built a control vector for the local maker model Qwen3.8-27B from
  40 contrastive pairs (disciplined against undisciplined maker completions): file `qwen38-27b-discipline.gguf`, sha256
  `db1893a4d12936fefedb98d117955ef6cc7b1d59c661c1e44f6eee590cda4281`, 63 unit-norm directions, sign-oriented to the
  mean-diff vector. An offline smoke (10 single-turn prompts, thinking off, no tools) showed a real and roughly monotonic
  direction: at +1.5 the model stops after a pass and leaves package.json alone; at +2.0 it starts to degrade; at +4.0 it
  collapses. The smoke is a sanity signal, not evidence of benefit.
- Step 2 is the comparison that decides whether the steered model is worth a wider gym rollout at all. It is gym-only. No
  production maker ever gets the vector in CV-001, and an ADOPT verdict is not a production decision either: any wider
  rollout, in the gym or in production, is a separate operator decision.
- Operator decision 2026-11-07: the steered arm is a gym-only router preset. The production preset `[qwen38-27b]` stays
  byte-identical. The arms run in blocks inside a quiet window, so model reloads do not hit production. The preset file is
  edited by the operator's main session, never by the runner or the worker.

**Hypothesis H-CV1:** for atomic@llama-router on frozen mutant-repair gym tasks, serving Qwen3.8-27B with the discipline
vector at scale 1.5 raises the share of attempts that end in a clean success, without lowering plain success by more than
5 points, without more broken tool calls and without more timeouts.

## The treatment (frozen)

| Arm | Router model (the alias the request names) | What the router serves |
|---|---|---|
| A — baseline | `qwen38-27b` | the production preset, unchanged |
| B — steered | `qwen38-27b-cvd15` | the same settings as `[qwen38-27b]` plus `control-vector-scaled = /home/djimit/cv-001/qwen38-27b-discipline.gguf:1.5` |

- The vector is applied on all layers (no layer range). Scale 1.5. Any other file digest, scale or layer range is a different
  treatment and is not CV-001.
- Everything else is shared: atomic-agent in the pinned runner image, `--max-steps 40`, `GYM_MAKER_TIMEOUT_MS`, the gym goal
  (no strategy lines), the oracle, the production gates (`GYM_PROD_GATES`, worker capability `prod_gates`), the same GPU and
  the same router. Only the model name in the request differs.
- **Delivery.** atomic-agent sends no model name today; the workstation's atomic-shim (:8084) fills in `qwen38-27b`. For a
  CV-001 claim the worker routes the maker through its own model-forcing route, which sets `model` to the claimed alias in
  every JSON request body, in both arms. The claim carries the alias. The worker reports back what it did.

## Population

- A **new** frozen task set of **60 seeded mutant-repair tasks** (the gym's repair tasks with an injected mutant, tiers 3–6,
  from the deploy checkout). Never a holdout key of any table or epoch (`gym_holdout`, `gym_mutant_holdout`,
  `gym_write_test_holdout`), never a TG-001 key, never a PL-001 key, never a trial-attempted or dream-exposed key
  (`holdoutExclusions`), and never a key with an earlier `evolution-gym` attempt. No mined tasks and no write_test tasks.
- Ordered by `sha256('cv-001:' + task_key)`; the first 60 eligible are frozen.
- Each task runs **2 repeats** per arm. A unit is (task, repeat): 120 units, 240 arm slots.
- **Freeze.** The first claim from a capable worker after `CV_001_MODE=on` freezes the manifest. That claim serves no CV-001
  attempt. The manifest (task keys, base commits, mutant digests, aliases, vector digest, schedule, analysis) and its sha256
  are stored before the first attempt. If fewer than 60 tasks are eligible, nothing is frozen and the reason is recorded
  (retried at most hourly).

## Schedule: blocks inside a quiet window

- **Units in blocks.** The 120 units are ordered by `sha256('cv-001:unit:' + task_key + '#' + repeat)` and cut into 20 block
  pairs of **N = 6** units. Block pair k holds units 6k … 6k+5. Each block pair is served as two arm blocks: all 6 units in
  one arm, then the same 6 units in the other arm. The first arm of block pair k is A when the first byte of
  `sha256('cv-001:block:' + k)` is even, else B. Within an arm block the units are served in the order of
  `sha256('cv-001:' + arm + ':' + task_key + '#' + repeat)`. So a pair is complete after its block pair, the arm order is
  randomised per block pair, and arm blocks alternate through the window, which balances time of day across the arms.
- **Quiet window.** A CV-001 attempt is served only when the claim time lies in the window, default 00:00–06:00Z
  (`CV_001_WINDOW_UTC`, `start-end` in whole UTC hours, start < end), and the claim time plus the maker budget
  (`GYM_MAKER_TIMEOUT_MS`, default 15 min) ends inside it.
- **No production maker waiting.** A CV-001 attempt is served only when no remote maker job (`remote_maker_jobs`) is
  `queued` or `claimed`. If that cannot be read, nothing is served.
- Inside the window, a capable worker's claim goes to CV-001 before canaries, probes, trials and ordinary replays. Outside the
  window, or when nothing is servable, the claim falls through to the ordinary gym unchanged. CV-001 claims count toward
  `EVOLUTION_GYM_REMOTE_MAX_PER_DAY` like every remote gym run.
- **Model reloads.** The router runs one model at a time (`--models-max 1`), so every switch between arm blocks reloads the
  16.5 GB model. Every arm block starts with a switch, in both arms, so the reload cost falls on both arms alike. The router
  also unloads an idle model after 600 s (`sleep-idle-seconds`), whichever preset it is.

## What the worker can observe

The worker observes, per attempt:

- the oracle verdict as today: the named test file green, and only the task's source file changed (the change list leaves out
  `package-lock.json`, `.atomic*` and `.djimitflo/`, so a lock-file edit is **not** seen); the production gates per check;
- how the maker ended (`exit:<code>`, `timeout`, `error`) and its wall time;
- through its model-forcing route: the number of JSON requests it forced to the alias, any request it could not force, the
  `model` named in the router's responses, and the number of HTTP errors from the router;
- after the maker: the router's model listing for the alias (`GET /models`), from which it reads the control vectors in that
  model's launch arguments and the sha256 of each vector file;
- the last chat request the agent sent (it holds the transcript so far: assistant tool calls and tool results). From it the
  worker derives, and sends only these counts: tool calls, broken tool calls (arguments that are not valid JSON, or a raw
  `<tool_call>` block in assistant text whose JSON does not parse), whether a loop occurred (the same tool call, name and
  arguments, 3 or more times in a row), and edits after the first pass (edit tool calls — a tool name matching
  `edit|write|patch|replace|create|insert|apply` — after the first tool result that shows a fully passing vitest run, a
  `Tests  <n> passed (<n>)` line).

The worker **cannot** observe: a tool call in the agent's final response that it never reported back (the transcript is the
last request, not the last response); which test file a passing vitest run covered (the first fully passing run counts);
tool semantics beyond the tool name; anything the agent did not route through the model (none is expected). These limits
are the same in both arms.

## Outcomes

Per arm attempt:

- **plain success** = `gym_result.status = 'success'`, claimed with the production gates and carrying the per-check gate map
  (`ELIGIBLE_GATED`), not VOID and not quarantined (the PL-001 "gated verified success").
- **clean success** (primary) = plain success AND edits after the first pass = 0 AND no loop AND the maker did not time out.
  "Only the named file changed" is part of plain success (the oracle's scope check).
- **degenerate** = at least one broken tool call, or at least one HTTP error from the router during the maker.
- **timeout** = the maker ended in `timeout`.

## VOID, infra, missing data

- **Delivery proof (VOID otherwise).** A scored attempt (success, failure or quarantined) counts only when the worker reports
  the alias it used and it equals the claim's alias; at least one request was forced and none went unforced; every model
  named in the router's responses equals the alias; the router listing for the alias was read; arm B's alias carries exactly
  one control vector, scale 1.5, whose file sha256 is `db1893a4…4281`; arm A's alias carries none; and the transcript counts
  are present. A gated success without its gate map is VOID too.
- An infra discard (`infra:` reason, lost or orphaned run) or a VOID attempt re-serves the arm slot, at most 2 retries
  (3 physical attempts). Then the slot is **INFRA_CENSORED**. Every physical attempt is kept.
- A `task:` discard (for example, the mutant survives) is deterministic for the task: all its units are INVALID in both arms,
  are not served again, and are excluded from the pairs and reported.

## Isolation

- Own loop name: `loop_runs.loop_name = 'cv-001'`, never `'evolution-gym'`. Every gym statistic, the species breaker, IRT,
  the hack rate, the graded pool, tried tasks, trials and the bandit select `loop_name = 'evolution-gym'` and so never count a
  CV-001 attempt (the TG-001 / PL-001 provenance pattern).
- No `skill_outcomes` row, no `gym_attempt_diffs` copy (only the diff's sha256 on the run), no gate-policy binding, no model
  call ledger row. A frozen CV-001 task is never served as ordinary gym work and never frozen into a later holdout.
- No production maker is touched: production remote makers use the atomic-shim default, which stays `qwen38-27b`.

## Analysis

- Pairs: per unit (task, repeat), A against B. A pair is complete when both arm slots have an observation or are censored.
  Intention to treat: a censored slot is neither a clean success nor a plain success.
- **Primary test:** exact one-sided McNemar on clean success, `p = P(X ≥ b)`, `X ~ Bin(b + c, ½)`, with b = units where B is
  clean and A is not, c = units where A is clean and B is not (`mcnemarOneSided`). No other test decides.
- **Decision rule — ADOPT only if all four hold, otherwise REJECT:**
  1. clean success rate B − A ≥ +10 points and p < 0.05;
  2. plain success rate B − A ≥ −5 points;
  3. degenerate rate B − A ≤ +2 points (over the units with an observation in that arm);
  4. timeout rate B ≤ timeout rate A (over the units with an observation in that arm).
- Rules 2–4 are point-estimate rules on the observed rates, not tests: they guard against over-steer, they are not a
  powered non-inferiority claim.
- **Secondary** (descriptive, no claims): edits after the first pass per attempt, loop rate, tool calls, maker wall time,
  tokens where known (unknown kept separate, never 0), infra and VOID rate per arm; the primary test on the pairs with no
  censored slot (sensitivity); the primary test on one unit per task (repeat 1 only), because repeats of a task are not
  independent.
- Verdicts: `ADOPT`, `REJECT` (all units completed or INVALID, rule not met), `INCONCLUSIVE` (day 28 after the first attempt
  before that; the analysis is still reported on the pairs completed).

## Sample size and power

- n = 120 units (60 tasks × 2 repeats); fewer if tasks turn INVALID.
- Baseline unknown for clean success. Plain gated success of atomic@llama-router on comparable repair tasks was 28 / 60
  (46.7 %) in PL-001 arm A, so clean success is at most that.
- Exact power of the primary rule (one-sided exact McNemar, α 0.05, and an observed difference ≥ +10 points), computed over
  the paired trinomial for 120 independent units: at a true +10 points about 0.48–0.54 (discordance 0.2–0.4); at +15 points
  0.81–0.92; at +20 points 0.97–0.99. **CV-001 is powered for an effect near +15 points, not for +10.**
- The two repeats of a task are correlated, so the effective n lies between 60 and 120 and the McNemar p on 120 units is
  anti-conservative. At 60 independent units the power at +10 points is only 0.27–0.43. The repeat-1 sensitivity analysis
  shows how much the verdict leans on the repeats.
- Volume: 240 arm slots plus about 15 % infra / VOID re-serves, about 275 claims. With one attempt per worker run inside a
  6-hour window, about 12–20 attempts a night: roughly 14–23 nights.

## Stop rule

- Stop when every unit is complete or INVALID, or at day 28 after the first attempt, whichever comes first.
- No early stop for success. No early stop for harm: the over-steer rules 2–4 decide at the end.
- Before the first attempt the experiment registry carries stop_by 2026-12-07 (registration + 30 days: decide to start or
  close). From the first attempt, stop_by is the first attempt + 28 days.

## Start condition

CV-001 does not start until all of these hold, each the operator's: the preset `[qwen38-27b-cvd15]` is in the router's
preset file and loaded into the router's model list (the production preset unchanged); the worker on the workstation is
reinstalled from `main` (it announces `model_override`); `CV_001_MODE=on` is set in `runtime.env` with a backup; and the
window and the daily cap leave room. The first attempt's delivery proof is the check that the preset is right: a wrong
preset makes every attempt VOID.

## Rollback

`CV_001_MODE=off`. Claims then match the pre-CV-001 claims byte for byte, and the worker sends a claim without a model alias
exactly as before. The preset can stay; nothing references it.

## Lifecycle

The verdict is recorded with the experiment. ADOPT means only that a wider gym rollout may be proposed; nothing is promoted
and no production maker ever gets the vector through CV-001. REJECT records a negative-evidence draft (judgment
`negative_evidence_draft`); the operator adds the entry to `NEGATIVE_EVIDENCE.yaml`. If rule 1 fails but rules 2–4 hold, the
vector is inert at this scale; a retry with another scale or layer range is a new pre-registration, not CV-001.

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.
---
PREREG_SHA256: b6e1bb318557464e49d6cef8663c5730a1d56dc396c6e471324e556faf25771c (sha256 of everything above this line; computed 2026-11-07 before any CV-001 runner or worker code existed)

## Amendment 2026-11-07 (1): runner

Reason: the runner is built (`packages/server/src/services/cv-001.ts`, worker `scripts/gym-worker.mjs`, same branch) before any
attempt. The points below are fixed here, before any outcome exists. The hypothesis, treatment, population, schedule,
primary endpoint, test, alpha, decision rule, n and stop rule are as frozen: verdict rules unchanged.

1. **Flags.** `CV_001_MODE=off|on` (default off) and `CV_001_WINDOW_UTC` (default `0-6`). Rollback is `off`: claims then match
   the pre-CV-001 claims byte for byte, also for a worker that announces `model_override`.
2. **Worker.** CV-001 slots are served only to a worker that announces `prod_gates` and `model_override` and offers
   `atomic@llama-router`. The claim carries `model_override: { alias }` and `cv: { experiment, arm, repeat }`. The worker then
   routes the maker through an HTTP route on its host-side socket (instead of the byte pipe) that sets `model` in every JSON
   request body and writes its counts after every response. It reports `model_check`: alias, requests, forced, unforced, the
   models named in the router's responses, router HTTP errors (status ≥ 400 or no answer), the router listing for the alias
   (status, launch-argument control vectors with the sha256 of each file, layer range) and the transcript counts. A claim
   without an alias keeps the byte pipe and sends no `model_check`.
3. **Delivery proof, made concrete (never weaker than frozen).** VOID unless: alias = claimed alias; forced ≥ 1 and
   unforced = 0; every served model = the alias; the listing names the alias; no control-vector layer range on the alias (a
   layer range is a different treatment); arm B: exactly one vector, scale 1.5, file sha256 `db1893a4…4281`; arm A: none;
   the transcript counts (tool calls, broken tool calls, loop, edits after the first pass) are all present. This holds in
   both arms.
4. **Maker timeouts.** The worker discards a maker that timed out without a change as `infra:`. In CV-001 such an attempt is
   an **observation**, not infra (otherwise rule 4 could never see the timeouts that matter most): it is scored as a failure
   (`maker timeout (CV-001 observation)`), timeout = true, not plain, not clean, under the same delivery proof. A crash
   (any other termination) stays infra and is re-served.
5. **Degenerate.** "HTTP errors from the router" in the frozen definition are the forced POST requests that got a status ≥ 400
   or no answer.
6. **Verdict record.** The verdict is recorded once on `cv_experiments.verdict_json` at the result or claim that settles it;
   REJECT also records a `negative_evidence_draft` judgment. The experiment registry reports CV-001 with target 120 units and
   the stop dates frozen above.
7. **Isolation detail.** Besides `loop_name = 'cv-001'`, the species breaker and tried-task bookkeeping (which select by
   species, not by loop name) skip any run carrying `gym.cv`, as they skip `gym.pl`.
