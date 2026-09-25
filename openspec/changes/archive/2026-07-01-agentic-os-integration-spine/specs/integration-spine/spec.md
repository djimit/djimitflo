## ADDED Requirements

### Requirement: Canonical Integration Inbox

Djimitflo SHALL normalize external events into existing `work_items`.

#### Scenario: GitHub issue import is idempotent

- **WHEN** a GitHub issue event is imported twice with the same source ref
- **THEN** Djimitflo creates or updates one `work_items` row
- **AND** stores integration details under `metadata.integration`

#### Scenario: Telegram command preview starts no workers

- **WHEN** a Telegram command is previewed
- **THEN** Djimitflo returns the normalized work item shape and recommended loop
- **AND** creates no goal, loop run or worker lease
- **AND** starts no worker

#### Scenario: Dashboard action uses the same inbox

- **WHEN** an operator action creates integration-origin work
- **THEN** Djimitflo records it as a `work_items` row
- **AND** preserves source and source ref for traceability

### Requirement: Capability-Gated Integrations

Djimitflo SHALL gate connector influence through existing capabilities and MCP permissions.

#### Scenario: Unvalidated connector cannot route live execution

- **WHEN** a connector capability is missing, candidate, draft or not live-route-allowed
- **THEN** Djimitflo may record blocked reasons
- **AND** SHALL NOT route live worker execution through that connector

#### Scenario: Validated low-risk connector can propose work

- **WHEN** a connector capability is validated and live-route-allowed
- **AND** MCP permission metadata allows the requested action
- **AND** the risk ceiling covers the event
- **THEN** Djimitflo may create or update an integration-origin work item

### Requirement: Agentic OS Run Chain

Djimitflo SHALL link source event, work item, goal, loop, worker leases, gates and evidence.

#### Scenario: Selected work item prepares maker and checker leases

- **WHEN** an operator selects an integration-origin work item for execution planning
- **THEN** Djimitflo creates or links a goal and loop run
- **AND** prepares maker and checker leases
- **AND** stores source event and work item ids in runtime metadata

#### Scenario: Planning does not start workers

- **WHEN** a work item is planned and leases are prepared
- **THEN** worker leases remain prepared
- **AND** no worker starts until the existing scheduler start path is called

#### Scenario: Scheduler blocks execution under low capacity

- **WHEN** workstation capacity is below configured thresholds
- **AND** an eligible integration-origin lease exists
- **THEN** Djimitflo keeps the lease prepared
- **AND** reports the blocked capacity reason

### Requirement: Learning Closure

Djimitflo SHALL close integration-origin loops with eval, reflection and optional memory candidate.

#### Scenario: Regressed integration run creates repair work

- **WHEN** an integration-origin loop closes with a lower score than the comparable previous score
- **THEN** Djimitflo creates a repair work item linked to the loop and eval evidence

#### Scenario: Reusable lesson creates candidate memory only

- **WHEN** an integration-origin loop produces a reusable lesson
- **THEN** Djimitflo creates a memory candidate
- **AND** does not automatically promote durable OKF memory

#### Scenario: Missing evidence blocks closure

- **WHEN** maker, checker, gate or runtime evidence is missing
- **THEN** Djimitflo refuses learning closure
- **AND** creates no eval, reflection or memory candidate

### Requirement: Dashboard Truth

Djimitflo SHALL show the full integration-to-learning chain in Mission Control.

#### Scenario: Mission Control renders chain truth

- **WHEN** an integration-origin run exists
- **THEN** Mission Control shows the source event, work item, goal, loop, leases, gates, eval and learning candidates
- **AND** distinguishes prepared leases from running workers

#### Scenario: Operator can identify next safe action

- **WHEN** an integration-origin chain is blocked or ready for the next step
- **THEN** Mission Control shows the next safe action from API state
- **AND** does not require reading raw stdout
