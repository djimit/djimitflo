## ADDED Requirements

### Requirement: Canonical OKF Runtime

Djimitflo SHALL resolve one canonical OKF base for runtime knowledge services.

#### Scenario: Repository symlink is canonical when OKF_BASE is absent

- **WHEN** `OKF_BASE` is not set
- **AND** the repository `knowledge/` path exists
- **THEN** Djimitflo resolves `knowledge/` as the canonical OKF base
- **AND** does not resolve `packages/knowledge` as production knowledge

#### Scenario: Legacy package knowledge fallback is blocked

- **WHEN** runtime resolution would use `packages/knowledge`
- **THEN** Djimitflo reports the knowledge runtime as blocked
- **AND** includes a blocked reason that production knowledge is misconfigured

### Requirement: Knowledge Health Is Evidence

Djimitflo SHALL report OKF validation, document counts and drift without writing OKF files.

#### Scenario: OKF validation passes

- **WHEN** `tools/validate_okf.py` passes for the canonical OKF repo
- **THEN** the knowledge runtime health reports validation `pass`
- **AND** reports counts for skills, agents, memory, services, repos and models

#### Scenario: Failed OKF validation blocks apply sync

- **WHEN** OKF validation fails
- **AND** an operator requests capability sync with `apply: true`
- **THEN** Djimitflo rejects the apply request
- **AND** leaves OKF files unchanged

### Requirement: OKF Capability Sync

Djimitflo SHALL sync OKF skills, agents and services into `swarm_capabilities`.

#### Scenario: Complete OKF contract becomes validated capability

- **WHEN** an OKF file has allowed actions, forbidden actions, required evidence, risk ceiling, eval threshold and removal strategy
- **THEN** sync creates or updates a capability with status `validated`
- **AND** stores OKF path and content hash in metadata

#### Scenario: Incomplete OKF contract remains candidate

- **WHEN** an OKF file lacks required contract fields
- **THEN** sync creates or updates a capability with status `candidate`
- **AND** records missing fields as blocked reasons
- **AND** the capability cannot route live workers

### Requirement: Learning Closure

Djimitflo SHALL close loop runs with eval, reflection and optional memory or work-item follow-up.

#### Scenario: Improved score creates reusable learning

- **WHEN** a completed loop has maker, checker, gates and runtime evidence
- **AND** the loop eval score improves over the previous score
- **THEN** Djimitflo creates an eval run, reflection candidate, memory candidate and skill improvement work item

#### Scenario: Regressed score creates repair work

- **WHEN** a completed loop has a lower eval score than the previous score
- **THEN** Djimitflo creates a repair work item linked to the eval and loop run

#### Scenario: Missing checker blocks closure

- **WHEN** a loop run lacks an accepted checker verdict
- **THEN** Djimitflo refuses learning closure
- **AND** creates no eval, reflection or memory candidate

### Requirement: Governed Memory Promotion

Djimitflo SHALL treat OKF as canonical memory and Qdrant or UAMS as projections.

#### Scenario: Operational memory promotion writes OKF only after approval

- **WHEN** an operational memory candidate is approved for OKF promotion
- **THEN** Djimitflo writes an OKF memory document
- **AND** does not write Qdrant or UAMS unless explicitly requested by the promotion path

#### Scenario: Policy memory requires human approval

- **WHEN** a memory candidate changes policy, security, auth, autonomy, production or deploy behavior
- **THEN** Djimitflo marks it review-required
- **AND** blocks automatic promotion

#### Scenario: Secret-like memory is rejected

- **WHEN** candidate content contains secret-like material
- **THEN** Djimitflo rejects persistence of that payload
- **AND** stores no secret-like value

### Requirement: OKF-Backed Special Agents And Skills

Djimitflo SHALL allow validated OKF-backed profiles and skills to influence panels and routing.

#### Scenario: Unknown specialist profile is rejected

- **WHEN** a panel request references an unknown specialist id
- **THEN** Djimitflo rejects the panel request

#### Scenario: High-risk panel requires security reviewer

- **WHEN** a high or critical risk panel is requested
- **THEN** Djimitflo requires `security_reviewer`

#### Scenario: Below-threshold skill cannot route live execution

- **WHEN** a skill capability is candidate, draft or below eval threshold
- **THEN** Djimitflo blocks live worker routing through that skill
