# Runbook: self-improvement loop operations (production)

Production: container `djimitflo-live` on `vps-agentical` (100.86.47.122), `https://djimitflo.agentical.nl`,
compose in `/srv/djimitflo/compose.yml`, environment in `/srv/djimitflo/runtime.env`, database `/data/djimitflo.sqlite`
inside the container (`/srv/djimitflo/data` on the host).

## Deploy

```bash
scripts/deploy-vps.sh <40-char-sha>            # dry run: prints the remote script
scripts/deploy-vps.sh <40-char-sha> --apply    # clone, build, chown, swap, health-wait, roll back on failure
curl -s https://djimitflo.agentical.nl/health | jq .build   # commit_matches_build must be true
```

- Use only this script. `/srv/djimitflo/deploy-agent-commons.sh` is disabled (2026-09-23): it skipped the `chown` of the
  runtime source, so `.git` stayed root-owned and every loop run failed with `WORKTREE_CREATE_FAILED ... cannot lock ref`.
- GitHub "Push on main" does not deploy.
- The script passes `VCS_REF`, `BUILD_SOURCE` and `BUILD_TIME`; `/health` reports them as `build.*`.

## Flags (runtime.env)

Back up before editing (`cp -p runtime.env runtime.env.bak-<date>`), then `docker compose up -d djimitflo`.

| Flag | Effect |
|---|---|
| `SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED`, `_REFINEMENT_ENABLED`, `_OBJECTIVE_LOOP_ENABLED` | the proposal → panel → goal → run pipeline |
| `SELF_IMPROVEMENT_GOAL_ON_APPROVE` | create the goal right after panel approval instead of the hourly cycle |
| `TEST_GAP_SOURCE_ENABLED` | deterministic, fully grounded test-only proposals (max 2/day, 2 in flight) |
| `REFLECTION_PROPOSALS_MAX_PER_DAY` | cap on reflection proposals per 24 h (unset = no cap); they rarely ground, so a bounded inflow keeps `needs_grounding` drainable |
| `TEST_GAP_EXPORTS_ENABLED` | second test-gap lane: exported functions of tested services that no test names → a new `<service>.exports.test.ts` (same caps) |
| `LOOP_REVIEWER_APPROVAL_INHERIT` | one human approval per run; reviewers inherit it |
| `APPROVAL_TTL_MS` | how long a pending approval stays valid (default 1 h, 5 min .. 7 days); prod uses 12 h so night-time requests survive until the operator is back |
| `LOOP_REVIEWER_TIMEOUT_MS` | time a daemon-dispatched checker/security checker gets (default 300 000, max 900 000) |
| `LOOP_EVOLVE_ENABLED`, `LOOP_EVOLVE_SPECIES` | evolve-loop pilot (test-gap goals): extra makers per species (`runtime[@model]`, max 2); fitness in code picks the one maker that goes to review |
| `LOOP_BANDIT_ENABLED`, `LOOP_BANDIT_SPECIES`, `LOOP_BANDIT_MAX_SHARE` | E12: maker species chosen per run by Thompson sampling over `skill_outcomes`; first species is the incumbent, challengers get ≤ 10 % of runs until they have 20 outcomes |
| `LOOP_SKILL_CARDS_ENABLED`, `LOOP_MEMORY_RULES_ENABLED` | K1/K2: maker assignment shows accepted loop-written tests of the same lane as examples, and ≤ 3 distinct engineering rules promoted in the last 14 days (each read logged in `memory_access_log`) |
| `LOOP_AUTO_DRAFT_PR_ENABLED` | a run that passes every gate is pushed to its branch and opened as a *draft* PR (needs `GITHUB_REPOSITORY` + `GITHUB_TOKEN` with contents + pull-requests write); the merge stays human |
| `QUEUE_HYGIENE_ENABLED` | 6-hourly sweep: work-item TTL, zombie goals/runs |
| `DISK_GUARD_ENABLED` | warn at 80 %, critical at 90 % disk |
| `TYPESAFE_API_KEY`, `TYPESAFE_<JUDGMENT>_MODE` | TypeSafe judgments, see ADR 0002 |
| `DREAM_STATE_ENABLED` + `TYPESAFE_FAILURE_CAUSE_MODE` | 6-hourly replay of failed runs, cause classification, recurring causes → memory candidates (ADR 0003) |
| `COMMONS_EVIDENCE_PACK_ENABLED`, `COMMONS_AGENDA_FROM_FAILURES` | Commons rounds carry platform facts; undiscussed dream-state failures come first |
| `COMMONS_AGENDA_GROUNDING` | after failures, the newest `needs_grounding` proposal becomes the topic, with candidate files from `git grep`; residents answer `TARGET:` / `TEST:`, checked in code and recorded as a `commons_grounding` judgment |
| `COMMONS_GROUNDING_APPLY` | **operator decision**: a valid Commons grounding becomes one grounded refinement that goes to the specialist panel |
| `SOCIAL_AUTOPILOT_RESIDENTS` | per-resident model, e.g. `commons-oracle=openai-compatible:kimi-k2.6,…` (no `:` in model names) |
| `AUTONOMY_SHADOW_ENABLED` | record "would auto-approve" per loop approval; approves nothing |
| `LOOP_AUTO_APPROVE_TEST_GAP` | **operator decision** (J5): when the shadow rule says yes, a test-gap maker approval whose artifact is one new `__tests__/*.test.ts` is approved by `autonomy:test-gap-rule-v1`; the `auto_approved_scope` gate fails the run if the maker touched any other file. Checker and human merge stay |
| `SEGML_ENABLED`, `DREAM_CYCLE_LEGACY_ENABLED` | restore the gated-off legacy loops (off since 2026-09-24) |
| **Operator decisions** `NEEDS_GROUNDING_TRIAGE_ENABLED`, `DREAM_STATE_PROPOSALS_ENABLED`, any `…_MODE=enforce` | act on shadow judgments; switch on only after the funnel agreement numbers justify it |

