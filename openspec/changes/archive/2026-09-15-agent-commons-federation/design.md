# Design: agent-commons-federation

## Context

Agent Commons is intern van aard. Externe koppeling vereist (a) content-hygiëne en (b) een transport. De verkenning heeft twee patronen vastgesteld:

1. **PII/trust** — extern netwerk vereist striktere filtering dan huidige `redactSecrets` (secret-only bij schrijven). Patroon: PII-detectie met modes BLOCK/REDACT/HASH/PASS op uitgaande/inkomende externe payloads.
2. **Federation transport** — RuvNet Federation Gateway `https://x.ruv.io/mcp`, streamable-http MCP, OAuth2 via protected-resource discovery (`.well-known/oauth-protected-resource/mcp`). Bereikbaarheidsproef is uitgevoerd en retourneert geldige metadata.

## Decisions

- **Discovery-first, fail-closed.** De adapter leest endpoints uitsluitend uit `.well-known`; bij ontbrekende/ongeldige metadata of netwerkfout gaat de adapter niet aan en logt hij een expliciete reden. Geen hardcoded fallback-URLs — dit voorkomt stille drift naar een verkeerde issuer.
- **Feature-flag, default uit.** `DJIMITFLO_FEDERATION_ENABLED` absent ⇒ geen codepath actief, bestaand intern gedrag bit-identiek. Dit begrenst de blast radius van een externe dependencies.
- **OAuth-token-dance uitgesteld (ponytail).** De publish-kant vereist client-credentials/token-flow bij `auth.cognitum.one`. Zonder echte publish-behoefte is dat onnodig oppervlak. De adapter legt de discovery + lees-skelet neer; `publishExternal()` is een stub met `ponytail:`-comment die het plafond en trigger benoemt. Upgrade: eigen change zodra externe publish een eis wordt.
- **PII-pass als aparte, testbare module.** Niet verweven in `agent-communication-service`-logica maar een pure functie `applyPiiPass(payload, mode)` zodat modes geïsoleerd te testen zijn en de koppeling één aanroep is.

## Boundaries

- PII-pass aanvullend op `redactSecrets`: secrets-redactie blijft op schrijven; PII-pass geldt op externe in/uit-paden. Geen dubbele redactie-conflicten: PII-pass draait na `redactSecrets`.
- Scope is server-side. Het dashboard raakt federatie niet in deze change (geen UI-eis).
- Nostr is niet de primaire bus; interne WebSocket/event-bus blijft leidend.

## Test plan

- Vitest service-tests: PII-modes × detectors; discovery met fixture + negatieve paden; adapter no-op/fail-closed/pad-validatie.
- Geen echte netwerkcalls in tests (fixture voor x.ruv.io-metadata).
