# CHECKPOINT — controlled execution audit (master prompt v1.1)

- Base SHA: `b496916b029dd4555c648203f4244706628ce79e` (origin/main, 2026-11-15 00:06Z). Running prod: `7758d153` (main not deployed: CI red, fixed by #1278).
- Branch: `audit/controlled-execution-2026-11-15` (worktree under the session scratchpad).
- Mandate: see `scope.json` → M0 + M1 + M2, ≤ 5 draft PRs, prod read-only, no real runtimes, no merges/flags from this session.
- Budget used: wall clock from 00:10Z; tokens not shown by the environment (not measured ≠ 0).

## Steps
| # | step | status | commit / PR |
|---|---|---|---|
| 1 | preflight gate | GROEN | this commit |
| 2 | scope + checkpoint | done | this commit |
| 3 | frozen denominators | done | 2e33cc5a |
| 4 | static re-verification 3.2 + H1–H10 on b496916b | done (server source unchanged vs M0 base except experiment-registry.ts) | 27b2ef9d, eabcbe8e |
| 5 | S1/S2/S7 on E3 (local server, mock executor) | done: S1 FAIL, S2 FAIL, S7 FAIL (E3; S7-d E2) — 7 defects D-S1-1/2, D-S2-1/2, D-S7-1/2/3, see `scenarios.json` | 90b68b25 (tests) + this commit (scenarios.json) |
| 6 | M1 batch (red-green) | draft PRs | #1278 #1276 #1275 #1277 #1279 #1280 (red runs in verification.json) |
| 7 | M2 value / stop rules on existing carriers | draft PR | #1281 |

## Open questions to the operator
- Merge train (pinned heads in REPORT.md §2): #1278 first (main red), then #1276 #1275 #1277 #1279 #1280 #1281 #1274 #1260, this audit PR last (it carries the scenario tests as it.fails; rebase onto main after #1279/#1280 so the fixed versions win).

## Resume
`cd <scratchpad>/wt-ce && git pull --ff-only && cat docs/audits/controlled-execution-2026-11-15/CHECKPOINT.md`
