# Design

## Phase A: Selective Commit Gate

Goal: freeze the validated control plane work without absorbing unrelated local drift.

Commit inclusion:

- `packages/server/src/services/loop-service.ts`
- `packages/server/src/routes/loops.ts`
- `packages/server/src/services/swarm-status-service.ts`
- `packages/server/src/database/migrate.ts`
- `packages/server/src/__tests__/loop-service.test.ts`
- `packages/server/src/__tests__/swarm-resource-plan.test.ts`
- `packages/dashboard/src/lib/api.ts`
- `packages/dashboard/src/pages/GoalsLoopsPage.tsx`
- `packages/dashboard/src/pages/SwarmResourcesPage.tsx`
- `openspec/changes/real-worker-fleet-functionality-scale/**`
- `openspec/changes/commit-workstation-smoke-and-policy-runner/**`

Commit exclusion unless explicitly approved:

- `packages/server/.env.example`
- `packages/dashboard/.env.example`
- unrelated `.gitignore` changes if they are not required by the real-worker evidence path
- generated build outputs
- local `.data/**`, temp smoke repositories, tokens or runtime logs containing secrets

Commit gate:

1. `git diff --stat`
2. `git diff --check`
3. targeted tests and builds
4. `git status --short`
5. selective `git add` by explicit path
6. `git diff --cached --stat`
7. commit with message `feat: add real worker fleet control plane`

## Phase B: Workstation Live Smoke

Goal: prove the committed code on the workstation execution node while the MacBook dashboard remains only the cockpit.

Checks:

- Server health.
- `/api/loops/runtime-contracts`.
- `/api/swarms/status`.
- Fleet Cockpit renders runtime pools.
- Goals/Loops page renders prepared maker/checker leases and action buttons.
- Scheduler tick can project backlog and, when explicitly requested, prepare leases without starting workers.

Evidence:

- Absolute date/time.
- Host identity.
- API base URL.
- run IDs, lease IDs and dashboard route checked.
- Runtime contract status for Codex/OpenCode.
- Fleet pool values for prepared/running/completed/tokens.

Stop condition:

- Workstation smoke is green, or the blocker is documented with exact endpoint, response code and next action.

## Phase C: Real Codex/OpenCode Smoke

Goal: prove actual runtime adapters, not mock orchestration.

Execution model:

- Use temp DB and temp git repo.
- Use one bounded doc-drift task per runtime.
- Use hard `timeout_ms`.
- Use explicit token budgets.
- Use no merge, push or deploy.
- Write stdout/stderr artifacts, trace spans and checkpoints.

Codex pass criteria:

- Runtime contract says `codex exec --json --cd` is available.
- Maker lease transitions `prepared -> running -> completed`.
- Checker lease transitions `prepared -> running -> completed` or blocks with contract evidence.
- Runtime token usage is parsed when provided by runtime output.
- Loop verifies to `ready_for_human_merge`.

OpenCode pass criteria:

- Runtime contract says `opencode run --format json --dir` is available.
- Same maker/checker/artifact/gate expectations as Codex.
- If OpenCode is not installed or contract drifted, smoke exits as `runtime_contract_blocked`, not as hidden failure.

## Phase D: Policy-Gated Worker Pool Runner

Goal: move from prepared leases to controlled multi-worker execution.

Runner responsibilities:

- Select next prepared lease by runtime, risk class, queue age and configured priority.
- Check runtime contract.
- Check workstation capacity.
- Check token and wall-clock budgets.
- Check policy: low-risk may auto-start only when explicitly enabled; medium/high/critical require operator or security gate.
- Start up to `recommended_concurrency` workers per runtime.
- Persist runner decisions as trace spans and loop events.
- Never merge, push, deploy, modify secrets or delete data.

API shape:

- `POST /api/swarms/worker-pool/plan`
- `POST /api/swarms/worker-pool/start-next`
- `POST /api/swarms/worker-pool/drain`
- `POST /api/swarms/worker-pool/stop/:leaseId`

Dashboard shape:

- Worker Pool Runner panel.
- Shows eligible leases, blocked leases, policy reasons, capacity reasons and next safe action.
- Offers `Plan`, `Start next`, `Drain allowed`, and `Stop running` actions.

Runner stop conditions:

- no eligible leases
- concurrency exhausted
- runtime unavailable
- token/wall-clock budget exhausted
- high-risk approval missing
- deterministic gate failure
- checker/security checker required
- repeated failure threshold exceeded
