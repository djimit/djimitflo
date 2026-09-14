# Tasks: dashboard-cognitive-meta-readout

## 1. API-helpers
- [x] 1.1 Voeg `getMetaTuning(goalType: string)` en `getMetaTuningHistory(opts?: { limit?: number })` toe aan `packages/dashboard/src/lib/api.ts`, direct naast `getMetaStats` (:1894-1899). Volg dezelfde vorm: `{ enabled: false } |` enabled-variant. Enabled-shapes: `getMetaTuning` → `LoopTuning`-achige object-response van de server (verifieer velden in `meta-orchestration-service.ts:177`); `getMetaTuningHistory` → array van `{goalType, aanpassing, timestamp}`-velden (verifieer `:488`). Type de helpers exact op die werkelijke service-returns (single source of truth), geen eigen schatting.
- [x] 1.2 Unit-test helpers: correct pad, query-params (`limit`, optioneel `goalType`), en `enabled:false`-pass-through.

## 2. CognitiveRuntimePage: strategie-readout
- [x] 2.1 Strategy-card onder de Meta-Learning-tabel, per weergegeven goal-type `api.getBestStrategy(goalType)` ophalen (helper bestaat al, `api.ts:1867`). Let op: server-responses zijn óf het strategy-object óf `{message: 'No learned strategy yet for this goal type. Need ≥3 episodes.'}`; `null` is ook mogelijk. Message/null rendert als expliciete "Nog geen strategie (≥3 episodes nodig)"-staat — nooit een error-toast.
- [x] 2.2 Vitest: mock `api.getBestStrategy`; asserties op (a) strategy-rendering, (b) message-pad toont de vriendelijke tekst, (c) geen error-state. Bestaand patroon: `CognitiveRuntimePage.test.tsx`.

## 3. SelfDrivingDashboard: tuning-history
- [x] 3.1 Sectie "Tuning-geschiedenis" die `getMetaTuningHistory()` rendert (goal-type, aanpassing, timestamp). Bij `{enabled:false}` toon "Meta-orchestration uitgeschakeld (runtime-profiel)" — bestaand patroon uit `notEnabled`-afhandeling hergebruiken.
- [ ] 3.2 Optioneel: per goal-type huidige tuning tonen via `getMetaTuning(goalType)` naast de history (alleen als de history-sectie dat niet al dekt — YAGNI: eerst alleen history).
- [x] 3.3 Vitest: asserties op history-rendering, `enabled:false`-staat, en afwezigheid van errors bij lege history.

## 4. Verificatie
- [x] 4.1 `npm run test` in `packages/dashboard` groen.
- [x] 4.2 `npm run type-check` + `npm run lint` groen.
- [ ] 4.3 Handmatige smoke op dev-server: CognitiveRuntimePage toont strategy-kaart; SelfDrivingDashboard toont history of de disabled-staat.
