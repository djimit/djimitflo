# Spec delta: dashboard-readout

## ADDED Requirements

### Requirement: Cognitive strategy readout
The dashboard SHALL display the learned strategy per visible goal-type on the Cognitive Runtime page by consuming `GET /api/cognitive/strategy/:goalType`, using the existing client helper.

#### Scenario: Strategy available
- **GIVEN** the server has ≥3 episodes for a goal-type
- **WHEN** the operator opens the Cognitive Runtime page
- **THEN** a strategy card shows the learned strategy for that goal-type

#### Scenario: Insufficient episodes
- **GIVEN** the server returns the insufficient-data message for a goal-type
- **WHEN** the operator opens the Cognitive Runtime page
- **THEN** the card shows "Nog geen strategie (≥3 episodes nodig)" and no error state

### Requirement: Meta-orchestration tuning readout
The dashboard SHALL display tuning-history on the Self-Driving dashboard by consuming `GET /api/meta/tuning-history`. It SHALL handle the `{enabled:false}` response by showing an explicit disabled state.

#### Scenario: Tuning history available
- **GIVEN** meta-orchestration is active and tuning-history exists
- **WHEN** the operator opens the Self-Driving dashboard
- **THEN** the tuning-history section lists goal-type, adjustment, and timestamp

#### Scenario: Meta-orchestration disabled
- **GIVEN** the server responds `{enabled:false}` for meta endpoints
- **WHEN** the operator opens the Self-Driving dashboard
- **THEN** the section shows "Meta-orchestration uitgeschakeld (runtime-profiel)" without an error state
