# Operator Cockpit 3.0: changelog (2026-10-10)

Prod deploy **da864adf** carried #738–#748. It ran 15:26–15:34Z and passed its verdict check at 15:56Z (`verdict_ok`). The previous prod build was 22f7fcf7.

| PR | Merge SHA | Merged (UTC) | Change | Files | Deployed |
|---|---|---|---|---|---|
| #739 | 9feb5c73 | 12:16 | Detector health (`detectStallsWithHealth`), scheduler execution status, deploy-readiness detector, discoveries no-telemetry stall | stall-watch.ts, scheduler-registry.ts, routes/health.ts, autonomous-services.ts, 6 schedulers, contracts | yes |
| #741 | aa4648c2 | 12:25 | per_kWh gated on ≥ 80 % coverage and metered hosts; exclusive Wh across overlapping jobs; coverage_pct | resource-ledger.ts, contracts, api.ts, OperatorCockpitPage.tsx | yes |
| #738 | 6e7302a2 | 12:35 | Command strip (health / improvement / blocked / needs you), partial-failure banner, stale indicator, progressive disclosure, stale-response guard | OperatorCockpitPage.tsx (+ test), UX3.test.tsx | yes |
| #740 | b26fedeb | 12:45 | Authz tests for 16 decision endpoints | cockpit-decisions-authz.test.ts | yes (tests only) |
| #742 | 96c8ffa9 | 12:55 | Guardrail `state`, snapshot `health` / `errors` / `snapshot_id`, `unknown` attribution, untruncated totals, requeue classes, dedupe, NOT_APPLICABLE reflection, spend vs direct tokens | operator-cockpit.ts, decisions-inbox.ts, operator-push.ts, contracts, api.ts, page, 5 tests | yes |
| #743 | 4d4f8b2a | 13:04 | Audit names the human actor (approve/deny/cancel/memory), `self_approved` flag on fleet shell, Telegram email masking for viewers | approval-service.ts, approvals.ts, self-improvement.ts, swarm-governance.ts, fleet-commands.ts, memory-candidate-service.ts, FleetHostsPage.tsx, api.ts, 2 tests | yes |
| #744 | 4fa23435 | 13:46 | `.trivyignore` CVE-2026-78669 (gh client) | .trivyignore | yes |
| #748 | da864adf | 14:57 | auto-deploy ignores the scheduled OpenWiki `update` check (`AUTO_DEPLOY_IGNORE_CHECKS`); host copy reinstalled from origin/main | scripts/auto-deploy.sh, auto-deploy.test.ts | yes (host script installed 10-10) |
| #749 | — | merged pending deploy | Detector and scheduler health in the cockpit; digest unknown-not-0; loop-PR helpers return null on error; intervals + `markRun` for 8 schedulers; dashboard status type includes `capped` | 20 files (see PR) | no |
| #750 | — | merged pending deploy | A gym at its daily cap is `capped`, not stalled (`remoteGymCap` shared by claim and stall watch) | stall-watch.ts, remote-gym-service.ts, stall-watch.test.ts | no |

#749 and #750 were in their merge train when this was written; "merged pending deploy" means the train was running, not that they had merged.

## Host / config changes
- `/srv/djimitflo/auto-deploy.sh` was replaced from origin/main. Backup: `auto-deploy.sh.bak-20261010`.
- No runtime.env change in this batch.

## Rollback
- **Code:** `git revert <merge sha>` per PR, then auto-deploy ships it. Alternatively, deploy an earlier SHA by hand with `bash scripts/deploy-vps.sh <sha> --apply`.
- **Contract additions are additive:** `state`, `health`, `errors`, `snapshot_id`, `totals`, `system_requeue`, `detectors`, `coverage`. The legacy `ok` and `tokens_per_verified_change_7d` fields are kept, so older dashboards keep working.
- **Auto-deploy:** `cp /srv/djimitflo/auto-deploy.sh.bak-20261010 /srv/djimitflo/auto-deploy.sh`, or set `AUTO_DEPLOY_IGNORE_CHECKS=` (empty) to gate on every check again.
- **Kill switch:** `/srv/djimitflo/AUTO_DEPLOY_DISABLED`.
