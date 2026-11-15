# M0 — baseline and re-verification of H1–H10 (2026-11-14)

Operator master prompt "Gecontroleerde uitvoering, aantoonbare waarde en meetbare evolutie", milestone M0.
Read-only: no prod writes, no restarts, no model calls. Source = built artefact = running prod: `7758d153`
(`/health` `commit_matches_build: true`).

| File | Content |
|---|---|
| `H1-H3-execution-chain.md` | nested spawn, grants, completion chain; normal loop path properties A–H |
| `H5-H6-H10-evolution.md` | skills/memory/variants delivery vs use, reward/retention definitions, growth vs value, the four evolution links |
| `H7-H8-H9-scheduling-provenance-djimitsec.md` | scheduler/poller truth, synthetic graph provenance, DjimitSec finding lifecycle |
| `inventory-summary.md`, `inventory-matrix.json` | 194 surfaces, 587 routes, schedulers, flags, reconciliation, 24 value contracts (proposals) |

H4 (security boundaries) is summarised below only. The full report describes an exploitable path and stays out of this
public repository until the fix ships (same rule as earlier security reviews).

## Hypotheses

| id | status | evidence | one line |
|---|---|---|---|
| H1 | BEVESTIGD (dormant) | CODE+RUNTIME | `requestSpawn` stops at `prepared`; only the proof-run starts children; 52 spawn rows, all proof-run, last 2026-06-29 |
| H2 | BEVESTIGD | CODE+TEST+RUNTIME | grant booked as consumed at prepare, never settled; no token/time limit reaches the child (granted 1.3 M, used 6.41 M) |
| H3 | BEVESTIGD | CODE+RUNTIME | only proof-run closes `sub_agent_spawns` / `spawn_trees`; 8 of 52 spawns and 4 of 26 trees stale |
| H4 | BEVESTIGD | CODE+RUNTIME | ToolBroker and MCP tool permissions are consulted on no executor path; CLI makers are not isolated from the control plane (details private) |
| H5 | BEVESTIGD | CODE+RUNTIME | no artefact class proves use in production; memory rules and examples are credited on delivery alone |
| H6 | BEVESTIGD | CODE+RUNTIME | bandit reward = verified label (incl. LLM checker); retention label cannot fail (110 of 110 survived); memory holdout shows no benefit |
| H7 | BEVESTIGD (partly mitigated) | CODE+RUNTIME | 10 of 66 schedulers cannot show `failing`; sticky `failing`; stall watch blind 1 h after boot; #1231 open |
| H8 | BEVESTIGD | CODE+RUNTIME | 120 of 120 explainer graph snapshots synthetic, shown as fact in 91 of 91 architecture sections |
| H9 | BEVESTIGD | CODE+RUNTIME+TEST | a security finding can close without a commit-bound retest; DjimitSec `UNKNOWN` receipt recorded as `completed` |
| H10 | GEWIJZIGD | RUNTIME | 218 of 218 proposals (30 d) from gap_analysis; other sources off; 1 838 agent messages, 0 proposals |

## Normal execution chain (loop path), properties A–H

A gap (retry maker approval swallowed: 13 of 76 retry makers in 30 d ran unread) · B pass · C partial (remote fenced, local
lease writes unversioned) · D pass · E pass for loops · F partial (cancelled lease still runs on approval) · G pass in
code, runtime not verifiable without an admin token · H pass for settling, resume in shadow.

## Evolution links

Reward partial (security checker discriminates: SEC-F1 2026-11-14 AUC 0.952, 19/20, 2/26 false rejects; the labels the
learners select on cannot fail) · variation gym only · retention untested (nothing promoted) · selection partial
(7 trials, 0 promoted). Smallest complete cycle: the `skill:oracle-gate` route on the oracle lanes with its 50 % per-goal
holdout (receipt chain already in code).

## M1 work started from these findings

- `fix/retry-approval-and-dead-lease-tasks` — A and F.
- `fix/attribution-credit-on-use` — H5 D1/D3/D4: no credit on delivery alone, per-block delivery receipts, no baseline-genome credit.
- `fix/safe-git-and-checker-config` — H4 D3/D4.

## Operator decisions surfaced

1. Maker isolation from the control plane (H4 D1): run makers under their own uid; image and security-boundary change.
2. ToolBroker / MCP permissions (H4 D2): wire one real choke point, or retract the mediation claim.
3. Synthetic explainer graphs (H8): suppress them or carry the synthetic flag through to the text.
4. Security finding closure (H9): require a commit-bound retest.
5. Value-contract proposals in `inventory-summary.md` (pause/retire candidates).
