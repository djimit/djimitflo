## ADDED Requirements

### Requirement: Loop skills orchestrate each control-loop layer

Het systeem SHALL project-local skills ondersteunen die discovery, planning, execution, verification, memory en governance loops orkestreren.

#### Scenario: Required loop skills exist

- **WHEN** de loop framework setup wordt gevalideerd
- **THEN** bestaan minimaal skills voor goal intake, discovery, planning, execution, verification, memory en governance
- **AND** vermeldt iedere skill allowed actions, forbidden actions, gates en escalation

#### Scenario: Draft skill cannot control live workers

- **WHEN** een loop skill `status: draft` of `trust_level: proposed` heeft
- **THEN** mag Djimitflo die skill alleen in dry-run of planning gebruiken
- **AND** mag de skill geen live worker leases starten

### Requirement: Skill autonomy expansion requires governance review

Het systeem SHALL skill-wijzigingen die toegestane acties uitbreiden als governance-affecting behandelen.

#### Scenario: Skill adds mutating action

- **WHEN** een skill wijziging `actions_allowed` uitbreidt met write, PR, deploy, infra of policy mutation
- **THEN** vereist Djimitflo human approval
- **AND** wordt de wijziging als audit event opgeslagen
