# OpenHuman — PoC results (Phase 5, 6, 7, 8, 10)

| Phase | Ran? | Why |
|---|---|---|
| 5 OpenHumanExecutor PoC | No | The gate failed in Phase 2: competing authorities cannot be proven off. There is also no reproducible build (GPL submodules, one private). A PoC against a mock binary would be a fake green. |
| 6 TinyJuice experiment | No | The engine (compressors, CCR cache, router) is only in the GPL `tinyjuice` module. Fetching it is the dependency step that the supply-chain analysis rejects. The adversarial fixture (10k log lines + 1 security-critical failure) stays specified for a future permissive engine. |
| 7 Jev benchmark | No | OpenHuman's Jev is a tool ranker behind a hosted proxy. Djimitflo's own jev already has measured agreement data (funnel: proposal_prescreen 0.82). |
| 8 Memory Tree projection | No | No consumer (YAGNI) |
| 10 Benchmarks | No | Nothing buildable; no numbers, nothing extrapolated |

## Changed files

| File | Rationale |
|---|---|
| `reports/openhuman-20261001/*.md` (4 files) | The deliverables. No code, test, flag, dependency or config was changed. |

## Rollback plan

Delete the branch `docs/openhuman-evaluation-20261001` (local only, not pushed). Prod, main and the user's checkout are unchanged. Rollback was not *tested*, because there is no runtime change to roll back.

## Remaining risks

1. **Re-evaluation pressure.** OpenHuman is active (40k stars, daily submodule pushes), so the HOLD needs a concrete re-open trigger (in OPENHUMAN_FIT_GAP.md), not a calendar date.
2. **The verification is static.** Behaviour claims (sandbox strength, recoverability of TinyJuice, whether disabled tool groups stay off) were read from docs and code in the main repo. The implementations live in unfetched submodules.
3. **Licence.** Any later integration, even through a subprocess in the Djimitflo image, ships GPL-3.0 code. That needs a deliberate operator or legal decision, not an engineering default.
