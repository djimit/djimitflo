# Controlled execution audit — report (master prompt v1.1, 2026-11-15)

Base `b496916b` (origin/main). Running prod `7758d153` (main not deployed: main CI red on two ACE-001 date tests, fixed by #1278).
Mandate (operator, 2026-11-15): M0 + M1 + M2, ≤ 5 draft PRs, prod read-only probes, no real runtimes, no paid model calls,
no merges/flags/deploys from this session. Session cost: wall clock ~01:10–03:00 local; tokens not shown by the environment (not measured).

## 1. What DjimitFlo demonstrably does on b496916b
- Normal loop path (goal → daemon tick → maker lease → deterministic checks → separate checker → verification → ledger row): **E3** (S1, mock executor). The engine leg (task → running → completed) **E3** separately; with the mock runtime the loop does not create an engine task, so the full chain and the engine are each proven, not in one run.
- Prepared work is never shown as success (prepared spawn, task held for approval, prepared work item): **E3** (S2), with two projection defects.
- A scheduler tick runs and a stopped timer is detected within 2 × interval: **E3** (S7).
- Preflight GROEN: `npm ci`, builds, nested-spawn tests 21/21.

## 2. Reproduced and fixed (draft PRs, pinned heads, each red on b496916b)
| PR@head | finding | red on base | green |
|---|---|---|---|
| #1278@81b22944 | ACE-001 tests on the real clock (main red since stop_by) | CI run 43656497600 | 26/26 |
| #1276@fb2716ee | M1-A/F retry approval swallowed; approval of an ended worker still runs | 7 of 10 fail | CI green |
| #1275@ccab0210 | H5 credit on delivery alone; per-block receipts | 8 of 44 fail | CI green |
| #1277@3c80b732 | H4 D3/D4 server git in maker worktrees; checker governed by maker-edited agent config | 21 of 170 fail | CI green |
| #1279@9daae443 | D-S1-2 maker ledger loses the token split (E5: 78 of 82 maker rows, 14 d) | 2 fail | 10 pass + 1 expected fail |
| #1280@2972601f | D-S7-1/2/3 scheduler health: 17 schedulers marked run before work; sticky failing; no escalation in shadow (flag SCHEDULER_STUCK_ESCALATE) | 20 of 23 fail | 23/23 |
| #1281@482d5204 | M2: loop stop conditions evaluated in shadow (flag LOOP_STOP_CONDITIONS_MODE) + value-contract coverage | 3 of 4 fail | 4/4 |
#1276, #1275, #1277 were opened 2026-11-14 (M0/M1 work under the earlier mandate); red runs re-recorded here. #1279–#1281 CI red only on the #1278 date tests.

## 3. Evidence level of the claims
- E3: S1, S2, S7; the fixes in #1276, #1279, #1280, #1281.
- E2: #1275 receipts, #1277 git hardening, D-S7-3, H1–H3 tests.
- E1 + E5 (read-only probes on 7758d153): H1–H10 statuses (`findings.json`); E5 numbers are the M0 probes of 2026-11-14 (same running build) plus the ledger probe of 2026-11-15.
- E4: none (no real runtimes under this mandate). S12 (two workers), S16 live DjimitSec: BLOCKED.

## 4. What changed measurably
Nothing in production yet: no PR of this session is merged or deployed. After merge + deploy: maker ledger rows get a token split; 17 schedulers report failure truthfully (cockpit scheduler health may show BREACHED — intended); stop-condition shadow rows start (expect `findings_planned` to say would_stop on every maker run — the contracts describe the planning step only).

## 5. Limitations, blocks, undecided
| item | the one action that lifts it |
|---|---|
| main red → no deploy | merge #1278 |
| S12 two-worker collaboration, E4 claims | mandate: allow a runtime + budget |
| live DjimitSec (S16) | a DjimitSec test resource |
| maker isolation (H4 D1) | operator decision (image + protected path) |
| D-S1-1, D-S2-1, D-S2-2, H8, H9 | `proposals/open-defects.md` → next session's PRs |
| S3–S6, S8–S11, S13–S15 | NOT_TESTED this session (budget M0–M2) |

## 6. Next investments (max 5)
1. **Merge train + deploy verification** (file level: none — operator runs `~/djimitflo-merge-m1.sh`; then read-only probe: ledger split on new maker rows, scheduler registry states, stop-condition shadow rows). Accept: each observed within 24 h of deploy. Stop: any post-deploy verdict not ok → revert that PR.
2. **Cycle-level stop rules** on the maker cycle (`proposals/value-contracts.md`): loop-service.ts contracts + loop-stop-conditions.ts; shadow first; accept when would_stop agrees with escalation outcomes on ≥ 30 runs.
3. **Maker isolation** (H4 D1): own uid for makers + deterministic checks; protected path → operator.
4. **Provenance of synthetic explainer graphs** (H8): repo-graph-builder.ts → explainer pipeline; test that follows a synthetic row.
5. **Commit-bound finding closure** (H9): finding-fix / security-regression path; finding stays open without a retest on the finding's commit.

## Verdicts (VOORGESTELD — final only after the verification session or the operator)
- **A. Werkiteratie afgerond: bewezen** for the mandated scope (M0 + M1 + M2), with S3–S6/S8–S11/S13–S15 NOT_TESTED.
- **B. Functionele doelstelling: gedeeltelijk bewezen** (E3 for the normal chain; no E4; no two-worker collaboration).
- **C. Evolutionaire verbetering: onbewezen** (no candidate evaluated on an unseen holdout; baseline stays active).
