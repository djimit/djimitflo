# Tasks: agent-commons-federation

## 1. PII/trust-pass (server)
- [ ] 1.1 Nieuw module `packages/server/src/services/federation/pii-pass.ts`: `applyPiiPass(payload, mode)` met modes BLOCK | REDACT | HASH | PASS. Startset van testbare detectors: e-mail, telefoon (E.164/NL-varianten), IBAN, Nederlands BSN-achtig (9-cijfer + elfproef), IPv4/IPv6, naam-adres-patroon, geboortedatum-patroon. Fail-closed: onbekend ≥ REDACT. Defensief: regex-catastrofe voorkomen (korte patterns, geen nested quantifiers). Geen nieuwe dependency — pure functie met stdlib.
- [ ] 1.2 Unit-tests per mode en per detector; bewijs dat BLOCK geen payload doorlaat en REDACT geen raw PII bevat.
- [ ] 1.3 Koppel `applyPiiPass` in `agent-communication-service` op de externe commons-paden (`socialize()` uitgaand, externe lees-projecties), als aanvulling op `redactSecrets`. Bestaand intern gedrag zonder flag ongewijzigd.

## 2. Federation-discovery (stap 0)
- [ ] 2.1 Nieuw module `packages/server/src/services/federation/discovery.ts`: `discoverGateway(baseUrl)` doet GET `{base}/.well-known/oauth-protected-resource/mcp` met `AbortSignal.timeout(5000)` (expliciete timeout), GEEN redirect-follow (`redirect: 'manual'` — een omleiding is geen geldige metadata en betekent fail), accepteert alleen `application/json`-achtige content-type, en valideert shape: `resource` (string), `authorization_servers` (non-empty array van strings), `scopes_supported` (array). Fail-closed bij ontbrekende velden, redirect, of netwerkfout. Geen caching in v1.
- [ ] 2.2 Unit-tests: geldige metadata (fixture op basis van werkelijke x.ruv.io-response), ontbrekend veld → reject, 30x-redirect → reject, netwerkfout → reject, timeout → reject. Geen hardcoded fallbacks.

## 3. Federation-adapter (skelet)
- [ ] 3.1 Nieuw module `packages/server/src/services/federation/adapter.ts`: streamable-http client richting ontdekte `resource`-URL; gebruikt uitsluitend discovery-output. Achter `DJIMITFLO_FEDERATION_ENABLED`; disabled = no-op met expliciete log.
- [ ] 3.2 Definieer minimale surface: `listExternalCommons()` en optioneel `publishExternal()` als stub met `ponytail:`-comment — OAuth-token-ophalen is bewust uitgesteld (plafond benoemd: token-dance volgt in eigen change zodra er een echte publish-behoefte is).
- [ ] 3.3 Unit-tests: disabled → no-op; enabled zonder geldige discovery → fail-closed fout; adapter roept nooit een niet-ontdekte URL aan.

## 4. Config & docs
- [ ] 4.1 Documenteer `DJIMITFLO_FEDERATION_ENABLED` in het env-voorbeeldbestand (alleen key + comment, geen waarde).
- [ ] 4.2 `npm run test`, `npm run type-check`, `npm run lint` groen in `packages/server`.

## Out of scope (bewust)
- OAuth client-credentials/token-dance implementatie.
- Nostr-transport, `ruflo init`, RuVector-backend.
- Wijzigingen aan bestaande (interne) commons-gedrag zonder flag.
