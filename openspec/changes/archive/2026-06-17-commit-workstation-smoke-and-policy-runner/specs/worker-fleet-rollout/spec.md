## ADDED Requirements

### Requirement: Scoped commit gate preserves operational truth

Djimitflo SHALL require a scoped commit gate before workstation smoke or worker-pool runner work proceeds.

#### Scenario: Scoped commit excludes unrelated local artifacts

- **WHEN** the operator prepares the real-worker/fleet commit
- **THEN** only explicitly scoped source, test, dashboard and OpenSpec files are staged
- **AND** unrelated env files, generated outputs and local data are not staged
- **AND** `git diff --cached --stat` is reviewed before commit

#### Scenario: Post-commit status remains explicit

- **WHEN** the scoped commit is created
- **THEN** the commit hash is recorded
- **AND** remaining dirty/untracked files are listed separately
- **AND** no claim is made that the whole worktree is clean unless `git status --short` is empty

### Requirement: Workstation live smoke proves deployed control-plane behavior

Djimitflo SHALL prove the committed control plane on the workstation execution node before real runtime smoke.

#### Scenario: Runtime and swarm endpoints are verified live

- **WHEN** the workstation server is restarted on the committed code
- **THEN** `/api/loops/runtime-contracts` returns runtime contract status
- **AND** `/api/swarms/status` returns `fleet_pools`
- **AND** prepared leases, running leases and active executions are counted separately

#### Scenario: MacBook dashboard is cockpit only

- **WHEN** the dashboard is opened from the MacBook
- **THEN** it displays workstation runtime pools and loop state from API data
- **AND** it does not imply workers execute on the MacBook
- **AND** dashboard actions call guarded API routes on the workstation

### Requirement: Real Codex and OpenCode smokes are bounded and auditable

Djimitflo SHALL prove real Codex/OpenCode execution with bounded temp smoke runs before scaling worker execution.

#### Scenario: Real runtime contract blocks drift before spawn

- **WHEN** Codex or OpenCode is unavailable or the required CLI flags are missing
- **THEN** the smoke records runtime contract failure
- **AND** the worker lease is not spawned
- **AND** the output includes an actionable reason

#### Scenario: Real runtime smoke completes to merge-ready only after gates

- **WHEN** a real Codex or OpenCode maker/checker smoke succeeds
- **THEN** stdout/stderr artifacts, trace spans and checkpoints are stored
- **AND** deterministic checks and checker verdict pass
- **AND** the loop status becomes `ready_for_human_merge`
- **AND** no merge, push or deploy occurs

### Requirement: Policy-gated worker pool runner controls scale execution

Djimitflo SHALL start prepared workers through a policy-gated runner rather than ad hoc parallel execution.

#### Scenario: Runner plans before starting

- **WHEN** the operator requests a worker-pool plan
- **THEN** Djimitflo lists eligible, blocked and running leases
- **AND** each blocked lease includes a policy, runtime, capacity, budget or gate reason
- **AND** no worker starts during planning

#### Scenario: Runner respects risk and capacity gates

- **WHEN** the runner starts allowed workers
- **THEN** it starts no more than recommended concurrency per runtime
- **AND** it starts no high-risk work without the required human/security gate
- **AND** it writes trace spans and loop events for every start, skip and failure

#### Scenario: Drain stops at explicit stop conditions

- **WHEN** the runner drains eligible low-risk work
- **THEN** it stops when no eligible leases remain, concurrency is exhausted, runtime is unavailable, budget is exhausted or a failure threshold is reached
- **AND** failed or rejected worker output remains auditable
