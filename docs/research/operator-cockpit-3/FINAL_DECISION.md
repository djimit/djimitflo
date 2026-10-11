# Operator Cockpit 3.0: final decision

## Verified improvements
Each was checked by an independent prod reconciliation (B3, read-only), not only by the author's tests.

| Improvement | Before (22f7fcf7) | After (da864adf, prod) | State |
|---|---|---|---|
| No false-green guardrails | a null value passed every limit | `state` per guardrail; null → UNKNOWN | I T V D P |
| Regression attribution | 12 "maker" | 4 maker / 26 reviewer / 0 environment / **8 unknown**, DEGRADED | I T V D P |
| Decision counts | requeue 43 (LIMIT 50) | 18 operator + 21 budgeted / 11 unknown / 6 not actionable, all listed; total 52 deduped | I T V D P |
| Token cost | 2.58 M "per verified" (mixed cohorts) | spend 2.37 M vs direct 0.91 M | I T V D P |
| Reflection guardrail | green while capped at 0 | NOT_APPLICABLE | I T V D P |
| Detector health | swallowed errors | per-detector ok / error / not_applicable; 0 errors on prod | I T D P |
| Energy | 12.7 verified/kWh | INSUFFICIENT_EVIDENCE (23 % coverage); exclusive Wh | I T D |
| Audit integrity | approver = `system`; cancel and memory unaudited | human actor recorded; `self_approved` visible | I T D |
| Deploy pipeline | blocked by the scheduled wiki check and a gh CVE | #744 + #748; deploy ran 15:26Z | I T D P |

## Not proven
- **Phase 3 (decision prioritisation by expected value) was not built.** The queue was reduced by classification instead: 73 shown, 88 true, 29 genuine human decisions.
  - *Smallest next experiment:* rank needs-you items by (expected verified gain × reversibility) / operator minutes, in shadow. Log the ranking, then check after 2 weeks whether the operator acts on the top 5 first.
- **Phase 5 (routing / swarm optimisation) was not built.**
  - *Smallest next experiment:* already running. X1 (siblings on/off, target 94/arm) and F2 (cross-family checker, target 93/arm) give the marginal-value answer. Read them at target.
- **Intelligence gain:** INSUFFICIENT_EVIDENCE across VIG, survival (n = 2), memory and forecasting. Gym success (80.8 %) does not transfer to production (5.7 %). See EVOLUTION_VALIDATION.md.
- **UX "answers in seconds":** no usability test was run.
- **Adversarial scenarios 6, 10 and 11:** measured but not enforced or tested (TEST_EVIDENCE.md).

## Blocker register (priority order)

| # | Blocker | Owner | Next step |
|---|---|---|---|
| 1 | Holdout epochs past the reuse limit (mined 11/10, mutant 12/10); promotion is not blocked in code | operator (fresh `GYM_HOLDOUT_EPOCH`) + mine (enforce the block before dream evolution resumes) | before trials resume |
| 2 | 22 loop draft PRs wait for a human merge (largest share of the genuine queue) | operator (`merge-loop-drafts-1009.sh`) or earned auto-merge (shadow since 08-10) | review the shadow decisions |
| 3 | Merge-survival ground truth n = 2 | time | ~19-10 |
| 4 | 11 unattributed regressions | mine | run the #736 backfill rules as annotations |
| 5 | POST /api/federation/register is login-only | operator (auth decision) | — |
| 6 | Scenario 6/10/11 decision tests missing | mine | small PR |
| 7 | #749 and #750 not yet deployed | train | after merge, auto-deploy |
| 8 | Panel unparseable = 2 keeps health BREACHED until 13-10 (glm-5.3-flash window of 06-10) | none | ages out |

## Release recommendation
**Keep da864adf in production, and ship #749 + #750 in the next deploy.** All changes are read-only or audit-adding, additive in contract, and individually revertible (CHANGELOG.md).

The cockpit now reports BREACHED honestly (panel unparseable plus a gym stall), instead of a false green. After #750 the gym part clears, and the panel part ages out on 13-10.

Do not treat the cockpit as evidence of intelligence improvement. It measures operations and throughput truthfully, and intelligence remains INSUFFICIENT_EVIDENCE.
