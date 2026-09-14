# Proposal: dashboard-cognitive-meta-readout

## Why

Server-endpoints `GET /api/cognitive/strategy/:goalType`, `GET /api/meta/tuning/:goalType` en `GET /api/meta/tuning-history` bestaan en zijn getest, maar hebben **geen dashboard-reader**. De operator kan daardoor geleerde strategieën en tuning-geschiedenis alleen via curl inspecteren. Geverifieerd: alle andere cognitive/meta GETs hebben al live readers (`SelfDrivingDashboard.tsx:21-66`, `CognitiveRuntimePage.tsx:44-45`) — dit is dus een dunne aansluiting, geen exposure-laag.

## What Changes

- **CognitiveRuntimePage**: strategy-kaart per goal-type die `/api/cognitive/strategy/:goalType` aanspreekt via de bestaande helper `api.getBestStrategy` (`api.ts:1867-1878`). Toont expliciet de "geen strategie; ≥3 episodes nodig"-staat die de server al retourneert.
- **SelfDrivingDashboard**: tuning-history-sectie via nieuwe helpers `api.getMetaTuning(goalType)` en `api.getMetaTuningHistory()`. Bestaande `{enabled:false}` (service uit op niet-autonomous profiel) blijft correct afgehandeld — UI toont dan "Meta-orchestration uitgeschakeld (runtime-profiel)".
- Geen nieuwe server-endpoints, geen auth-wijzigingen, geen write-acties vanuit de UI.

## Impact

- Affected specs: `dashboard-readout` (nieuwe delta)
- Affected code:
  - `packages/dashboard/src/pages/CognitiveRuntimePage.tsx` (+test)
  - `packages/dashboard/src/pages/SelfDrivingDashboard.tsx` (+test)
  - `packages/dashboard/src/lib/api.ts` (2 nieuwe GET-helpers)
- Server: geen wijzigingen.
- Risico: laag — read-only, bestaande permissies (`read:evidence`), bestaande `notEnabled`-guard blijft leidend.

## Non-goals

- Nieuwe server-endpoints of permissie-wijzigingen.
- Auto-promote / scheduler-UI (definitief NIET gebouwd — `scripts/review-experts.ts` dekt review-flow).
- Muteerbare tuning- of strategie-acties vanuit de UI.
