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
| `LOOP_REVIEWER_APPROVAL_INHERIT` | one human approval per run; reviewers inherit it |
| `QUEUE_HYGIENE_ENABLED` | 6-hourly sweep: work-item TTL, zombie goals/runs |
| `DISK_GUARD_ENABLED` | warn at 80 %, critical at 90 % disk |
| `TYPESAFE_API_KEY`, `TYPESAFE_<JUDGMENT>_MODE` | TypeSafe judgments, see ADR 0002 |
| `DREAM_STATE_ENABLED` + `TYPESAFE_FAILURE_CAUSE_MODE` | 6-hourly replay of failed runs, cause classification, recurring causes → memory candidates (ADR 0003) |
| `COMMONS_EVIDENCE_PACK_ENABLED`, `COMMONS_AGENDA_FROM_FAILURES` | Commons rounds carry platform facts; undiscussed dream-state failures come first |
| `SOCIAL_AUTOPILOT_RESIDENTS` | per-resident model, e.g. `commons-oracle=openai-compatible:kimi-k2.6,…` (no `:` in model names) |
| `AUTONOMY_SHADOW_ENABLED` | record "would auto-approve" per loop approval; approves nothing |
| `SEGML_ENABLED`, `DREAM_CYCLE_LEGACY_ENABLED` | restore the gated-off legacy loops (off since 2026-09-24) |
| **Operator decisions** `NEEDS_GROUNDING_TRIAGE_ENABLED`, `DREAM_STATE_PROPOSALS_ENABLED`, any `…_MODE=enforce` | act on shadow judgments; switch on only after the funnel agreement numbers justify it |

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
