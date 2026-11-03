## ADDED Requirements

### Requirement: Runtime contracts are repaired and shared

Djimitflo SHALL use one runtime contract source for Codex, OpenCode and mock worker execution.

#### Scenario: Codex executor uses current CLI flags

- **WHEN** Djimitflo builds a Codex runtime command
- **THEN** it uses `codex exec --json --cd <worktree>`
- **AND** does not use obsolete `--format json` or `--dir` flags for Codex

#### Scenario: OpenCode executor uses current CLI flags

- **WHEN** Djimitflo builds an OpenCode runtime command
- **THEN** it uses `opencode run --format json --dir <worktree>`
- **AND** records whether JSON event parsing is available

#### Scenario: Runtime drift blocks execution

- **WHEN** a runtime binary is missing or required flags are absent
- **THEN** Djimitflo marks the runtime contract `unavailable` or `drifted`
- **AND** blocks worker start with an actionable reason

### Requirement: Enforcement repairs block spoofed or unsafe swarm state

Djimitflo SHALL repair known G15 enforcement gaps before a proof run can create live records.

#### Scenario: OKF paths are allowlisted

- **WHEN** an OKF drift or sync request is made
- **THEN** Djimitflo accepts only configured root ids or canonical paths inside configured OKF/workspace roots
- **AND** rejects arbitrary filesystem paths

#### Scenario: Scoped permissions protect intelligence writes

- **WHEN** a caller writes capabilities, claims, governance decisions, runner manifests or swarm proof actions
- **THEN** Djimitflo requires the corresponding scoped permission
- **AND** generic task creation permission is insufficient

#### Scenario: Governance enforcement resolves refs

- **WHEN** a mutating worker, loop or memory action asks for approval
- **THEN** Djimitflo resolves persisted maker, checker, security, quorum and human approval refs
- **AND** request-supplied booleans cannot by themselves satisfy enforcement

#### Scenario: Runner manifests are runner-owned

- **WHEN** a public caller attempts to assert a completed start, stop, kill, fail or complete manifest
- **THEN** Djimitflo refuses the assertion
- **AND** requires the runner action path to create the manifest

### Requirement: OpenCode MCP and skill health is visible without credential leakage

Djimitflo SHALL report OpenCode MCP and skill configuration health without persisting credential values.

#### Scenario: OpenCode MCP database lock is classified

- **WHEN** `opencode mcp list` fails because the OpenCode database is locked
- **THEN** Djimitflo reports status `locked`
- **AND** provides remediation text without deleting or modifying OpenCode state

#### Scenario: Missing OpenCode MCP config is visible

- **WHEN** project OpenCode config lacks MCP or per-agent tool settings
- **THEN** Djimitflo reports `unconfigured`
- **AND** recommends per-agent enablement for heavy or sensitive MCP servers

#### Scenario: Skill permissions become capability candidates

- **WHEN** OpenCode skill permissions are discovered
- **THEN** Djimitflo creates or previews capability candidates
- **AND** does not activate hidden or ask-gated skills automatically

### Requirement: OpenAI Agents, Skills and MCP are modeled as governed capabilities

Djimitflo SHALL model OpenAI-hosted agents, skills and MCP/connectors as governed capabilities before any runtime integration.

#### Scenario: OpenAI Agents SDK is not assumed to be a local worker

- **WHEN** an OpenAI Agents SDK capability is registered
- **THEN** Djimitflo marks it as an orchestration candidate
- **AND** does not route local Codex/OpenCode worker leases through it without a validated adapter proof

#### Scenario: OpenAI Skills are privileged

- **WHEN** an OpenAI Skill capability is registered
- **THEN** Djimitflo requires developer review, workflow mapping and approval gates before use

#### Scenario: OpenAI MCP connectors require authorization refs

- **WHEN** an OpenAI MCP or connector capability is registered
- **THEN** Djimitflo requires approval and authorization refs
- **AND** stores no raw OAuth token or authorization header value

### Requirement: Proof run creates real live output

Djimitflo SHALL provide a governed proof run that creates visible live records across the swarm intelligence chain.

#### Scenario: Proof run starts from visible zero state

- **WHEN** the workstation DB has zero goals, loop runs, leases, capabilities, claims, runner manifests and panels
- **THEN** Djimitflo reports those pre-run counts before proof execution

#### Scenario: Mock proof run creates required records

- **WHEN** a mock proof run completes
- **THEN** Djimitflo records at least one goal
- **AND** at least one loop run
- **AND** at least two worker leases
- **AND** at least six capabilities
- **AND** at least three claims
- **AND** at least four runner manifests
- **AND** at least one specialist panel
- **AND** at least three specialist reviews
- **AND** at least one backlog work item
- **AND** at least one memory candidate
- **AND** at least four trace spans
- **AND** at least two checkpoints

#### Scenario: Every proof record is rollback scoped

- **WHEN** a proof run creates a record
- **THEN** the record metadata includes proof run id, rollback group and demo-record marker
- **AND** rollback deletes only records with that marker and rollback group

#### Scenario: Proof run separates demo automation from release actions

- **WHEN** a proof run executes
- **THEN** it may auto-start mock proof workers and create rollback-scoped operational demo memory evidence
- **AND** release actions such as merge, push and deploy require an explicit operator command outside the proof runner
- **AND** policy memory is not promoted through the operational demo-memory path

### Requirement: Mission Control shows proof instead of promises

Djimitflo SHALL expose proof-run output in Mission Control and authenticated API responses.

#### Scenario: Proof output is visible through API

- **WHEN** a proof run completes
- **THEN** authenticated Mission Control API includes proof run id, status, live counts, required minimum counts and missing evidence

#### Scenario: Dashboard shows missing evidence as blocking

- **WHEN** a required proof count or evidence ref is missing
- **THEN** the dashboard displays the missing item as blocked
- **AND** does not show the proof run as passed

#### Scenario: Registry is not execution

- **WHEN** Mission Control displays proof output
- **THEN** it separates registry agents, prepared leases, running leases, completed proof records and active runtime execution

### Requirement: Real runtime smokes follow mock proof

Djimitflo SHALL run bounded real Codex and OpenCode smokes only after the mock proof passes.

#### Scenario: Codex smoke captures runtime evidence

- **WHEN** the Codex smoke runs
- **THEN** Djimitflo records stdout, stderr, parsed usage or unknown usage, trace spans, checkpoints, runtime contract and wall-clock duration

#### Scenario: OpenCode smoke captures runtime evidence

- **WHEN** the OpenCode smoke runs
- **THEN** Djimitflo records stdout, stderr, parsed usage or unknown usage, trace spans, checkpoints, runtime contract and wall-clock duration

#### Scenario: Runtime unavailable is a valid blocked result

- **WHEN** Codex or OpenCode is unavailable, locked or drifted
- **THEN** Djimitflo records a blocked proof result with exact reason
- **AND** does not pretend the runtime smoke passed
