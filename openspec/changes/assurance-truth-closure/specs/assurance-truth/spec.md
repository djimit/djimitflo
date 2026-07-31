## ADDED Requirements

### Requirement: Fail-Closed Assurance Result

Djimitflo SHALL certify only when every mandatory gate passes.

#### Scenario: Mandatory gate fails

- **WHEN** any mandatory gate has status `fail`
- **THEN** the assurance result is `fail`
- **AND** no aggregate score can override that result

#### Scenario: Required external evidence is unavailable

- **WHEN** a required external integration cannot be observed
- **THEN** the assurance result is `blocked`
- **AND** includes the exact blocked reason and next safe action

### Requirement: Executable Contract Inventory

Djimitflo SHALL classify every registered HTTP route and MCP tool from runtime registration surfaces.

#### Scenario: Contract is covered

- **WHEN** a registered contract is exercised by a test
- **THEN** its identity links to that test and observed result

#### Scenario: Contract is not covered

- **WHEN** no executable test or justified exemption exists
- **THEN** the contract is failing coverage
- **AND** critical contracts block certification

### Requirement: OpenMythos Evidence Admissibility

Djimitflo SHALL reject benchmark scores whose provenance or validity gates are incomplete.

#### Scenario: Judge fails or times out

- **WHEN** a judge is unavailable, unparsable or returns an invalid score
- **THEN** the case and run fail
- **AND** the result is excluded from scores, trends and certification

#### Scenario: Corpus evidence is mature

- **WHEN** corpus schema, maturity, hashes, oracle coverage, repeatability and discrimination gates pass
- **THEN** the benchmark result may be used as supporting assurance evidence
- **AND** it does not automatically approve legal, production or memory-promotion decisions

### Requirement: Live Identity Equivalence

Djimitflo SHALL distinguish endpoint health from deployment identity.

#### Scenario: Healthy endpoint has wrong identity

- **WHEN** health succeeds but commit, configuration or database identity differs from the intended release
- **THEN** live certification fails
- **AND** reports the observed and intended identities

#### Scenario: Live identity matches

- **WHEN** health, commit, instance, mode, database identity, integrity and required integration probes agree
- **THEN** the deployment identity gate passes

### Requirement: Governed Autonomous Execution

Djimitflo SHALL execute safe evidence gathering autonomously and stop at real mutation boundaries.

#### Scenario: Work is read-only or locally reversible

- **WHEN** a gate requires inspection, tests, builds, temporary repositories or read-only probes
- **THEN** the agent may execute it autonomously

#### Scenario: Work changes external state

- **WHEN** closure requires deploy, restart, push, merge, secrets, production data mutation, benchmark promotion or durable-memory promotion
- **THEN** the agent pauses for explicit approval
