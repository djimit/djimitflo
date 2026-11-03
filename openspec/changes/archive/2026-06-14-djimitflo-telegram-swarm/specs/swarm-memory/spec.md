## ADDED Requirements

### Requirement: MemorySyncService schrijft task output naar UAMS

Het systeem SHALL na elke `task:completed` event de task output, summary en metadata schrijven naar UAMS (`http://192.168.1.28:8000/memory`) met tags `machine_id`, `agent_type`, `task_id`.

#### Scenario: Succesvolle UAMS sync

- **WHEN** een task de status `completed` bereikt en output bevat
- **THEN** schrijft `MemorySyncService` een UAMS entry binnen 5 seconden en logt "Memory synced: task <id> → UAMS"

#### Scenario: UAMS tijdelijk onbereikbaar

- **WHEN** UAMS een 503 retourneert bij sync poging
- **THEN** herprobeert het systeem maximaal 3 keer met exponential backoff en logt een warning audit event bij definitief falen; de task lifecycle wordt niet geblokkeerd

### Requirement: MemorySyncService embedt en slaat op in Qdrant

Het systeem SHALL na task completion de output embedden (model: `all-MiniLM-L6-v2`) en opslaan in Qdrant collection `djimitflo_swarm` op `192.168.1.28:6333`.

#### Scenario: Succesvolle Qdrant opslag

- **WHEN** een task completed met non-lege output
- **THEN** embedt het systeem de output en slaat het vector op met payload `{ task_id, machine_id, agent_type, timestamp, content_excerpt }` in collection `djimitflo_swarm`

#### Scenario: Collection bestaat nog niet

- **WHEN** de `djimitflo_swarm` collection niet bestaat bij eerste sync
- **THEN** maakt het systeem de collection automatisch aan met dimensie 384 (MiniLM-L6-v2) voor het opslaan

### Requirement: MemorySyncService schrijft OKF concept na task completion

Het systeem SHALL na elke `task:completed` event een OKF conceptdocument wegschrijven naar `djimitflo-knowledge/okf/tasks/<task_id>.md` met frontmatter:

```
---
type: CompletedTask
title: <task title>
description: <output summary (<=200 chars)>
resource: http://192.168.1.28:3001/api/tasks/<id>
tags: [<machine_id>, <agent_type>, <status>]
timestamp: <ISO8601>
trust_level: agent_generated
---
```

- Het bestand wordt gestaged voor commit, maar niet automatisch gecommit (checkpoint-commit beleid).
- Bij fout wordt een audit event met level `warning` gelogd; de task lifecycle wordt niet geblokkeerd.

### Requirement: `/api/memory/search` endpoint voor semantic zoeken

Het systeem SHALL een `GET /api/memory/search?q=<query>&limit=<n>` endpoint bieden dat semantisch zoekt in de `djimitflo_swarm` Qdrant collection.

#### Scenario: Semantische zoekopdracht

- **WHEN** `GET /api/memory/search?q=typescript+ESM+configuratie&limit=3` wordt aangeroepen
- **THEN** retourneert het endpoint maximaal 3 resultaten gesorteerd op similarity score, elk met `task_id`, `machine_id`, `agent_type`, `timestamp`, `score` en `content_excerpt`

#### Scenario: Geen resultaten

- **WHEN** de query geen matches boven score 0.5 heeft
- **THEN** retourneert het endpoint `{ results: [], total: 0 }`
