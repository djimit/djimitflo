## ADDED Requirements

### Requirement: OKF Agent concept bij registratie of eerste heartbeat

Het systeem SHALL bij agent-registratie of de eerste `POST /api/agents/:id/heartbeat` een OKF conceptdocument aanmaken of bijwerken op `djimitflo-knowledge/okf/agents/<machine_id>.md` met:

```
---
type: Agent
title: <name>
description: <description>
resource: http://<machine_ip>:3001
tags: [<agent_type>, <machine_id>]
timestamp: <ISO8601>
capabilities: <JSON array>
metadata: <JSON object>
---
```

- `machine_id`, `agent_type`, `machine_ip` komen uit de agent registry.
- Bijwerken van `timestamp` en `metadata.last_seen` gebeurt bij elke heartbeat.

### Requirement: Agents index genereren

Het systeem SHALL `djimitflo-knowledge/okf/agents/index.md` genereren met een progressive disclosure lijst van alle agents met link, type, status en `last_seen`.

#### Scenario: Nieuwe agent toegevoegd
- **WHEN** een nieuwe agent wordt geregistreerd
- **THEN** verschijnt deze binnen 5s in `okf/agents/index.md` met status `offline|idle|active` en link naar het conceptdocument

### Requirement: Heartbeat endpoint en agents tabel uitbreiden

Het systeem SHALL een heartbeat endpoint bieden `POST /api/agents/:id/heartbeat` dat `status`, `active_tasks` en `metadata` accepteert en de SQLite agents tabel bijwerkt met:

- `last_heartbeat_at = now()`
- `status = payload.status`
- `metadata = JSON_MERGE_PATCH(metadata, payload.metadata)`

Daarnaast SHALL de database migratie de volgende kolommen toevoegen aan `agents` (nullable, non-breaking):

- `telegram_bot_id   TEXT`
- `telegram_bot_name TEXT`
- `machine_ip        TEXT`
- `agent_type        TEXT`  -- 'hermes' | 'openclaw' | 'deerflow'
- `host_machine_id   TEXT`
- `okf_concept_path  TEXT`
- `last_heartbeat_at TEXT`

#### Scenario: Heartbeat verwerkt
- **WHEN** een agent heartbeat post met `status: idle`
- **THEN** wordt `last_heartbeat_at` geüpdatet in SQLite en de OKF agent-frontmatter `timestamp` bijgewerkt; er wordt geen commit gedaan (commitbeleid checkpoint)
