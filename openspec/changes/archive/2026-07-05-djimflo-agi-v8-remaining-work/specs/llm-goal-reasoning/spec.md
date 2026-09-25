## ADDED Requirements

### Requirement: AGI engine uses LLM for goal decomposition
The system MUST use LLM-powered reasoning for complex goal decomposition, with template fallback.

#### Scenario: Complex goal is decomposed by LLM
- **WHEN** a user submits a complex natural language goal
- **THEN** the LLM generates a custom strategy with specific sub-tasks, dependencies, and estimated effort

#### Scenario: LLM unavailable falls back to templates
- **WHEN** no LLM provider is available or all providers fail
- **THEN** the system falls back to template-based decomposition without user-visible errors

#### Scenario: LLM output is validated
- **WHEN** the LLM returns a decomposition
- **THEN** the system validates the structure (valid JSON, required fields, no circular dependencies) before accepting

#### Scenario: Reasoning is recorded for learning
- **WHEN** a reasoning cycle completes
- **THEN** the outcome is recorded in the cognitive loop closure system for future pattern extraction

### Requirement: Goal reasoning supports self-reflection
The AGI engine MUST evaluate its own reasoning quality and suggest improvements.

#### Scenario: Self-reflection after execution
- **WHEN** a planned strategy completes execution
- **THEN** the LLM evaluates whether the strategy was effective and suggests improvements

#### Scenario: Confidence scoring
- **WHEN** the LLM generates a strategy
- **THEN** it includes a confidence score (0-1) that is stored and tracked over time
