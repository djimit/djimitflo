# Decision experiment plan — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable D)

DRAFT, design only. **No experiment below may run without explicit operator authorization**, including the zero-spend
ones (they read prod and ask for labelling time). Nothing here re-opens NE-001, touches the D5-NO population (prescreen
questions, mode, cadence), the JEV-114 sample or label sources, ACE-001, STE-001, MAKER-DEPS-001, F2 v2, the memory
holdout or genome trials, or the discovery pause (#825).

## 0. Which classes get an experiment

Arms (production / deterministic / jev / local small / large reasoning / hybrid) are defined **only** for decision
classes where ground truth exists or can be obtained **and** where jev is allowed by the operator rule.

| Class | Ground truth | jev allowed? | Experiment |
|---|---|---|---|
| KB passage relevance (acting today) | obtainable: blind operator labels on (question, page) | yes — text-grounded relevance | **E-KB** (priority 1) |
| Failure-cause classification (learner input) | partly exists: DI-001 `MAKER_FAILURES.md` hand classes; obtainable for new runs | yes — text-grounded log classification | **E-FC** (priority 2) |
| Visual "error shown?" check | exists by construction (seeded broken pages) | yes — objectively verifiable | **E-IMG** (priority 3, needs CI secret) |
| Discovery relevance | DI-001 blind labels (0 in prod) | yes, but paused | none new: the registered DI-001 relevance benchmark (#829) is the experiment; reopen rule `RELEVANCE_EVOLUTION.md` §8 |
| Proposal pre-screen | `self_improvements.status`, operator labels | only as the running D5-NO study | none (NE-001; D5-NO running) |
| Memory selection (`decision_context`) | obtainable | yes | deferred until the memory-holdout readout (2026-10-27) |
| Checker / code review, risk, approval, auto-approve, auto-merge, promotion, fitness, routing, tool safety, strategy selection | various | **no** | no jev arm. Deterministic/LLM experiments for these already run (F2 v2, MAKER-DEPS-001, ACE-001, STE-001, X1, TG-001) and are not duplicated |

Shared statistics: dev / calibration / held-out split by `sha256('<exp-id>:' + cluster key) mod 10` (0–2 dev, 3 calibration,
4–9 held-out); one pre-registered analysis on held-out; 95 % intervals by cluster bootstrap (B = 2 000, fixed seed);
paired comparisons by exact McNemar on discordant pairs; probability quality by Brier (with the constant-prevalence Brier
reported next to it — a forecaster that does not beat prevalence has no skill); non-inferiority with a pre-stated margin;
Clopper-Pearson for error-rate bounds. Below the minimum n at the stop date → INSUFFICIENT_EVIDENCE, never "no effect".
Each protocol is frozen with a sha256 before any held-out label is joined to any score (the JC-001 / D5-NO pattern).

## E-KB — is the one acting jev path right? (priority 1)

- **Question.** Does `kb_passage_relevance` (enforce) drop the right KB passages from panel prompts, and is it better than
  a deterministic cosine cutoff at the same drop rate?
- **Population (real volume).** Every `kb_passage_relevance` row with its page verdicts: 170 rows, 452 page verdicts,
  88 below 0.5 (2026-09-29 → 2026-10-22; ≈ 20 page verdicts/day). Join to the `kb_retrieval` row of the same subject
  (cosine per page, `kb-corpus.ts:85-87`). Exclude pages with an `artifact_integrity` row after the verdict (body changed).
  Cluster = panel subject.
- **Label.** Blind operator label per (question, page): helps / does not help / cannot tell — the same wording as the jev
  question (`kb-corpus.ts:100`). The labeller sees neither score. `cannot tell` is excluded and counted.
- **Sample.** All 88 drops + a uniform random 100 of the 364 kept pages (sampling weights recorded) ≈ 188 labels
  (≈ 40 s each → ≈ 2 h, e.g. 4 × 30 min sessions in the existing `/decisions` labelling pattern of #835).
- **Arms.**
  | Arm | What | New calls |
  |---|---|---|
  | Production | jev ≥ 0.5 keeps (logged) | 0 |
  | Deterministic | keep top-k by cosine; cutoff τ chosen on dev to match jev's drop rate; plus keep-all (pre-R2 behaviour) | 0 |
  | jev | = production (logged Noul as probability for Brier) | 0 |
  | Local small | workstation System One on the same state (pull model, `local-shadow-queue` pattern) | ≈ 450 local calls (GPU time, no USD) — **optional** |
  | Large reasoning | one reasoning model, same question | ≈ 450 calls × ≈ 2 k tokens ≈ 0.9 M tokens — **optional** |
  | Hybrid | jev only for pages with cosine in the ambiguous band (dev-chosen), cosine elsewhere | 0 (computed from logs) |
- **Endpoints.** Primary: false-drop rate = P(label helps | dropped), Clopper-Pearson upper bound. Secondary: drop precision
  of jev vs cosine at matched drop rate (McNemar, non-inferiority margin 0.05); Brier of the jev Noul vs label vs constant;
  share of panel prompts that lost ≥ 1 helpful page.
- **Decision rule (pre-stated).** RETAIN enforce if the false-drop upper bound ≤ 0.15 **and** jev is non-inferior to cosine.
  RETIRE enforce (back to shadow) if the upper bound > 0.15 or jev is inferior. INSUFFICIENT if < 60 labelled drops.
- **Power.** With 88 drops and a true false-drop rate of 5 %, the expected upper bound is ≈ 0.10; at 10 % it is ≈ 0.17 —
  the rule separates "mostly right" from "one in ten wrong".
- **Spend.** Production/deterministic/jev/hybrid arms: **0 tokens**, ≈ 2 h operator time. Optional arms: local GPU time;
  reasoning ≈ 0.9 M tokens (USD UNKNOWN until the provider price is recorded, O12).
- **Stopping.** One analysis after the last label; no interim look on the held-out split.
- **Risk / rollback.** Read-only; the outcome may be a one-line env change to `shadow` (operator).

## E-FC — failure-cause classification (priority 2)

- **Question.** Does jev's confident `failure_cause` agree with hand classes at least as well as a deterministic
  stderr/gate-pattern classifier, at useful coverage?
- **Population.** `failure_cause` rows (274; ≈ 9/day) on runs that DI-001 `MAKER_FAILURES.md` classified (213 failed
  leases on 171 runs, 30 d to 10-13). Overlap size is UNKNOWN until counted (a count, not an outcome look). If < 60
  overlapping runs: extend with operator hand labels on new failed runs (≈ 2 min each).
- **Label mapping.** MAKER_FAILURES classes → the 7-cause enum (`failure-cause.ts:10`), frozen before the join; unmappable
  classes excluded and counted.
- **Arms.** Production (no classifier; the learner consolidates nothing) · deterministic (regex over stderr tail, failed
  gate names, exit status; fitted on dev only) · jev (logged, latest non-error row) · local small and large reasoning
  (optional, new calls) · hybrid (deterministic first, jev when no rule fires).
- **Endpoints.** Accuracy on the confident subset and coverage; macro-F1; McNemar jev vs deterministic on runs both cover;
  the `platform_fault` Noul's Brier vs the `infra|environment_noise|flaky_check` label.
- **Decision rule.** Keep jev only if accuracy ≥ deterministic − 0.05 **and** coverage ≥ 0.4; otherwise replace with the
  deterministic classifier and RETIRE the judgment.
- **Spend.** 0 tokens for the logged arms; optional reasoning arm ≈ 200 runs × 1.5 k tokens ≈ 0.3 M tokens.

## E-IMG — visual error check in CI (priority 3)

- **Question.** Does the IMG-001 "error shown?" Noul catch broken dashboard pages better than a DOM/console check?
- **Population.** Playwright screenshots of the dashboard routes on PR CI: ≥ 50 clean + ≥ 10 seeded-broken (an injected
  error boundary, an empty data source) per round.
- **Arms.** Deterministic (DOM: error-boundary text, console errors, HTTP status) · jev (new calls) · hybrid (DOM first,
  jev when DOM is clean but the page is visually empty). Local small / reasoning: not proposed (vision).
- **Endpoints.** Recall on seeded breaks; false alarms per 50 clean (Clopper-Pearson); incremental catches of jev over DOM.
- **Decision rule.** ADOPT the jev step as **CI shadow (non-blocking)** only if it catches ≥ 1 seeded class the DOM check
  misses with ≤ 1 false alarm per 50; otherwise REJECT (the DOM check suffices).
- **Spend.** ≈ 60 calls × ≈ 3 k tokens ≈ 0.18 M tokens per round (102 k tokens / 34 screenshots measured in IMG-001); USD
  UNKNOWN. Needs a CI secret and an egress decision (api.typesafe.ai is egress class `unknown`,
  `egress-classification.ts:20`) — both operator.

## Not run, and why

- **Prescreen variants** (thresholds, dedupe, question changes): NE-001 + D5-NO. D5-NO accrual today: 0 confident-NO
  clusters since the cutoff (count only). Its own rule ends it INSUFFICIENT_EVIDENCE at 2027-01-09 if n = 100 is not
  reached; nothing here changes that.
- **JEV-114 acceleration:** its label sources are fixed by its protocol (names_file, D5 labels, blind relevance labels);
  adding E-KB labels would not count and must not be pooled.
- **Checker / risk / approval / routing / strategy:** no jev arm (operator rule); experiments for these classes are
  already registered without jev.

## Spend summary (needs operator authorization before any run)

| Experiment | Model spend (mandatory arms) | Optional arms | Human time | Prod risk |
|---|---|---|---|---|
| E-KB | 0 | local GPU; ≈ 0.9 M reasoning tokens | ≈ 2 h labelling | none (read-only) |
| E-FC | 0 | ≈ 0.3 M reasoning tokens | 0–2 h | none |
| E-IMG | ≈ 0.18 M jev tokens / round | — | CI setup | none (shadow CI step) |
