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
| `LOOP_PR_BODY_V2` | UX-10, default off: loop draft-PR body adds lane, oracle check results, gate summary, diff stat, mutation score and (only with an https `DJIMITFLO_PUBLIC_URL`) a link to `/goals-loops?run=<id>`; names, statuses and numbers only, secret-redacted (public repo) |
| `FRONTIER_EXPERT_PERSONS_ENABLED` | FE-AREAS, default off: Frontier Experts are fields of interest (`area:<capability>`, backed by paper/repository units); with the flag off no person identity is created (Pacing ingestion, author enrichment and person peer review skip), and API, dashboard and MCP never show one. Existing people are removed with `node scripts/fe-persons-to-areas.mjs --db <db>` (dry-run) then `--apply --backup <path>` |
| `LLM_JSON_REPAIR_ENABLED` | UX-19, default off: an unusable model answer (panel review, Frontier Experts) gets ONE repair call to the same model with the required JSON shape; outcome recorded in `llm_model_calls` (`task_kind` json_repair, status `repaired` / `unparseable`). Off = no extra call, behaviour unchanged |
| `SELF_IMPROVEMENT_GOAL_ON_APPROVE` | create the goal right after panel approval instead of the hourly cycle |
| `TEST_GAP_SOURCE_ENABLED` | deterministic, fully grounded test-only proposals (max 2/day, 2 in flight) |
| `REFLECTION_PROPOSALS_MAX_PER_DAY` | cap on reflection proposals per 24 h (unset = no cap); they rarely ground, so a bounded inflow keeps `needs_grounding` drainable |
| `TEST_GAP_EXPORTS_ENABLED` | second test-gap lane: exported functions of tested services that no test names → a new `<service>.exports.test.ts` (same caps) |
| `MUTATION_GAP_ENABLED`, `MUTATION_GAP_MAX_PER_DAY` | M2 mutation-gap lane: tested services (30–400 lines, non-sensitive) get "strengthen the test" proposals; add `test:mutation:grounded` to `LOOP_DAEMON_CHECK_SCRIPTS` so the gain (Stryker, committed vs working-tree test, +10 points or ≥ 90) is a deterministic check (a no-op for other lanes) |
| `DEAD_CODE_LANE_ENABLED`, `DEAD_CODE_MAX_PER_DAY` | dead-code lane: proposals to remove a server file nothing imports or names by string, or a route group with 0 `usage_counts` hits over ≥ 14 days of telemetry and no dashboard/mcp-server/script caller (plus the services only it uses); add `test:dead-code:grounded` to `LOOP_DAEMON_CHECK_SCRIPTS` (scope = the named files, adds ≤ 10 % of removed lines, full test suite of each touched package; a no-op for other lanes, set `LOOP_DAEMON_CHECK_TIMEOUT_MS=600000`). Normal risk: keeps the panel even with `ORACLE_LANES_SKIP_PANEL`, never auto-approved, merge human |
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
| `TYPESAFE_PROPOSAL_PRESCREEN_MODE` | jev pre-screen before the specialist panel. `shadow`: recorded next to the panel outcome, changes nothing. `enforce` (D5, met 28-09: 52 labelled, 1.9 % wrong): a confident `no` skips the panel and parks the proposal as `needs_more_evidence` with a `prescreen_park` judgment (`prescreen: <reason>`), shown in `/decisions#prescreen` with a Requeue button (D2); `uncertain`, an error or no judgment fall through to the panel; oracle lanes (`ORACLE_LANES_SKIP_PANEL`) are never parked; parked proposals are not refined (no dissent) |
| `DREAM_STATE_ENABLED` + `TYPESAFE_FAILURE_CAUSE_MODE` | 6-hourly replay of failed runs, cause classification, recurring causes → memory candidates (ADR 0003) |
| `COMMONS_EVIDENCE_PACK_ENABLED`, `COMMONS_AGENDA_FROM_FAILURES` | Commons rounds carry platform facts; undiscussed dream-state failures come first |
| `COMMONS_AGENDA_GROUNDING` | after failures, the newest `needs_grounding` proposal becomes the topic, with candidate files from `git grep`; residents answer `TARGET:` / `TEST:`, checked in code and recorded as a `commons_grounding` judgment |
| `COMMONS_GROUNDING_APPLY` | **operator decision**: a valid Commons grounding becomes one grounded refinement that goes to the specialist panel |
| `SOCIAL_AUTOPILOT_FORECAST_ONLY` | operator scale-back 2026-10-07: residents keep heartbeating and answering committee forecast questions (`forecast:resident:<agent>`, ≤ 2 per tick) but post no chat replies, open no rounds and answer no threads |
| `SOCIAL_AUTOPILOT_RESIDENTS` | per-resident model, e.g. `commons-oracle=openai-compatible:kimi-k2.6,commons-engineer=openai-compatible:gpt-oss:120b` (only the first `:` separates runtime and model, so model tags with `:` work). Residents: scout, muse, archivist, oracle, engineer, skeptic, methodologist (F6) |
| `AUTONOMY_SHADOW_ENABLED` | record "would auto-approve" per loop approval; approves nothing |
| `LOOP_AUTO_APPROVE_MUTATION_GAP` | **operator decision**: same one-file scope for the mutation lane, only after that lane has ≥ 1 verified human-approved run |
| `LOOP_MAKER_TIMEOUT_MS` | maker timeout (default 300 000, max 600 000); mutation-gap makers always get 600 000 and 400 diff lines |
| `OPENCODE_MAX_RUN_TOKENS` | runaway brake: an opencode run stops once its summed step tokens pass the cap (prod 1 000 000) |
| `EVOLUTION_GYM_ENABLED`, `EVOLUTION_GYM_MAX_PER_DAY`, `EVOLUTION_GYM_FIRST_DELAY_MS` | C2 gym: sandbox replay of our own fix commits (parent source restored, commit tests = oracle), one species per attempt, outcomes in `skill_outcomes` domain `gym`; yields to production workers; nothing is pushed or merged |
| `SCHEDULED_PROPOSAL_GOALS_INTERVAL_MS` | how often panel-authorised (`scheduled`) proposals become goals (default hourly; before #428 only at boot) |
| `FRONTIER_EXPERTS_RETRY_DAYS` | unmatched DISCOVERED names are retried after this many days (default 30); every scheduler tick is logged |
| `FRONTIER_EXPERT_SOURCE_UNITS_ENABLED` | E2: stored papers and the repositories they link become expertise units (kind paper / repository), stopping at CAPABILITY_INFERRED |
| `FRONTIER_TECHNIQUE_CARDS_ENABLED` | E3: up to three claims per paper unit from its own abstract, CONTRADICTS across sources (council runtime) |
| `PANEL_WEIGHTED_SHADOW_ENABLED` | C3: `panel_weighted` (track-record-weighted vote) and `panel_unweighted` shadow judgments per panel; changes no decision |
| `LOOP_AUTO_APPROVE_TEST_GAP` | **operator decision** (J5): when the shadow rule says yes, a test-gap maker approval whose artifact is one new `__tests__/*.test.ts` is approved by `autonomy:test-gap-rule-v1`; the `auto_approved_scope` gate fails the run if the maker touched any other file. Checker and human merge stay |
| `SEGML_ENABLED`, `DREAM_CYCLE_LEGACY_ENABLED` | restore the gated-off legacy loops (off since 2026-09-24) |
| **Operator decisions** `NEEDS_GROUNDING_TRIAGE_ENABLED`, `DREAM_STATE_PROPOSALS_ENABLED`, any `…_MODE=enforce` | act on shadow judgments; switch on only after the funnel agreement numbers justify it |

## Evolution flags (Phase F, RX-2)

The running values come from `GET /api/health/evolution-evidence` (manage:config), not from this table; the table is the
code default and who may change it. A test fails when a flag in `EVOLUTION_FLAGS` (services/evolution-evidence.ts) is
missing here. **Acting** = changes what the loop does; acting flags are switched by the operator only.

| Flag | Code default | Acting | Stage | Decides |
|---|---|---|---|---|
| `LOOP_BANDIT_ENABLED` | off | yes | act | operator |
| `LOOP_BANDIT_SPECIES` | unset | yes | act | operator |
| `LOOP_BANDIT_MAX_SHARE` | 0.1 | yes | act | operator |
| `LOOP_EVOLVE_ENABLED` | off | yes | act | operator |
| `LOOP_EVOLVE_SPECIES` | unset | yes | act | operator |
| `FITNESS_SHADOW_ENABLED` | off | no | shadow | loop (shadow) |
| `MERGE_SURVIVAL_ENABLED` | off | no | measure | loop (read-only GitHub GETs) |
| `MERGE_SURVIVAL_V2` | off | no (paged files/commits, merged_at window, unknown > 1 MB files, not_scored for deletion/docs-only and stale_loop; rows tagged `msv:2`) | measure | loop |
| `LOOP_EVIDENCE_FRESHNESS_MODE` | off | enforce: yes (a loop draft PR whose read set — lockfile, configs, imports — changed on main is not opened and the run is marked for a re-check); shadow: records `evidence_stale_shadow` | shadow | operator |
| `DREAM_EVOLUTION_ENABLED` | off | yes | act | operator |
| `DREAM_TRIAL_MUTANTS` | off | yes | act | operator |
| `DREAM_TRIAL_MUTANT_TIERS` | `2,3` | yes | act (freezes a new holdout) | operator, after the RX-5 tier probe |
| `DREAM_PROMOTION_ALPHA` | 0.05 | yes | act | operator |
| `TRIAL_DIAGNOSTICS_ENABLED` | off | no (records per-trial blindness/power; never changes promotion) | measure | operator |
| `TRIAL_HEADROOM_PRECHECK` | off | yes (scores the parent first; settles a trial `inconclusive` / `no_headroom` before any mutant attempt when the parent fails fewer deciding tasks than the promotion rule needs) | act | operator |
| `DREAM_PROMOTION_RULE` | mcnemar | no (`both` records the anytime-valid e-process decision next to McNemar; never changes promotion) | shadow | operator |
| `DREAM_EVIDENCE_MUTATIONS` | off | yes (dream mutants must cite a failure cluster; one mutant per cluster; uncited mutants are rejected as no_evidence) | act | operator |
| `GYM_HOLDOUT_EPOCH` | 0 (the holdout frozen since 01-10) | yes (a new epoch freezes 20 fresh tasks next to the old; refused while a genome is in trial) | act | operator |
| `GENOME_APPLY_MODE` | unset (only `shadow` exists) | no | shadow | loop (shadow) |
| `ARENA_GATE_ENABLED` | off | yes | act | operator |
| `COMMITTEE_SWARM_ENABLED` | off | yes | act | operator |
| `COMMONS_GROUNDING_APPLY` | off | yes | act | operator |
| `SOCIAL_AUTOPILOT_FORECAST_ONLY` | off | yes (residents heartbeat and answer committee forecasts only: no chat replies, rounds or thread answers; the arena gate's "talks without calls" rule is skipped, the skill rule still retires) | act (budget) | operator (scale-back 2026-10-07) |
| `LOOP_AUTO_DRAFT_PR_ENABLED` | off | yes | act | operator |
| `LOOP_AUTO_MERGE_TEST_ONLY` | off (`shadow` records `would_merge` per loop PR; `act` marks ready, updates a behind branch, waits for green checks and squash-merges) | yes in act (only verified loop draft PRs whose every file is a test, none deleted, within the lane diff limit, no changes-requested review; never Dependabot or non-loop PRs; a deterministic 10 % audit sample stays for the human, shown in /decisions and the digest; a revert, merge-survival removal or red checks on the merge commit within 14 d revokes the class until `POST /api/loops/auto-merge/re-enable` (manage:config, audited)) | shadow → act | operator (approved 2026-10-07); state at `GET /api/loops/auto-merge` |
| `LOOP_AUTO_MERGE_MAX_PER_DAY` | 10 (rolling 24 h; counts `would_merge` in shadow) | yes | act (budget) | operator |
| `LOOP_AUTO_APPROVE_TEST_GAP` | off | yes | act | operator |
| `ORACLE_LANES_AUTO_APPROVE` | off | yes | act | operator |
| `LOOP_MEMORY_RULES_ENABLED` | off | yes | act | operator |
| `EVOLUTION_GYM_REMOTE_MAX_PER_DAY` | 24 | yes | act (budget) | operator |
| `DJIMITFLO_PUBLIC_URL` | unset (Host header) | no | config | operator |
| `GYM_TIER_PROBE_ENABLED` | off | no | measure | operator (workstation budget) |
| `GYM_TIER_PROBE_TIERS` | `4,5,6` | no | measure | operator |
| `GYM_TIER_PROBE_EVERY` | 4 (every 4th remote claim) | no | measure | operator |
| `GYM_IRT_SELECTION` | off | yes (which tasks a NEW holdout epoch freezes: the most informative at the parent's ability by a 2PL fit; off = the deterministic spread) | act | operator |
| `HACK_DETECTOR_MODE` | off (`shadow` records gym hack flags on each result; nothing acts) | no | measure | operator |
| `GYM_CANARY_RATE` | 0 (never; served only to a worker announcing `capabilities: ['canary']`) | no | measure | operator |
| `GYM_FAILURE_TASKS_ENABLED` | off (failure-derived `write_test` tasks from regressed oracle-lane proposals; served only to a worker announcing `capabilities: ['write_test']`; never in holdouts; success = test green on the target AND red on ≥1 of 3 seeded target mutants, a target without a mutant is not served) | no | measure | operator |
| `GYM_PROD_GATES` | off (on: each claim to a worker announcing `capabilities: ['prod_gates']` carries production's gate config — `LOOP_DAEMON_CHECK_SCRIPTS` (fallback `test:changed,lint,type-check`), `LOOP_DAEMON_CHECK_TIMEOUT_MS`, lane diff limit 200 / 400 test-only; the worker runs them in its runner on a gym-oracle success and scores a failing one as `prod_gate_failed:<check>`; per-check results in `gym_result.prod_gates`, proxy vs prod-gate success per task kind in evidence `gym_prod_gates`; adds ~3–8 min per proxy success) | no (changes gym scores only) | measure | operator (workstation budget) |
| `MODEL_SELECTOR_MODE` | off (`shadow` samples a cheaper candidate per panel review and discards it; `enforce` uses the cheapest qualified model) | yes in enforce | shadow → act | operator; candidates `MODEL_CANDIDATES_PANEL_REVIEW` and (MS-2, Frontier Experts reviews / technique cards / council) `MODEL_CANDIDATES_FRONTIER_EXPERTS`, weights `MODEL_COST_WEIGHTS`, sample `MODEL_SELECTOR_SHADOW_RATE` (0.1) |
| `EVOLUTION_ESTIMATORS_ENABLED` | off (on: once per UTC day writes delays, discriminability, trial blindness, gym pass rate per tier, model ok rates and Gates A–D to `evolution_estimates`; stall `estimates` after 36 h without a row) | no | measure | operator |
| `DEPENDENCY_LANE_MODE` | off (`shadow`: records the Dependabot queue and `would_merge`/`would_rebase`, no GitHub writes; `act`: one `@dependabot rebase` per PR per 24 h when behind, squash-merges ONE green, mergeable, up-to-date npm patch/minor PR per tick after the previous lane merge is green on main; main red after a lane merge revokes act (persisted) until `POST /api/loops/dependency-lane/re-enable` (manage:config, audited). Majors, grouped updates touching a major and red checks stay human; never update-branch) | yes in act | shadow → act | operator |
| `DEPENDENCY_LANE_MAX_PER_DAY` | 4 (lane merges per UTC day; tick every `DEPENDENCY_LANE_INTERVAL_MS`, default 3 h) | yes | act (budget) | operator |
| `DEAD_CODE_LANE_ENABLED` | off | yes (proposes deletions; each one needs the panel, a human maker approval and a human merge) | act | operator |
| `DEAD_CODE_MAX_PER_DAY` | 2 (also the in-flight cap) | yes | act (budget) | operator |
| `GENOME_FIRE_CHECK` | off | yes (a scored gym attempt of a non-baseline genome must carry the worker's `fire_check` — sha256 of the goal sent to the maker and the number of genome lines found in it; without it, or with fewer lines than the genome has, the attempt is VOID: `gym_result.void`, no outcome, served again, never paired in McNemar / the e-process, unscorable after 3; counted in `evolution-evidence` `trials.void` and the genome note). Needs a gym worker that reports `fire_check` — an older worker voids every trial attempt | act | operator |
| `MEMORY_HOLDOUT_RATE` | 0 (off; clamped to [0, 1]) | yes (with `LOOP_MEMORY_RULES_ENABLED`, that deterministic fraction of maker runs — sha256 of the goal id, else run id — gets no engineering rules and logs `memory_holdout: true` on its `assignment_context` event; `evolution-evidence` `memory_holdout` compares verified/regressed per arm with a two-sided Fisher exact p) | measure (withholds rules) | operator |

## Prod status (2026-09-25, E4) — STALE

> Stale since 2026-10-04: read the live flag values, outcomes, holdouts and Realm Gates from
> `GET /api/health/evolution-evidence?days=30` instead. Kept for history.

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

## Requeue a proposal safely

Set the proposal to `scheduled` **and** unlink its failed/cancelled goal (`improvement_id = NULL`, keep the link in
`metadata.requeued_improvement_id`). Since #429 the goal generator does the unlink itself; before that a requeue without it
crash-looped the server (UNIQUE `goals.improvement_id`, 2026-09-25). A container that restarts in a loop cannot be
reached with `docker exec`; fix data with a one-off `docker run --rm -v /srv/djimitflo/data:/data --entrypoint node <image>`.

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

## Operator push (Telegram) — UX-12 / UX-13

Both are off by default; enabling is the operator's decision. The canonical channel is the webhook bot
(`routes/telegram.ts` → `TelegramBotService`, env `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USERS` / `TELEGRAM_WEBHOOK_*`).
The polling gateway in `packages/telegram` (`TELEGRAM_BOTS_CONFIG`) is kept as is and does not push.

| Flag | Default | What it does |
|---|---|---|
| `TELEGRAM_PUSH_ENABLED` | off | one message per new approval with Approve / Deny / Open buttons (dedupe per approval id) |
| `TELEGRAM_PUSH_MAX_PER_HOUR` | 6 | hourly cap on approval messages |
| `TELEGRAM_QUIET_HOURS` | unset | UTC window `HH-HH` (e.g. `22-7`) without messages |
| `TELEGRAM_TRIAGE_ENABLED` | off | needs `TELEGRAM_PUSH_ENABLED`: one message per unlabelled D5 pre-screen rejection (Correct / Wrong rejection) and per memory candidate waiting for review (Promote / Reject); each item once; taps are refused while off |
| `TELEGRAM_TRIAGE_MAX_PER_PUSH` | 3 | triage messages per 15-minute tick; triage also stays under `TELEGRAM_PUSH_MAX_PER_HOUR`, counted apart from approvals |
| `OPERATOR_DIGEST_ENABLED` | off | daily digest via the bot: counts + `/decisions` links for approvals, D5 labels, memory review, requeue candidates and open loop PRs |
| `OPERATOR_DIGEST_HOUR` | 7 | UTC hour of the digest |

Buttons only work for an allowlisted Telegram id mapped in `telegram_identities` (D3) to an active user whose role holds
`approve:task`; the decision is made through the normal approval API as that user, so `SELF_APPROVAL_FORBIDDEN` applies.
Triage buttons use the same D3 rule with the permission of the web route: `write:governance` for D5 labels (written as the
same `operator_label` judgment as `/decisions`), `approve:task` for memory promote / reject (the promote records the mapped
user as the human approver). The button carries only a kind and an id (≤ 64 bytes); the id is looked up before acting, and
the action runs through the same API route as the dashboard, as that user. Unknown or unauthorised ids are refused and audited
(`telegram_access` judgments). Memory messages include up to 400 characters of the candidate's content (secret patterns redacted).
The webhook must receive `callback_query` updates (Telegram's default unless `allowed_updates` was restricted).
Privacy: message content leaves to Telegram — titles, ids, lanes, file paths in scope and aggregates; secret patterns are
redacted; no hosts or tokens. `GET /api/health/digest` (read:evidence) shows the digest as it would be sent.
