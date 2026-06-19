## ADDED Requirements

### Requirement: Deterministic gates decide completion

Het systeem SHALL completion van loop-runs baseren op deterministic gates zoals tests, lint, typecheck, secret scanning, security scanning, diff thresholds en policy-as-code. LLM-reviewers zijn aanvullend.

#### Scenario: Reviewer approves but tests fail

- **WHEN** een checker-agent akkoord geeft maar tests of typecheck falen
- **THEN** markeert Djimitflo de loop step als failed
- **AND** mag de output niet als completed worden geaccepteerd

#### Scenario: Gates pass and checker approves

- **WHEN** verplichte gates slagen en checker-agent akkoord geeft
- **THEN** mag Djimitflo de step als verified markeren
- **AND** schrijft Memory-loop state, decisions en evidence weg

### Requirement: Memory updates use trust levels

Het systeem SHALL loop memory opslaan met trust levels zodat self-learning niet ongemerkt policy of engineering rules verandert.

#### Scenario: Operational lesson is proposed

- **WHEN** een loop een herhaalbare failure of fix detecteert
- **THEN** mag de Memory-loop een `proposed` lesson opslaan
- **AND** mag die lesson toekomstige context informeren zonder policy te wijzigen

#### Scenario: Policy rule update requires approval

- **WHEN** een loop een policy, security rule of autonomy setting wil aanpassen
- **THEN** moet de Governance-loop human approval vragen
- **AND** blijft de bestaande policy actief tot approval is gegeven

### Requirement: Assurance evals produce deterministic scorecards

Het systeem SHALL assurance evals kunnen draaien op memory, skill, swarm, loop en capability targets met reproduceerbare scorecards en zonder automatische externe writes naar UAMS, Qdrant of andere durable sinks.

#### Scenario: Memory quality eval scores promoted memory

- **WHEN** een promoted memory candidate bestaat
- **THEN** kan Djimitflo een `memory-quality` eval draaien
- **AND** slaat Djimitflo promoted, review-required en rejected memory counts op in de scorecard
- **AND** markeert de scorecard `external_writes = 0`

#### Scenario: Eval status follows score threshold

- **WHEN** een assurance eval score boven de pass threshold ligt
- **THEN** markeert Djimitflo de eval als `passed`
- **AND** bewaart Djimitflo findings, scorecard en target reference voor audit

### Requirement: Reflections remain governed candidates

Het systeem SHALL lessons uit traces, evals, loops, memory, skills en panels als governed reflection candidates opslaan voordat ze memory, policy of skill gedrag mogen veranderen.

#### Scenario: Security-sensitive lesson requires review

- **WHEN** een reflection lesson policy, approval, auth, token, deploy, production, permission of capability raakt
- **THEN** markeert Djimitflo de reflection als `review_required`
- **AND** zet Djimitflo `human_required = true`

#### Scenario: Secret-like reflection is rejected

- **WHEN** een reflection lesson of evidence secret-like content bevat
- **THEN** weigert Djimitflo de reflection
- **AND** mag de lesson niet in durable memory worden opgeslagen
