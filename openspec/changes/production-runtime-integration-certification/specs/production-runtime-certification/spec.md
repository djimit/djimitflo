## ADDED Requirements

### Requirement: Real Runtime Readiness

Djimitflo SHALL report real runtime readiness before starting production runtime workers.

#### Scenario: Runtime is available

- **WHEN** an operator requests readiness for `codex` or `opencode`
- **AND** the runtime contract is available and ok
- **THEN** Djimitflo reports the runtime as ready
- **AND** includes command, status, evidence and empty blocked reasons
- **AND** starts no worker

#### Scenario: Runtime is unavailable

- **WHEN** the requested runtime binary or contract is unavailable
- **THEN** Djimitflo reports blocked readiness
- **AND** includes blocked reasons
- **AND** starts no worker

#### Scenario: Unsupported runtime is rejected

- **WHEN** a production certification request uses `mock` or an unknown runtime
- **THEN** Djimitflo rejects production certification
- **AND** reports that a non-mock supported runtime is required

### Requirement: Opt-In Real Runtime Smoke

Djimitflo SHALL keep real runtime smoke execution opt-in.

#### Scenario: Real smoke is skipped by default

- **WHEN** the real runtime smoke test runs without `RUN_REAL_RUNTIME_SMOKE=1`
- **THEN** it skips real runtime execution
- **AND** does not fail CI

#### Scenario: Real smoke executes when opted in

- **WHEN** `RUN_REAL_RUNTIME_SMOKE=1` and `REAL_RUNTIME=codex` or `opencode`
- **AND** readiness passes
- **THEN** Djimitflo imports a low-risk integration event
- **AND** plans and prepares maker/checker leases with the explicit runtime
- **AND** starts workers only through the existing scheduler

### Requirement: Production Runtime Worker Evidence

Djimitflo SHALL persist real maker and checker runtime evidence.

#### Scenario: Maker produces runtime evidence

- **WHEN** a real runtime maker completes
- **THEN** Djimitflo stores stdout/stderr refs, runtime usage when parseable, gates, checkpoint refs and runner manifests
- **AND** links evidence to loop run, worker lease and source work item

#### Scenario: Checker produces accepted verdict

- **WHEN** maker evidence exists and real runtime checker completes
- **THEN** Djimitflo stores checker verdict and evidence
- **AND** links the verdict to loop run and source work item

#### Scenario: Checker cannot run before maker evidence

- **WHEN** checker is requested before maker completion evidence
- **THEN** Djimitflo blocks checker execution
- **AND** reports missing maker evidence

### Requirement: Production Proof Certification

Djimitflo SHALL distinguish mock proof from production runtime proof.

#### Scenario: Mock proof remains demo

- **WHEN** a proof run uses `mock`
- **THEN** Djimitflo reports demo proof
- **AND** production certification remains incomplete

#### Scenario: Real runtime proof is certified

- **WHEN** a proof run uses `codex` or `opencode`
- **AND** maker/checker usage, deterministic checks and required sub-agent evidence exist
- **THEN** Djimitflo reports `production_passed`
- **AND** `production_missing` is empty

#### Scenario: Real runtime proof is incomplete

- **WHEN** required production evidence is missing
- **THEN** Djimitflo reports `production_passed` false
- **AND** lists exact `production_missing` reasons

### Requirement: Production Learning Closure

Djimitflo SHALL close real runtime integration loops into governed learning records.

#### Scenario: Real runtime loop closes

- **WHEN** real maker/checker evidence exists
- **AND** close-loop is called
- **THEN** Djimitflo creates eval and reflection records
- **AND** may create a memory candidate
- **AND** SHALL NOT automatically promote durable memory

#### Scenario: Real runtime regression creates repair work

- **WHEN** a real runtime loop regresses against comparable prior evidence
- **THEN** Djimitflo creates a repair work item linked to the eval and loop

### Requirement: Mission Control Production Truth

Djimitflo SHALL show production runtime certification in Mission Control.

#### Scenario: Operator sees production certification state

- **WHEN** a real runtime certification run exists
- **THEN** Mission Control shows runtime, proof class, production status and missing reasons
- **AND** distinguishes requested runtime from effective runtime

#### Scenario: Operator sees next safe action

- **WHEN** certification is missing, blocked, incomplete or passed
- **THEN** Mission Control shows the next safe action
- **AND** does not require reading raw stdout
