# Agent and swarm evaluation (§16.7 CIA)

CIA = U(configuration) − U(best eligible single agent), on equal tasks, authorisation and resource accounting. More agents are
never assumed to be better. This maps the §16.7 factorial onto what DjimitFlo actually runs, and states which cells can be measured
now. Numbers: prod read-only 2026-10-09 (see `INTELLIGENCE_BASELINE.md`).

## What runs today (30 d, worker_leases)

| Role × runtime | completed | failed | cancelled |
| --- | --- | --- | --- |
| maker × opencode | 104 | 85 | 28 |
| maker × remote (workstation atomic@llama-router) | 39 | 50 | 16 |
| maker × atomic | 0 | 15 | 1 |
| checker × opencode | 71 | 11 | 5 |
| security_checker × opencode | 72 | 11 | — |
| maker/checker × manual (PR-review loop, no outcome) | 583 / 578 | — | 241 / 173 |

Production oracle-lane value (skill_outcomes, 30 d): opencode maker 41/126 verified (0.325 [0.250, 0.411]), remote maker 3/53
(0.057 [0.019, 0.154]). The remote maker was 0/41 before #699 and 2/3 after it.

## Factorial mapped to existing parts

| §16.7 cell | DjimitFlo equivalent | Exists? | Measurable now? | Evidence today |
| --- | --- | --- | --- | --- |
| Single agent | maker alone, executed checks only, no LLM reviewer | **No prod arm.** Every oracle-lane run has a checker + security_checker gate | Offline only (F1 harness, executed checks as judge) | — |
| Single agent + retrieval | maker + memory rules / examples / KB context | Yes (assignment context) | **Yes, randomised:** `MEMORY_HOLDOUT_RATE=0.3` withholds rules | rules 29/42 vs withheld 4/6, p = 1 (underpowered); KB citations do not move panel decisions (F4) |
| Planner + maker | panel → goal → maker | Panel exists, but 90 % `needs_evidence`; shipping lanes skip it | No (panel is not randomised; its AUC 0.98 is leakage) | — |
| Maker + independent checker | maker + checker (+ security_checker) | **Yes, the shipping pipeline** | **Yes, offline:** F1 planted defects | checker AUC 0.875; accept good 18/20, defective 3/20; kind B (`toBeDefined`) 3/7 accepted |
| Maker + checker, cross-family | checker on a different model family | Not yet | Planned: EXP-1 (F2) | — |
| Adaptive specialist swarm | evolve siblings (two maker species, contest picks winner) + effort controller | Yes; X1 randomises siblings on/off | **Yes, randomised (X1)** | on 0/3 vs off 8/11 verified, Fisher p 0.055, n = 15 (interim, not a stop) |
| Committee / multi-forecaster | committee swarm (9 members) on the workstation | Yes (shadow) | Forecast quality only | 0/20 forecasters decision-grade; no positives in the window |
| Full swarm + causal investigator | + outcome attribution / failure_cause | Attribution yes; `failure_cause` off since 08-10 (75 % uncertain) | Not as an arm | attribution is a labeller, not an agent in the loop |
| Council / swarm sessions / consensus | multi-model council, swarm sessions | DEAD (every 3-model session failed; swarm sessions throw) | No | W8 retirement review |

## Marginal-value view (what each added agent costs and buys)

| Added component | Cost (7 d, efficiencyView) | Measured value | Verdict now |
| --- | --- | --- | --- |
| checker (opencode) | 16.7 M cloud tokens | discriminates planted defects (AUC 0.875, n = 40) | **keep** (F1 not falsified) |
| security_checker (opencode) | 14.6 M cloud tokens | no separate discrimination test | INSUFFICIENT_EVIDENCE; candidate for an F1-style planted-vulnerability test |
| evolve sibling (second maker) | 2nd maker run per goal (~0.7 M tokens/attempt in EP) | X1 interim points negative (n = 15) | INSUFFICIENT_EVIDENCE; keep randomising |
| memory rules in context | prompt tokens only | holdout: no difference; refit: 0 rules with raw fitness > 0 | INSUFFICIENT_EVIDENCE; F3 continues |
| KB context in panels | panel tokens | cited 44/52, decision mix unchanged | no evidence of value |
| committee (9 members) | ~1.3 GPU-h/day (EP), capped at 10/day | 0/20 decision-grade forecasters | no evidence of value; under EP kill criteria |
| residents (commons) | 1.7 M tokens/30 d (llm_model_calls) | no forecast skill; paused | no evidence of value |

## Correlated errors and coordination costs

- **Correlated errors.** Maker, checker and security_checker all run on opencode with the same provider family, so their errors
  are expected to correlate. No correlation metric exists. EXP-1 stage 1 gives the first discordance table.
- **Coordination overhead.** The token blow-up of #716 was coordination waste: reviewers re-ran installs because check results
  were invisible (26–29 steps × ~36 k tokens ≈ 1.03 M per reviewer). It is fixed, but no post-fix measurement exists yet.
- **Duplicate work.** Superseded/cancelled maker leases (opencode 28, remote 16 in 30 d) and the stuck-prepared evolve retry
  (#719, 1 of 66 evolve runs).

## Next measurable cells, in order

1. **Maker + checker vs maker + cross-family checker** (EXP-1 stage 1, offline, ~5 M tokens).
2. **Siblings on vs off** (EXP-2, running).
3. **Retrieval on vs off** (EXP-3, running; raise the holdout to reach power).
4. **Single agent without LLM reviewer**, offline only: run the F1 items through the executed checks plus the deterministic
   weak-assertion check (EXP-5) with no LLM checker. If deterministic gates reach the checker's AUC, the checker's marginal value
   is its cost. No prod arm without the checker is proposed: removing a gate is a risk decision for the operator.

Topologies, agent factory and evolutionary swarms (CR F6–F8) stay deferred until 1–3 show positive marginal value with a CI above 0.
