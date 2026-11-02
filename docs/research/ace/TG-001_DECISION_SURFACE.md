# TG-001 decision surface (pre-data)

**Status: PRE-DATA.** Computed 2026-10-11 before any TG-001 experiment was frozen in production and before the first physical
attempt. Generated with TG-001's own `pairedTable` → `tgInterpret` (`packages/server/src/services/tg-001.ts`), enforced by
`packages/server/src/__tests__/tg-001-prerun.test.ts`.

**Computed against:** no production analysis plan exists yet. The full plan fingerprint depends on the frozen tasks and prompts, so
it is created at freeze time. The surface depends only on the decision rules, whose canonical fingerprint is
`sha256(canonicalJson({ mde, alpha, ci_method, tests, interpretation }))` =
`5ca667b657f75ebd15357be33e28ba98efc83a91529efc454a0fd49a9cdbc9e7`. Those rule fields are part of every frozen analysis plan,
so a plan whose rules hash differs was not covered by this surface.

## Rules (frozen, unchanged)

- **SUPPORTED:** A − B ≥ 0.20 and the exact two-sided McNemar p < 0.05.
- **REJECTED:** the upper bound of the 95 % interval of A − B is below 0.20.
- **INCONCLUSIVE:** everything else. At n = 20 this extends the experiment to 40 tasks, with the same rules.

Both the McNemar test and the score interval depend only on (b, c, n), where b = A only and c = B only. So the verdict is a
function of the discordant cells alone. The test asserts that every (b, c) has exactly one verdict, whatever the split of the
concordant pairs.

## Counts over every possible table

Every (both_success, A_only, B_only, both_fail) table that sums to n:

| n | states | SUPPORTED | REJECTED | INCONCLUSIVE |
|---|---|---|---|---|
| 20 | 1 771 | 275 | 749 | 747 |
| 40 | 12 341 | 2 906 | 6 446 | 2 989 |

- **Coverage:** all three verdicts are reachable at both n.
- **Exclusivity:** no state satisfies two rules. SUPPORTED needs A − B ≥ 0.20, and REJECTED needs an upper bound below 0.20, which is at least A − B.
- **Same semantics at 20 and 40:** n = 40 uses the identical functions and thresholds.

## Defect found and fixed pre-data: the paired Wald interval

The interval in #776/#777 was the paired Wald interval. Enumeration showed two defects:

1. **Zero-width interval:** with zero discordant pairs it collapses to [0, 0]. Twenty concordant tasks then "prove" A = B with no uncertainty.
2. **Too narrow at small one-sided counts:** it rejected where A clearly led.
   - n = 20: b = 1, c = 0 had upper 0.146 → REJECTED.
   - n = 40: b = 4, c = 0 had upper 0.193 → REJECTED, although A won 4 tasks and B none.

**Fix:** the Tango (1998) score interval for the paired difference, `tangoInterval(b, c, n)`.
- At zero discordance it gives ±z²/(n + z²): ±0.161 at n = 20 and ±0.088 at n = 40.
- It depends on (b, c, n) only, like the exact McNemar test.
- The verdict is now computed on unrounded values. Rounding to 3 decimals could otherwise move a bound across 0.20.

**Thresholds not changed:** the MDE (0.20), α (0.05), the three rules and the stopping rule are unchanged.

Effect on the surface (states whose verdict changed, Wald → score):

| n | changed states | examples |
|---|---|---|
| 20 | 45 | b=1,c=0 R → I (upper 0.146 → 0.236); b=2,c=2 R → I (0.196 → 0.230); b=5,c=8 R → I (0.197 → 0.202) |
| 40 | 109 | b=4,c=0 R → I (0.193 → 0.231); b=4,c=1 R → I (0.182 → 0.211); b=5,c=3 R → I (0.188 → 0.204); b=17,c=21 I → R (0.200 → 0.196) |

SUPPORTED counts are identical, because SUPPORTED depends only on A − B and the exact McNemar p.

## Boundary cases (score interval)

| | n = 20 | n = 40 |
|---|---|---|
| Smallest table SUPPORTED | b=6, c=0: A − B 0.300, p 0.0313, CI 0.091…0.519 | b=8, c=0: A − B **0.200 exactly**, p 0.0078, CI 0.095…0.348 |
| SUPPORTED with c = 1 / 2 / 3 needs b ≥ | 8 / 10 / 12 | 9 / 10 / 12 |
| Smallest table REJECTED | b=0, c=0: CI −0.161…0.161 | b=0, c=0: CI −0.088…0.088 |
| Largest A-leading table still REJECTED | b=1, c=1: upper 0.199; b=1, c=0 is already INCONCLUSIVE | b=3, c=0: upper 0.199; b=4, c=0 is INCONCLUSIVE (upper 0.231) |
| First INCONCLUSIVE | b=1, c=0: A − B 0.050, CI −0.119…0.236 | b=4, c=0: A − B 0.100, CI 0.004…0.231 |

Boundary behaviour, asserted in the test:
- Effect exactly 0.20 with p < 0.05 is SUPPORTED (n = 40, b = 8, c = 0).
- An upper bound of exactly 0.20 is not REJECTED.
- A significant effect below 0.20 is INCONCLUSIVE.

Verdict grid (rows b = A only, columns c = B only from 0, S = SUPPORTED, R = REJECTED, I = INCONCLUSIVE):

```
n = 20                      n = 40
b= 0 | RRRRRRRRRRRRR        b= 0 | RRRRRRRRRRRRR
b= 1 | IRRRRRRRRRRRR        b= 1 | RRRRRRRRRRRRR
b= 2 | IIIRRRRRRRRRR        b= 2 | RRRRRRRRRRRRR
b= 3 | IIIIIRRRRRRRR        b= 3 | RRRRRRRRRRRRR
b= 4 | IIIIIIIRRRRRR        b= 4 | IIRRRRRRRRRRR
b= 5 | IIIIIIIIIRRRR        b= 5 | IIIIRRRRRRRRR
b= 6 | SIIIIIIIIIRRR        b= 6 | IIIIIRRRRRRRR
b= 7 | SIIIIIIIIIIIR        b= 7 | IIIIIIIRRRRRR
b= 8 | SSIIIIIIIIIII        b= 8 | SIIIIIIIRRRRR
b= 9 | SSIIIIIIIIII         b= 9 | SSIIIIIIIIRRR
b=10 | SSSIIIIIIII          b=10 | SSSIIIIIIIIRR
```

## Known properties, reported and not changed

- **McNemar and the interval can disagree.** In 140 (n = 20) and 680 (n = 40) states, "p < 0.05" and "interval excludes 0" disagree. That is expected for an exact test next to a score interval. The rules use p only for SUPPORTED and the upper bound only for REJECTED, so no state is contradictory.
- **Two looks inflate α.** INCONCLUSIVE at 20 extends to 40 and re-applies α = 0.05. The overall false-SUPPORTED rate therefore exceeds 0.05 (Bonferroni bound 0.10). This is the operator's pre-registered stopping rule, so it is reported and not corrected.
- **REJECTED is reachable with B ahead.** REJECTED also covers tables where B beats A (for example b = 0, c = 5). Assignment representation then cannot explain a gym > production gap. This is what the rule says.