## Prod status (2026-09-25, E4)

| Area | State | Measured |
|---|---|---|
| Proposal → panel → goal → run → verify | on | 7 verified / 7 d; test-gap lane 6/6, 0 regressed |
| Test-gap + exports lanes | on, 4/day | goal risk from type (#397) keeps them in objective mode |
| Reflection cap | on, 25/day | 0 new since 24-09 22:00 while the rolling 24 h count (60) drained |
| Commons grounding guild + APPLY | on | valid groundings after the path-redaction fix (#396); first refinement parked by the panel |
| Skill cards (K1) | on | examples in maker assignments |
| Memory rules (K2), evolve, bandit | off | wait for token data (#402) and ≥2 species with outcomes |
| Auto-approve test-gap (J5) | off | operator decision; shadow rule history is the evidence |
| Auto draft PR (G4) | off | needs `GITHUB_TOKEN` with contents + PR write |
| TypeSafe judgments | 7 × shadow | enforce is an operator decision |
| Auto-deploy (J2) | on | systemd timer, several unattended deploys |

## Read-only probes

There is no `sqlite3` binary on the host. Run a small read-only script inside the container:

```bash
cat > /tmp/probe.js <<'EOF'
const D = require('better-sqlite3'); const db = new D('/data/djimitflo.sqlite', { readonly: true });
console.log(db.prepare("SELECT status, COUNT(*) n FROM self_improvements GROUP BY 1").all());
EOF
scp /tmp/probe.js vps-agentical:/tmp/probe.js
ssh vps-agentical 'docker cp /tmp/probe.js djimitflo-live:/tmp/probe.js && docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/probe.js'
```

Useful queries: `judgments` grouped by `judgment, decision`; `loop_runs` by status since a date; `worker_leases` of a run
(role, status, `json_extract(metadata,'$.verdict')`); `loop_events` of a run in order; `approvals WHERE status='pending'`.

Note: the event `loop_verified` means "verification ran", not "passed". Check the run status and `gates_json`.

## Failure modes seen and what they mean

| Symptom | Cause | Fix |
|---|---|---|
| `WORKTREE_CREATE_FAILED ... cannot lock ref` | runtime source `.git` not owned by uid 1001 | redeploy with `scripts/deploy-vps.sh` (it chowns) |
| checker/security checker: "No diff available", `insufficient_evidence` | maker added only new files; `git diff` omitted untracked files | fixed in #334 (`workingTreeDiff`) |
| goal failed `approval expired` | nobody approved within the window | infrastructure-class failure: proposal is re-scheduled (max 2, #332); approve in Approvals |
| auto-review ticks `reviewed=0` for hours | no proposal in `proposed`; all parked | check the funnel; `needs_grounding` has no consumer yet |
| `checker_dispatch_failed: CHECKER_LEASE_NOT_FOUND` | dispatch attempted before the checker lease exists | benign when the checker runs afterwards |
| TypeSafe latency ~27 s on single calls | retries/backoff right after a deploy | none; normal is 0.3–1.4 s |
| maker `exit 1` / type-check fails in the worktree | loop worktrees have no `node_modules` | makers and reviewers run `npm ci` in their own worktree (#344, #347) |
| checker `accepted` but `checker_verdict` gate fails | checker's own install rewrote `package-lock.json` → read-only contract broken | lockfile-only rewrite restored before the check (#347) |
| checker exit 1 with `external_directory … deny` | reviewer tried to read the maker's worktree | reviewers work only in their own worktree (the maker's changes are snapshotted into it) |

## Re-queue a proposal (one-off, operator-approved)

Only for proposals that failed on infrastructure. In one transaction: set `self_improvements.status = 'scheduled'`, cancel its
`blocked`/`verifying`/`running`/`planning` runs, and detach its goals (`goals.improvement_id = NULL`, keep the id in
`metadata.improvement_id`) so the unique `goals.improvement_id` index allows a new goal. Print the before-state first.

## Auto-deploy (J2)

`scripts/auto-deploy.sh` runs on the VPS every 10 minutes (`scripts/systemd/djimitflo-auto-deploy.{service,timer}`) and deploys
`main` only when: it differs from what runs, every CI check on it succeeded, `main` has not moved for 20 minutes
(`AUTO_DEPLOY_SETTLE_MIN`), and no loop worker is running. It uses `deploy-vps.sh --local` of that commit (health wait + rollback).

- Install: `cp scripts/auto-deploy.sh /srv/djimitflo/auto-deploy.sh && cp scripts/systemd/djimitflo-auto-deploy.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now djimitflo-auto-deploy.timer`
- Stop: `touch /srv/djimitflo/AUTO_DEPLOY_DISABLED` (remove the file to resume). Log: `journalctl -u djimitflo-auto-deploy`.
