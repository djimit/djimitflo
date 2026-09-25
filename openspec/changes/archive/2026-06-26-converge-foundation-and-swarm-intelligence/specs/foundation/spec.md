## ADDED Requirements

### Requirement: Test Suite Stability

Djimitflo SHALL maintain a green test suite across all workspaces before
starting new feature phases.

#### Scenario: All tests pass

- **WHEN** `npm run test` is executed across all workspaces
- **THEN** the command exits 0
- **AND** no test file reports a failure

#### Scenario: Type check passes

- **WHEN** `npm run type-check` is executed
- **THEN** the command exits 0
- **AND** no TypeScript errors are reported

#### Scenario: Lint passes

- **WHEN** `npm run lint` is executed
- **THEN** the command exits 0
- **AND** no lint errors are reported

### Requirement: Learning Flywheel Closure Verification

Djimitflo SHALL verify that the learning flywheel end-to-end smoke covers all
Phase 7 tasks before marking the change complete.

#### Scenario: Phase 7 tasks verified

- **WHEN** the `learning-flywheel-smoke.test.ts` test is reviewed
- **THEN** each Phase 7 task maps to a specific test assertion
- **AND** the tasks are checked off in `knowledge-runtime-learning-flywheel/tasks.md`

#### Scenario: OpenSpec validation passes

- **WHEN** `openspec validate knowledge-runtime-learning-flywheel --strict` is run
- **THEN** the command exits 0

- **WHEN** `openspec validate prove-learning-flywheel-operator-loop --strict` is run
- **THEN** the command exits 0

### Requirement: Clean Git Tree Before New Phase

Djimitflo SHALL commit all uncommitted changes with OpenSpec references before
starting the Swarm Intelligence phase.

#### Scenario: No uncommitted changes

- **WHEN** `git status --short` is executed
- **THEN** the output is empty

#### Scenario: No whitespace errors

- **WHEN** `git diff --check` is executed
- **THEN** the output is clean

#### Scenario: Commits reference OpenSpec changes

- **WHEN** `git log --oneline -10` is reviewed
- **THEN** commit messages reference the OpenSpec change IDs they belong to

### Requirement: Swarm Intelligence Kernel

Djimitflo SHALL model missions, tasks and decisions linking goals, loop-runs,
panels, claims, capabilities and worker leases.

#### Scenario: State machine transitions

- **WHEN** a swarm task transitions through its lifecycle
- **THEN** it follows: observed → hypothesized → planned → queued → prepared → running → checking → ready_for_human_merge → completed|blocked|rejected|escalated
- **AND** each transition is persisted with runtime evidence

#### Scenario: Active execution requires evidence

- **WHEN** a dashboard or API reports active execution count
- **THEN** the count is derived from runtime evidence (running worker leases)
- **AND** registry agent count does not equal active execution

#### Scenario: Illegal transition rejected

- **WHEN** a state transition is attempted that violates the state machine
- **THEN** the transition is rejected with a mapped error code

### Requirement: Capability Registry Contracts

Djimitflo SHALL enforce typed capability contracts before any skill, specialist
or runtime can route live workers.

#### Scenario: Draft capability cannot route workers

- **WHEN** a capability with status `draft` is selected for worker routing
- **THEN** the routing is refused
- **AND** a blocked reason is returned

#### Scenario: Validated capability routes within risk ceiling

- **WHEN** a capability with status `validated` is selected
- **AND** the work risk class is within the capability risk ceiling
- **THEN** the routing proceeds

#### Scenario: Missing contract fields block validation

- **WHEN** a capability contract is missing required fields
- **THEN** validation fails
- **AND** the capability remains `candidate`

### Requirement: Specialist Council With Dissent

Djimitflo SHALL preserve specialist dissent in panel reviews and project
consensus to backlog without starting workers.

#### Scenario: High-risk panel requires security reviewer

