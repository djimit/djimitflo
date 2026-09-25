# Proposal: agent-commons-federation

## Why

`agent-communication-service` koppelt Agent Commons nu alleen intern: `socialize()` (:156-241) gebruikt cooldown + heartbeat-recency + capability-distance, zonder PII-filtering of trust-checks; `listSocialCommons()` (:246) vertrouwt op redactie-bij-schrijven. Voor koppeling met externe agent-netwerken (RuvNet Federation Gateway, geverifieerd bereikbaar met geldige OAuth protected-resource metadata) ontbreekt zowel een transport-adapter als een content-hygiëne-laag.

## What Changes

- **PII/trust-patroon (server)**: content-pass in `agent-communication-service` die voor externe commons-payloads PII-detectie toepast met modes BLOCK / REDACT / HASH / PASS, los van — en aanvullend op — het bestaande `redactSecrets`-bij-schrijven. Fail-closed: bij twijfel REDACT.
- **Federation-adapter (server, nieuw bestand)**: dunne client die `https://x.ruv.io/mcp` benadert via streamable-http met OAuth2 (issuer `https://auth.cognitum.one`, scopes `swarm:read`/`swarm-publish` afgeleid van `swarm:read`/`swarm:publish`). Stap 0 is altijd de `.well-known/oauth-protected-resource/mcp` discovery; geen hardcoded endpoints daarna.
- Feature-flagged (`DJIMITFLO_FEDERATION_ENABLED`), default uit. Zonder flag verandert bestaand gedrag niet.
- Expliciet NIET: `npx ruflo init`, Nostr als primaire bus, RuVector-adoptie, OAuth-token-dance in deze change (discovery + adapter-skelet + PII-pass only).

## Impact

- Affected specs: `federation` (nieuwe delta)
- Affected code:
  - `packages/server/src/services/agent-communication-service.ts` (PII-pass in externe lees/schrijf-paden)
  - Nieuw: `packages/server/src/services/federation/` (adapter + discovery + PII-modes)
  - Tests: service-tests voor PII-modes en discovery-fail-closed
- Config: nieuwe env `DJIMITFLO_FEDERATION_ENABLED` (default afwezig = uit); documentatie in env-voorbeeld.

## Risks

- Externe afhankelijkheid (x.ruv.io) — gemitigeerd door feature-flag, fail-closed discovery, en geen hardcoded endpoints na discovery.
- PII-false-positives blokkeren legitieme content — REDACT boven BLOCK bij twijfel; PASS alleen voor bewezen interne payloads.

## Verificatie-evidence (traject C, reeds uitgevoerd 2026-09-15)

- `.well-known`-proef: `GET https://x.ruv.io/.well-known/oauth-protected-resource/mcp` → `{resource:"https://x.ruv.io/mcp", authorization_servers:["https://auth.cognitum.one"], scopes_supported:["swarm:read","swarm:publish"]}`. Bereikbaar en geldig.
- VPS `djimitflo-live` healthy op `fix-1f23a540`; `DJIMITFLO_META_*` afwezig (meta-orchestration bewust uit, profiel-gated) — geen impact op federatie.
- Bekende noise: `POST /github/webhook Invalid GitHub webhook signature` op de VPS is een geweigerde binnenkomende hook (secret-mismatch bij afzender of stale client). Geen actie in deze change.
