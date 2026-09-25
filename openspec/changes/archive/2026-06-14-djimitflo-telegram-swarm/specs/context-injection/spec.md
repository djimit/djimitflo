## ADDED Requirements

### Requirement: OKF-aware context injection bij task aanmaak

Het systeem SHALL bij `POST /api/tasks` met `use_swarm_context: true` context injecteren vanuit twee bronnen:

1. Qdrant `djimitflo_swarm`: top-3 semantisch gerelateerde completed tasks
2. OKF traversal: relevante skills en services door `okf_related(concept_id, depth=1)` en `okf_get(concept_id)` op de OKF MCP server

De samengevoegde context wordt als markdown blok toegevoegd aan `task.metadata.swarm_context`.

#### Scenario: Context gevonden
- **WHEN** een nieuwe task wordt aangemaakt met default `use_swarm_context: true`
- **THEN** bevat `metadata.swarm_context` maximaal ~1500 tokens aan beknopte, gerangschikte context uit Qdrant en OKF

### Requirement: Context trust filtering

Het systeem SHALL contextvoorstellen met `trust_level: approved` prioriteren boven `trust_level: agent_generated` bij gelijke relevantie. De trust-levels worden meegenomen in ranking en truncatie.

#### Scenario: Gelijke score
- **WHEN** twee contextkandidaten gelijke similariteitsscore hebben
- **THEN** wordt de variant met `trust_level: approved` gekozen voor injectie
