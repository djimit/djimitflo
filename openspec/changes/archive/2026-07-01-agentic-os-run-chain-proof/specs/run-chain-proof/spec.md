## ADDED Requirements

### Requirement: Explicit Runtime Precedence

Djimitflo SHALL honor an explicit operator or smoke-test runtime unless an existing capability, risk or resource gate blocks it.

#### Scenario: Explicit mock runtime is honored

- **WHEN** an operator-safe smoke requests the `mock` runtime for a low-risk integration-origin work item
- **AND** capability and resource gates allow execution
- **THEN** Djimitflo prepares and starts eligible leases with `mock` as the effective runtime

#### Scenario: Adaptive runtime applies only when runtime is absent

- **WHEN** an integration-origin work item is planned without an explicit runtime
- **THEN** Djimitflo may select an eligible runtime through existing adaptive selection
- **AND** records the selected effective runtime in lease metadata

#### Scenario: Blocked runtime reports reasons

- **WHEN** an explicit runtime is requested but blocked by risk, capability or capacity gates
- **THEN** Djimitflo keeps leases prepared or blocked
- **AND** reports the blocked reasons without starting workers

### Requirement: Integration Run Chain Preparation

Djimitflo SHALL turn a selected integration-origin work item into a linked goal, loop and prepared maker/checker leases without starting workers.

#### Scenario: Work item prepares one execution chain

- **WHEN** an operator selects an integration-origin work item for planning
- **THEN** Djimitflo links or creates one goal and one loop run
- **AND** prepares maker and checker leases
- **AND** stores source work item and integration metadata on the chain

#### Scenario: Planning starts no workers

- **WHEN** the plan-and-prepare path completes
- **THEN** maker and checker leases remain prepared
- **AND** no worker process starts until the existing scheduler start path is called

### Requirement: Scheduler Worker Checker Proof

Djimitflo SHALL prove maker and checker execution for integration-origin work through the existing worker pool and checker bridge.

#### Scenario: Eligible maker starts through scheduler

- **WHEN** a low-risk integration-origin maker lease is prepared
- **AND** resource capacity is sufficient
- **THEN** the existing scheduler may start the maker
- **AND** records artifacts, gates and trace or checkpoint refs

#### Scenario: Checker waits for maker evidence

- **WHEN** a checker lease exists before maker completion evidence
- **THEN** Djimitflo does not run the checker
- **AND** reports the missing maker evidence reason

#### Scenario: Checker verdict links to source work

- **WHEN** maker evidence exists and the checker runs
- **THEN** Djimitflo stores checker verdict and evidence
- **AND** links them to the loop run and source work item

### Requirement: Integration Learning Closure

Djimitflo SHALL close a completed integration-origin loop into eval, reflection and optional memory or repair candidates.

#### Scenario: Completed run creates learning records

- **WHEN** maker, checker, gate and runtime evidence exists
- **AND** the close-loop endpoint is called
- **THEN** Djimitflo creates an eval run and reflection candidate
- **AND** links them to the loop and source work item

#### Scenario: Regression creates repair work item

- **WHEN** the integration-origin loop score regresses against comparable prior evidence
- **THEN** Djimitflo creates a repair work item
- **AND** links it to the eval and loop metadata

#### Scenario: Memory remains candidate

- **WHEN** the loop produces a reusable lesson
- **THEN** Djimitflo may create a memory candidate
- **AND** SHALL NOT automatically promote durable OKF memory

### Requirement: Mission Control Chain Truth

Djimitflo SHALL render the integration run chain in Mission Control from API state.

#### Scenario: Operator sees source to learning chain

- **WHEN** an integration-origin run exists
- **THEN** Mission Control shows source event, work item, goal, loop, leases, gates, eval and learning candidates
- **AND** shows requested runtime and effective runtime when available

#### Scenario: Operator sees next safe action

- **WHEN** the chain is blocked, prepared, running, checkable or closable
- **THEN** Mission Control shows the next safe action
- **AND** does not require reading raw stdout
