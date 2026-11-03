## ADDED Requirements

### Requirement: Skill acquisition via DeerFlow → OKF Skill draft

Het systeem SHALL bij `POST /api/agents/:id/skills/acquire` met `{ topic }` een DeerFlow research pipeline starten en de output projecteren naar een OKF concept op `okf/skills/<slug>.md` met frontmatter:

```
---
type: Skill
title: <topic title>
description: <summary>
tags: [skill, <domain-tags>]
status: draft
trust_level: agent_generated
timestamp: <ISO8601>
---
```

### Requirement: Skill sandbox validation (hybride)

Het systeem SHALL een `SkillValidatorService` bieden die `draft` skills valideert:
- Default: isolated Node/Python process (timeout, cwd jail, env whitelist, dry-run, stdout/stderr capture)
- High-risk (agent-generated extern, shell, network, infra-mutation): Docker sandbox (no-new-privileges, cap-drop=ALL, network=none, non-root, resource limits)

Validatie gebruikt synthethische testcases uit OKF context (geen production labels). Bij pass: `trust_level → validated`, `status: validated`; bij fail: validatierapport naar `reports/validation/<skill>_<run>.md` en status blijft `draft`.

### Requirement: Skill push naar agents na validatie

Het systeem SHALL alleen `validated` skills distribueren naar agents via Telegram (Hermes: file message naar `~/.hermes/skills/`) of OpenClaw Admin RPC. Push events worden gelogd in `okf/skills/log.md`.

#### Scenario: Push geweigerd
- **WHEN** een skill `status != validated`
- **THEN** weigert het systeem de push met een duidelijke foutmelding en verwijzing naar het laatste validatierapport
