## ADDED Requirements

### Requirement: Leakage-free training export

Het systeem SHALL `GET /api/exports/training` aanbieden dat JSONL records levert met:
- `task_id`, `machine_id`, `agent_type`
- `skill_used` (OKF concept ID indien beschikbaar)
- `output_excerpt` (<= 500 chars)
- `outcome`: `approved` | `denied` | `auto_completed`
- `denial_reason` (optioneel)

Skill content wordt niet meegeleverd in de training export om leakage te voorkomen.

### Requirement: ReasoningBankService

Het systeem SHALL een `ReasoningBankService` bijhouden die approved en denied tasks projecteert naar een reasoning-collectie (`djimitflo_reasoning`) waarbij elke entry de prompt, (ingespoten) context en uitkomst bevat. Deze collectie is gescheiden van `djimitflo_swarm` en dient uitsluitend voor offline evaluatie en training.
