## ADDED Requirements

### Requirement: Nested spawned agents have isolated context windows
Each nested spawned agent MUST have its own message history and context budget.

#### Scenario: Sub-agent has isolated message history
- **WHEN** a nested agent is spawned with context isolation enabled
- **THEN** its message history is independent from the parent agent

#### Scenario: Context budget is enforced
- **WHEN** a sub-agent's context exceeds its budget
- **THEN** the context is automatically summarized and offloaded to disk

### Requirement: Context isolation is backward-compatible
Existing nested spawns without context isolation MUST continue to work unchanged.

#### Scenario: Legacy nested spawn works
- **WHEN** a nested spawn is created without context budget
- **THEN** it behaves identically to pre-change behavior
