# DI-001 H: operator cockpit "Decision Intelligence" section (design only)

Status: **specification, not built.**

Constraints:
- It reads **existing endpoints only**.
- There is **no new store**, no new table and no new scheduler.
- Nothing is written when the section renders.

Every tile has exactly one of three states:

| state | meaning | how it renders |
|---|---|---|
| `OK` | enough independent evidence to show a number with its interval | the value, the CI and the n |
| `INSUFFICIENT` | the data exists, but n or label variation is below the pre-registered minimum | the n against the needed n, with **no point estimate** |
| `UNKNOWN` | the source is missing, errored, or the quantity is not recorded | the reason; **never rendered as 0** |

## Rules the section must keep

1. **A missing row is UNKNOWN, never 0.** If a tile's window overlaps the LOST/UNVERIFIED window
   (2026-10-11T04:16:22Z → 2026-10-12T16:43:39Z), it carries an `affected by lost window` badge.
2. **No pooled accuracy across risk classes.** FA and FR are shown separately per risk class.
3. A reviewer- or checker-derived outcome is never shown as a correctness label for that same reviewer or checker.
4. No tile offers an action that changes authority (shadow → enforce). The section is read-only.
5. Every number shows its source endpoint and its window.

## Tiles

| # | tile | source (existing) | OK when | INSUFFICIENT when | UNKNOWN when |
|---|---|---|---|---|---|
| 1 | **Independent label supply**: positives / negatives by class (oracle, policy, merge survival, operator) | `GET /api/health/attribution?days=30` (`attributionSummary`): classes per settled run | ≥ 5 independent negatives in the window | fewer than 5 negatives. **Today: 0 oracle negatives**, so INSUFFICIENT. | endpoint error, or `OUTCOME_ATTRIBUTION_ENABLED` off (`enabled: false`) |
| 2 | **Forecaster skill**: per forecaster, skill vs per-source base rate with CI | `GET /api/health/forecasts-v2` (`forecastScoresV2`): `state`, `skill_ci`, `brier_gain_ci` | `state = 'decision_grade'` | `state = 'insufficient'` | forecaster absent / endpoint error |
| 3 | **Forecast leakage**: share of forecasts written after the outcome | none today. The cockpit cannot compute it: no endpoint exposes `judgments.created_at` vs run completion. | — | — | **UNKNOWN (not exposed)**. Shown with the DI-001 offline value (49/69) as a static note, with its date. |
| 4 | **Merge survival**: settled survived / regressed | `GET /api/health/cockpit` (`operatorCockpit` draft-PR section: merged loop PRs still settling). The settled survived/regressed split is computed by `survivalCounts(loopPrSettlements(db))` (`merge-survival.ts`). Where a payload does not carry that split, the tile is UNKNOWN until an existing endpoint does: no new store. | ≥ 30 settled | < 30 settled (today 2 on the DI-001 population) | endpoint error |
| 5 | **Operator labels**: D5 prescreen labels and CAR audits | `GET /api/self-improve/decisions` (`prescreen.labelled / wrong`, D5 gate text); CAR from `GET /api/health/evolution-evidence` (`intelligenceEvidence` → metric `CAR`, which carries its own `INSUFFICIENT_EVIDENCE` state) | D5 ≥ 30 labelled; CAR state `ok` | below those gates | endpoint error / permission (`evolution-evidence` needs `manage:config`; viewers see UNKNOWN with "needs manage:config") |
| 6 | **Decision cost**: tokens per consumer per day (cloud / local) | `GET /api/health/efficiency` (`efficiencyView`, token ledger by consumer) | tokens recorded for the consumer | — | tokens not recorded (committee today) → UNKNOWN, **not 0** |
| 7 | **Human capacity**: accepted changes per day vs a 30 min/day budget → review minutes per change | `GET /api/health/cockpit` (counts) + the budget constant, 30 min (operator weight, LOSS.md) | ≥ 3 days of counts | < 3 days | counts missing |
| 8 | **DI-001 verdict**: the latest offline study result | static link to `docs/research/di-001/BASELINE.md`, with its PREREG sha and manifest `rows_sha256` | — | always shows the study verdict (today **INSUFFICIENT**) | — |

## Layout

The section has one row of tiles 1–2–4–5 (evidence supply) above one row of tiles 6–7 (cost and capacity). Tiles 3
and 8 sit in a footer as notes.

Each tile shows:
- the state chip;
- the value with its CI (OK) or "n / needed" (INSUFFICIENT);
- the source endpoint;
- the window;
- the lost-window badge when it applies.

There are no charts until a tile is OK for 2 consecutive weeks.

## Explicitly out of scope

- A new endpoint for leakage (tile 3). It would be the first candidate if the operator wants it, using
  `judgments.created_at` vs `loop_runs.completed_at`, read-only.
- Any persistence of cockpit state.
- Any score that combines tiles into one number.
- Any control that changes a flag.
