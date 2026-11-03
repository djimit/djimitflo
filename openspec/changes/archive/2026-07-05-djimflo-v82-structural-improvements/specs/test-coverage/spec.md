## ADDED Requirements

### Requirement: All services >500 LOC have test files
The system MUST have test files for all services exceeding 500 lines of code.

#### Scenario: Large services are tested
- **WHEN** a service file exceeds 500 LOC
- **THEN** a corresponding test file exists in __tests__/
- **AND** the test file covers the public API surface

#### Scenario: Test coverage is measurable
- **WHEN** the test suite runs
- **THEN** coverage metrics are generated per service
- **AND** services below 50% coverage are flagged

### Requirement: Generated tests follow a standard template
Generated test files MUST follow a consistent pattern:
- Database setup with required tables
- Service instantiation
- Happy path test for each public method
- Error path test for each error condition
- Cleanup in afterEach
