## ADDED Requirements

### Requirement: Learning Flywheel Smoke Is Executable

Djimitflo SHALL provide a deterministic smoke path that proves knowledge validation, capability sync, worker execution and learning closure work together.

#### Scenario: Smoke proves canonical knowledge runtime

- **WHEN** the smoke starts with `OKF_BASE` absent
- **AND** repo `knowledge/` exists
- **THEN** the smoke verifies `knowledge/` is the canonical OKF root
- **AND** verifies `packages/knowledge` is not production canonical knowledge

#### Scenario: Smoke proves full learning closure

- **WHEN** a mock loop reaches `ready_for_human_merge`
- **AND** maker, checker, gates and runtime evidence exist
- **THEN** the smoke closes the learning loop
- **AND** verifies linked eval, reflection and memory candidate records
- **AND** verifies no automatic memory promotion, merge, push or deploy occurred

### Requirement: Operator Can Preview And Apply Knowledge Sync

Djimitflo SHALL let an operator preview and apply OKF capability sync without hidden side effects.

#### Scenario: Capability sync preview writes nothing

- **WHEN** an operator runs capability sync preview
- **THEN** Djimitflo reports create, update and blocked counts
- **AND** does not mutate OKF files or SQLite tables

#### Scenario: Capability sync apply is gated by OKF validation

- **WHEN** OKF validation fails
- **AND** an operator requests capability sync apply
- **THEN** Djimitflo rejects the apply request
- **AND** writes no capability rows

#### Scenario: Incomplete capability cannot route workers

- **WHEN** an OKF skill lacks required contract fields or eval threshold
- **THEN** Djimitflo records the capability as candidate or blocked
- **AND** the worker scheduler refuses to route live worker work through that capability

### Requirement: Goal Batch Import Is Previewable

Djimitflo SHALL preview OpenSpec goal batches before creating runtime planning records.

#### Scenario: Preview reports import shape without writes

- **WHEN** an operator previews a `goals.batch.json`
- **THEN** Djimitflo reports goal count, risk classes, target refs and blocked reasons
- **AND** creates no goals, work items, loop runs or worker leases

#### Scenario: Apply imports planning records only

- **WHEN** an operator applies selected previewed goals
- **THEN** Djimitflo creates planning records
- **AND** does not start workers
- **AND** leaves execution gated by the existing scheduler and resource gates

#### Scenario: Malformed batch is rejected without partial import

- **WHEN** a goal batch contains malformed or incomplete entries
- **THEN** Djimitflo reports item-level errors
- **AND** performs no partial import

### Requirement: Resource Gates Block Worker Starts

Djimitflo SHALL prove resource-aware scaling by blocking new running workers when workstation capacity is below threshold.

#### Scenario: Low capacity keeps leases prepared

- **WHEN** a low-capacity simulation reports memory or load below threshold
- **AND** eligible worker leases are prepared
- **THEN** Djimitflo blocks new running worker starts
- **AND** keeps prepared leases prepared
- **AND** reports the blocked capacity reason through API and dashboard

#### Scenario: Normal capacity allows eligible worker starts

- **WHEN** capacity is within configured thresholds
- **AND** runtime, policy, budget and evidence gates pass
- **THEN** Djimitflo allows the scheduler to start eligible workers

### Requirement: Mission Control Shows The Next Safe Action

Djimitflo SHALL expose the learning flywheel state and next safe action in Mission Control.

#### Scenario: Knowledge runtime action row is truthful

- **WHEN** Mission Control renders the Knowledge Runtime panel
- **THEN** it shows canonical OKF root, validation status, capability drift and blocked reasons from API state
- **AND** does not label `packages/knowledge` as production canonical knowledge

#### Scenario: Learning outcome is linked to evidence

- **WHEN** a loop is closed through learning closure
- **THEN** Mission Control shows latest score delta
- **AND** links eval, reflection, memory candidate and follow-up work item ids when present

#### Scenario: Next safe action does not bypass gates

- **WHEN** Mission Control suggests sync, import, worker start, closure, repair or promotion actions
- **THEN** each action calls a guarded API route
- **AND** no dashboard action bypasses scheduler, validation, approval or resource gates

### Requirement: Improvements Are Measured Across Runs

Djimitflo SHALL compare loop outcomes across runs so learning claims are measurable.

#### Scenario: Improved run records positive delta

- **WHEN** the current loop eval score is higher than the comparable previous score
- **THEN** Djimitflo records a positive score delta
- **AND** may create a skill improvement work item when the improved procedure is repeatable

#### Scenario: Regressed run creates repair work

- **WHEN** the current loop eval score is lower than the comparable previous score
- **THEN** Djimitflo records a negative score delta
- **AND** creates a repair work item linked to the loop and eval evidence

#### Scenario: Missing baseline is explicit

- **WHEN** no comparable previous score exists
- **THEN** Djimitflo records the run as baseline
- **AND** does not claim improvement over a previous run
