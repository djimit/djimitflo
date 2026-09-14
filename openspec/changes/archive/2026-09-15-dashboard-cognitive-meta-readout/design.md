# Design: dashboard-cognitive-meta-readout

## Context

De cognitive/meta GET-endpoints bestaan al en zijn permissie-gated op `read:evidence`. Drie daarvan missen een UI-reader. Aanknopingspunten (geverifieerd door explorer-scan):

- `api.getCognitiveStrategy(goalType)` bestaat al op `packages/dashboard/src/lib/api.ts:1877` — geen caller.
- `api.getMetaStats` bestaat op `:1898` — `getMetaTuning`/`getMetaTuningHistory` ontbreken.
- Server `notEnabled`-guard (`routes/meta-orchestration.ts:38-45`) retourneert `{enabled:false}` als MetaOrchestrationService niet draait (profiel ≠ `autonomous`; op de VPS is `DJIMITFLO_META_*` afwezig → uit).

## Decisions

- **Geen server-wijzigingen.** Alles is read-only consumptie van bestaande contracten.
- **Hergebruik `enabled:false`-afhandeling** die `SelfDrivingDashboard` al heeft voor `/api/meta/stats`; dezelfde shape geldt voor tuning-endpoints.
- **Strategy-lege-staat is geen error.** Server stuurt een vriendelijke `{message}` bij <3 episodes; de UI toont die tekst direct, zonder error-toast. Hiermee blijft de kaart waardevol terwijl de data nog opbouwt.
- **Alleen history, geen per-goal-type tuningkaart in v1** (task 3.2 is optioneel gemarkeerd). De history-lijst dekt de informatiebehoefte; aparte tuningkaarten per goal-type zijn duplicaat-UI. Upgrade-pad: als operators per goal-type willen filteren, wordt 3.2 een eigen change.

## Risks / Mitigations

- Response-shapes van tuning-history niet volledig getypeerd in client → helpers typen op basis van server-route responses; vitest met gemockte shapes als contract-test.
- Geen echte meta-orchestrationdata op niet-autonomous profiel → disabled-staat is het normale pad; test beide.

## Test plan

- Vitest in `packages/dashboard`, bestaande component-testpatronen (`*.test.tsx` naast page).
- Mocks op `api`-module; geen echte fetch.
