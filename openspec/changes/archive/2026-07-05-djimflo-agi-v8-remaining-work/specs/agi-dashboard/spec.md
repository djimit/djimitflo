## ADDED Requirements

### Requirement: Dashboard shows AGI goal reasoning
The dashboard MUST provide a visual interface for monitoring and interacting with the AGI reasoning engine.

#### Scenario: Reasoning flow visualization
- **WHEN** a user opens the AGI page
- **THEN** they see the current reasoning state (Observe → Deduce → Plan → Execute → Monitor → Learn)

#### Scenario: Goal input and decomposition
- **WHEN** a user enters a natural language goal
- **THEN** the system shows the LLM-generated decomposition with confidence scores

### Requirement: Dashboard shows consensus debates
The dashboard MUST provide real-time visualization of consensus debates.

#### Scenario: Live debate view
- **WHEN** a user opens a debate
- **THEN** they see proposals, votes, and scores updating in real-time

#### Scenario: Debate creation
- **WHEN** a user creates a new debate via the dashboard
- **THEN** the debate appears in the list and agents can be invited

### Requirement: Dashboard shows predictive analytics
The dashboard MUST visualize predictions and historical patterns.

#### Scenario: Prediction display
- **WHEN** a user configures a hypothetical loop
- **THEN** the dashboard shows predicted success probability, duration, and cost

#### Scenario: Pattern explorer
- **WHEN** a user opens the analytics page
- **THEN** they see historical patterns grouped by goal type and runtime

### Requirement: Dashboard shows self-healing status
The dashboard MUST display system health and healing actions.

#### Scenario: Health overview
- **WHEN** a user opens the health page
- **THEN** they see all 5 health checks with status indicators (green/yellow/red)

#### Scenario: Incident history
- **WHEN** a user views the incidents tab
- **THEN** they see a chronological list of detected issues and auto-fix results
