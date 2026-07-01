## ADDED Requirements

### Requirement: Operator Pilot Runbook

Djimitflo SHALL provide a repeatable production pilot runbook for bounded low-risk real-runtime work.

#### Scenario: Operator preflights runtime

- **WHEN** an operator starts a pilot
- **THEN** the runbook checks runtime readiness first
- **AND** starts no worker during readiness checks

#### Scenario: Operator reaches a stop condition

- **WHEN** readiness, capacity, checker or learning closure is blocked
- **THEN** the runbook tells the operator to stop
- **AND** records the blocked reason as evidence

### Requirement: Pilot Run Chain

Djimitflo SHALL link each pilot source event to work item, goal, loop, worker leases, checker verdict and learning closure.

#### Scenario: Pilot run completes

- **WHEN** a pilot work item runs through maker, checker and close-loop
- **THEN** Djimitflo exposes linked evidence ids for every stage
- **AND** reports the requested and effective runtime

#### Scenario: Pilot run fails before closure

- **WHEN** maker, checker or closure fails
- **THEN** Djimitflo preserves the partial chain
- **AND** reports the next safe action

### Requirement: Pilot Metrics

Djimitflo SHALL report pilot metrics from existing runtime evidence.

#### Scenario: Three pilot runs exist

- **WHEN** an operator reviews pilot results
- **THEN** Djimitflo reports success rate, time to closure, checker rejection rate, candidate counts and manual intervention count
- **AND** links each metric to source evidence

#### Scenario: Pilot metrics are empty

- **WHEN** no pilot runs exist
- **THEN** Djimitflo reports an empty metrics state
- **AND** shows the next safe action

### Requirement: Governed Learning

Djimitflo SHALL treat pilot learning as candidates until explicitly approved.

#### Scenario: Reusable lesson is found

- **WHEN** a pilot close-loop finds a reusable lesson
- **THEN** Djimitflo may create a memory candidate
- **AND** SHALL NOT automatically promote durable memory

#### Scenario: Run regresses

- **WHEN** a pilot run regresses against prior pilot evidence
- **THEN** Djimitflo creates or recommends repair work

### Requirement: Mission Control Pilot Truth

Djimitflo SHALL show pilot chain and metrics in Mission Control.

#### Scenario: Operator demos latest pilot

- **WHEN** a pilot run exists
- **THEN** Mission Control shows source event through learning closure
- **AND** shows production certification and next safe action without raw stdout

#### Scenario: Pilot state is partial

- **WHEN** a pilot has not completed
- **THEN** Mission Control shows the partial state without crashing
