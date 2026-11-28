# PR-ABC-001 v1: pre-registration — does the engineering project room earn its calls?

**Status:** frozen together with `manifest.json` (task sets, seed, budget, hidden check, digest). Hashes of both are in
`PREREG.sha256`. A later change is a deviation, listed in `RESULTS.md` with its reason. **Not run:** see `RESULTS.md`.

## 0. What is known when this is frozen

- The room is built and verified locally with scripted adapters only (`project-room.test.ts`, `project-room-abc.test.ts`).
  No model has produced a review or a plan through it. Nothing is known about its effect.
- ACE-001 (negative-evidence registry) REJECTED similarity-retrieved maker context on oracle lanes, and PL-001 REJECTED
  static procedure lines in a maker prompt. A plan block is a different treatment (made for this task from its source), but
  the prior for "more maker context helps" in this system is not favourable. This comparison exists to find out, not to confirm.
- The 30 tasks were selected by seed before any run. The task subjects (commit messages) were visible while the selection
  code was written; no task was added or removed by hand.

## 1. Arms

| Arm | Workflow | Model sessions per task |
| --- | --- | --- |
| A | the current workflow, unchanged (`COMMONS_PROJECT_ROOM_MODE=off`) | maker |
| B | one planner call (`variant: single`), then the same maker | planner + maker |
| C | architecture reviewer, then implementation planner (`variant: two_stage`), then the same maker | reviewer + planner + maker |

B and C produce the same plan schema and use the same downstream maker, runtime, model routing and hidden check. All three
arms have the same total budget per task (`manifest.budget`): C gets nothing extra for its extra role, so its profile calls
leave less for its maker. A differs from B/C as a whole workflow; A vs B/C is reported as that, not as the effect of a plan.

## 2. Tasks

`manifest.json`: 30 commits mined by `gym-task-miner` from this repository's history (one small service change with one or
two test files), minus tasks whose source is a protected path (excluded for every arm, because a plan may not schedule such
an edit), shuffled with seed 20261126: the first 20 are the development set, the last 10 the holdout. 23 distinct source
files; tasks on the same file are not independent, which narrows nothing here because the analysis is paired per task.

Per task-arm: a repository that holds only the parent commit and its ancestors, a fresh in-memory database and a fresh loop
service. The task text is the commit subject. The commit's own test files are the hidden acceptance check: placed in the
maker's worktree and run only after the maker has finished. Planner and maker never see them.

## 3. Outcomes

- **Primary:** PASS = the hidden check exits 0 on the maker's result. FAIL = it does not, or the room could not produce a valid
  plan (that workflow did not solve the task). EVALUATION_ERROR = the run or the check could not be carried out
  (runtime refused, call failed, check did not start): not a verdict on the task. NOT_RUN = no row.
- **Secondary:** tokens per PASS, duration, plan revisions used, share of review claims whose sources resolved. Unknown stays unknown.
- Every task stays in every arm's denominator. One rerun is allowed for an EVALUATION_ERROR, for every arm alike; a rerun
  replaces the row and is never an extra task.

## 4. Order of work

1. One-task smoke run (`--task <id>`) on the development set to confirm that the maker worktree has its dependencies and the
   hidden check starts. A failing precondition is fixed before the pilot and noted as a deviation; it is not a result.
2. Development set (20 tasks): prompts and profiles may be adjusted on these results. Each adjustment bumps `PROFILE_VERSION`.
3. Holdout (10 tasks): run once with the final profile version, analysed once. After that the holdout is used up.

Arm order per task is fixed by `sha256('pr-abc-001:' + task id)` over the six permutations.

## 5. Analysis and decision (holdout only)

Paired per task: both-pass, only-first, only-second, neither; difference in pass proportion with Newcombe's paired 95 %
interval; exact McNemar p; the number of usable pairs (both arms PASS or FAIL). Fewer than 6 usable pairs: insufficient.

| Decision | Condition |
| --- | --- |
| Adopt C for this task category (operator decision) | C − B > 0 with the interval above 0, C − A not below 0, tokens per PASS of C at most 1.5 × that of B, and no arm-C run that edited outside its plan scope |
| Prefer B | B − A interval above 0 and C − B interval not above 0 (B is as good or better at lower cost) |
| Keep the current workflow | anything else, including insufficient pairs |

Ten holdout tasks can support a go / no-go for a larger registered study. They cannot support a general superiority claim,
and this document does not allow one.

## 6. Cost

At most 90 maker sessions and 90 profile calls (30 single-planner, 60 two-stage) for both sets; the token ceiling is the
per-arm budget (400 000) × 90 = 36 M tokens, a ceiling and not an estimate. On a flat subscription the cost is quota and
wall-clock time (each session is capped at 10 minutes; the full pilot is bounded by about 30 hours of sequential runs).
Starting it is an operator decision.

## 7. How to run

```bash
npx tsx packages/server/src/scripts/project-room-abc.ts run --manifest docs/research/project-room/manifest.json --set dev --rows <rows.jsonl>            # schedule and ceiling only
npx tsx packages/server/src/scripts/project-room-abc.ts run --manifest docs/research/project-room/manifest.json --set dev --rows <rows.jsonl> --task <id> --live   # smoke run
npx tsx packages/server/src/scripts/project-room-abc.ts run --manifest docs/research/project-room/manifest.json --set holdout --rows <rows.jsonl> --live
npx tsx packages/server/src/scripts/project-room-abc.ts analyse --manifest docs/research/project-room/manifest.json --rows <rows.jsonl> --set holdout
```

The runner refuses a runtime without an enforced read-only mode for the profiles (today: only codex qualifies) and refuses a
manifest whose digest does not match its content.
