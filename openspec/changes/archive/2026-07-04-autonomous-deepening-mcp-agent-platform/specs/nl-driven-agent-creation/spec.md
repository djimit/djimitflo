## ADDED Requirements

### Requirement: Agents can be created from natural language
The system MUST accept NL descriptions and generate agent configurations.

#### Scenario: NL description generates agent config
- **WHEN** POST /api/agents/create-from-description receives a natural language description
- **THEN** a draft agent config is generated with appropriate system prompt, tools, and risk class

#### Scenario: Human approval required before activation
- **WHEN** a draft agent config is generated
- **THEN** it is created with status=pending_approval and not available for loop assignment
