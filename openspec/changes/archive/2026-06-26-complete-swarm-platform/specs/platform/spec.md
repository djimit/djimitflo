## ADDED Requirements

### Requirement: Complete Swarm Platform

Djimitflo SHALL consolidate all remaining OpenSpec work into one executable
program with ordered goals, clear dependencies, and a single validation gate.

#### Scenario: All changes validate

- **WHEN** `openspec validate <change> --strict` is run for each of the 14 changes
- **THEN** each exits 0

#### Scenario: All tests pass

- **WHEN** `npm run test` is executed
- **THEN** the command exits 0
- **AND** all test suites are green

#### Scenario: G14 tasks closed with evidence

- **WHEN** the 40 next-level-swarm-skills-specialists tasks are reviewed
- **THEN** each is checked off with a reference to the test that covers it

#### Scenario: Enforcement is binding

- **WHEN** a worker with a draft capability attempts to start
- **THEN** the start is blocked with CAPABILITY_NOT_ROUTABLE
- **AND** a runner manifest is auto-written with the blocked reason

#### Scenario: Governance blocks completion

- **WHEN** a loop run has unresolved claims (proposed, contradicted, review_required)
- **THEN** completeLoopRun throws GOVERNANCE_COMPLETION_BLOCKED
- **AND** the blocked claims are listed in the error

#### Scenario: Evidence graph auto-populated

- **WHEN** a loop run's gates pass verification
- **THEN** evidence edges are created linking loop→gate and loop→lease
- **AND** the edges are queryable via the lineage resolver

#### Scenario: Proof run demonstrates nonzero output

- **WHEN** a proof run is executed
- **THEN** capabilities, panels, claims, backlog, goals, loops, leases, traces, checkpoints, manifests, and memory candidates are created
- **AND** all records carry proof-run metadata
- **AND** rollback deletes only proof-scoped records

#### Scenario: No theater in proof

- **WHEN** the proof run completes
- **THEN** no auto-merge, push, deploy, or high-risk unattended execution occurred
- **AND** missing evidence is shown as blocking facts

#### Scenario: Pi executor sovereign run

- **WHEN** a task runs through djimitflo → PiExecutor → Ollama
- **THEN** zero external API egress is observed
- **AND** diff snapshot, risk classification, and audit trail are populated

#### Scenario: Loop resume after restart

- **WHEN** the server restarts with persisted loop state
- **THEN** the loop can resume from its last checkpoint
- **AND** no worker leases are lost or duplicated

#### Scenario: Workstation deployment verified

- **WHEN** the committed server is deployed on the workstation
- **THEN** health, runtime contracts, swarm status, and dashboard are verified
- **AND** scheduler tick runs in safe mode without starting workers
