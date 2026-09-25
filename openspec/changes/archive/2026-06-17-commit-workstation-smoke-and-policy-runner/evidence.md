# Evidence

Date: 2026-06-17

## G13.1 Scoped Commit Gate

- Commit: `33c15b3 feat: add real worker fleet control plane`
- Secret scan initially blocked operator auth placeholder examples; docs were corrected before commit.
- Unrelated local env drift remained unstaged:
  - `packages/server/.env.example`
  - `packages/dashboard/.env.example`

## G13.2 Workstation/Live API Smoke

Current local API/dashboard ports were not already running:

- `http://127.0.0.1:3001/health`: connection refused
- `http://127.0.0.1:5174`: no response

Temporary live API smoke was run against built server with temp DB/temp repo:

- Worker pool plan found one eligible mock worker.
- Worker pool drain started maker and checker.
- Mock pool after drain:
  - `completed_24h: 2`
  - `tokens_used_24h: 6`
  - `prepared_leases: 0`
  - `running_leases: 0`

Fixed-port live smoke was run against built server/dashboard with temp DB:

- API: `http://127.0.0.1:3001`
- Dashboard: `http://127.0.0.1:5174`
- Version: `0.5.8`
- Codex contract: `ok`
- OpenCode contract: `ok`
- Fleet pools: `4`
- Worker-pool plan route: reachable

## G13.3 Real Codex/OpenCode Smoke

Runtime contract probes:

- Codex: `codex-cli 0.140.0`, contract ok, supports `exec --json --cd`.
- OpenCode: `1.17.7`, contract ok, supports `run --format json --dir`.

Codex real worker smoke:

- Runtime: `codex`
- Run id: `60790bdd-6453-4f4e-a5b9-bea100c6f555`
- Maker: `completed`
- Checker: `completed`
- Verify status: `ready_for_human_merge`
- Gates:
  - `maker_checker_separation:pass`
  - `worktree_isolation:pass`
  - `assignment_file_present:pass`
  - `diff_threshold_all_makers:pass`
  - `checker_verdict:pass`
  - `tests_lint_typecheck:pass`
  - `security_checker_verdict:skipped`
  - `no_automatic_merge:pass`
- Runtime usage:
  - `prompt_tokens: 145032`
  - `completion_tokens: 2604`
  - `total_tokens: 147636`
  - `usage_source: runtime_stdout`
- Runtime warnings captured:
  - `plugin_hook_config_parse`
  - `skill_context_budget`
  - `runtime_session_cleanup`
  - `runtime_contract_warning`

OpenCode real worker smoke:

- Runtime: `opencode`
- Run id: `37d102e5-b599-4f22-ba9e-4b64020e3464`
- Maker: `failed`
- Failure: `spawnSync opencode ETIMEDOUT`
- OpenCode emitted JSON events and tool steps before timeout.
- Runtime usage was not normalized from the timed-out run.

## G13.4 Policy-Gated Worker Pool Runner

Implemented API:

- `POST /api/swarms/worker-pool/plan`
- `POST /api/swarms/worker-pool/start-next`
- `POST /api/swarms/worker-pool/drain`
- `POST /api/swarms/worker-pool/stop/:leaseId`

Implemented dashboard:

- Worker Pool Runner panel in `SwarmResourcesPage`.
- Actions: `Plan`, `Start Next`, `Drain 2`.
- Shows eligible, blocked, running, max start, next action and blocked reasons.

Test evidence:

- Low-risk mock drain starts maker and checker.
- High-risk mock lease blocks without high-risk allowance.
- Prepared worker stop cancels lease and preserves metadata.