- **WHEN** a panel is created for a high or critical risk question
- **THEN** a security reviewer specialist is required
- **AND** the panel cannot close without the security review

#### Scenario: Dissent is preserved

- **WHEN** a specialist records a dissenting opinion
- **THEN** the dissent is stored in the review record
- **AND** the consensus output includes the dissent

#### Scenario: Consensus projects to backlog not workers

- **WHEN** panel consensus is reached
- **THEN** backlog work items are created
- **AND** no worker leases are started

### Requirement: Evidence Graph And Claim Ledger

Djimitflo SHALL track claims with source refs, contradiction links and
promotion status in a typed evidence graph.

#### Scenario: Contradictory claims are linked

- **WHEN** two claims contradict each other
- **THEN** an explicit contradiction edge connects them
- **AND** neither is auto-promoted to durable truth

#### Scenario: Secret-like memory rejected

- **WHEN** a memory candidate contains secret-like content
- **THEN** the candidate is rejected
- **AND** a blocked reason is recorded

#### Scenario: Policy memory requires human review

- **WHEN** a memory candidate is classified as `policy_rule`
- **THEN** human review is required before promotion
- **AND** automatic promotion is blocked

### Requirement: Capacity Governor V2

Djimitflo SHALL enforce queue classes, fair-share scheduling, budget limits and
kill handling for the worker fleet.

#### Scenario: Fair-share ordering

- **WHEN** multiple queue classes have pending work
- **THEN** scheduling respects per-class weights
- **AND** no class starves indefinitely

#### Scenario: Exhausted budget blocks new workers

- **WHEN** a queue class has exhausted its token or wall-clock budget
- **THEN** new worker starts for that class are blocked
- **AND** a budget-exhausted reason is returned

#### Scenario: Kill evidence includes trace

- **WHEN** a worker is killed due to timeout or failure budget
- **THEN** a trace span and checkpoint record the kill
- **AND** the evidence is queryable

### Requirement: Evaluation Harness

Djimitflo SHALL evaluate skills, specialists, memory, routing and worker
outcomes with deterministic scorecards.

#### Scenario: Deterministic gate overrides advisory LLM

- **WHEN** an advisory LLM eval passes but a deterministic gate fails
- **THEN** the overall eval result is fail
- **AND** the deterministic gate evidence is recorded

#### Scenario: Regression fixture fails

- **WHEN** a known-bad skill is evaluated
- **THEN** the scorecard fails
- **AND** the regression is detected

### Requirement: Mission Control Dashboard Evidence

Djimitflo SHALL show active execution, registry, queue, capacity, specialists
and evidence from runtime evidence only.

#### Scenario: Active execution from evidence

- **WHEN** the dashboard shows active execution count
- **THEN** the count is derived from running worker leases
- **AND** registry count is not conflated with active execution

#### Scenario: Specialist council view

- **WHEN** an operator opens the specialist council view
- **THEN** panel state, consensus, dissent and evidence refs are visible

#### Scenario: Evidence graph view

- **WHEN** an operator opens the evidence graph view
- **THEN** contradicted, review-required and promoted claims are filterable

### Requirement: End-To-End Swarm Smoke

Djimitflo SHALL prove the full swarm scenario with mock runtime without
auto-merge, push, deploy or high-risk unattended execution.

#### Scenario: Full scenario completes

- **WHEN** the G14.9 smoke runs
- **THEN** the scenario goes from question to panel to backlog to goal to leases to checker to evidence graph
- **AND** the smoke passes as a test in the suite

#### Scenario: No unsafe actions

- **WHEN** the smoke completes
- **THEN** no auto-merge occurred
- **AND** no push occurred
- **AND** no deploy occurred
- **AND** no high-risk unattended execution occurred

#### Scenario: Quorum gate blocks

- **WHEN** a high-risk work item is submitted without evaluator quorum
- **THEN** the work is blocked
- **AND** a quorum-missing reason is returned
