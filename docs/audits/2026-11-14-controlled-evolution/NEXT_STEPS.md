# Vervolg: kleinste bewijsbare volgorde

Deze stappen volgen uit FINDINGS.json; het zijn aanbevelingen, geen uitgevoerde werkzaamheden.

## Voorkeursvolgorde

1. **Sluit nested settlement en accounting.** Behoud de #1272-fix; voeg concurrency- en recoverytests toe voor dubbele settlement, grant-reservering en gemeten usage. Acceptatie: eenmaal reserveren, usage eenmaal boeken, terminale lease en spawnprojectie overeenstemmen; ontbrekende usage blijft onbekend.
2. **Maak normale runtime-uitvoering toetsbaar vóór swarmuitbreiding.** Gebruik een geïsoleerde repository, huidige admission, bestaande maker en onafhankelijke checker. Bewaar run/lease/attempt/artifact/evaluator-identiteiten. Start geen live modelrun zonder aantoonbare admission, begrensd budget en geïsoleerde werkruimte.
3. **Herstel graph-evidence-provenance.** Geef per feit scan/commit, bron, freshness, analysemethode en synthetic-status door. Accepteer geen oud of synthetisch bewijs als actuele runtime- of promotieclaim.
4. **Maak pollerfouten zichtbaar via readiness.** PR #1231 staat open tegen een oudere base. Herbeoordeel de exacte head tegen huidige main; toets leasevalidatie, foutprovenance en timeoutbudget. Een shadow-proef vereist een afzonderlijk toegelaten poller; productieflags bleven hier ongemoeid.
5. **Voer daarna één begrensde transferproef uit.** Leg taakfamilie, baseline, één kandidaat, holdout, onafhankelijke checks, budget en stopregel vooraf vast. Geen kandidaat die kwalificeert betekent baseline behouden.

## Eerste iteratie (2 weken; één engineer, geen betaalde schaal)

| Volgorde | Component | Definition of done | Verificatie |
|---|---|---|---|
| Dagen 1–3 | NestedSpawnService, LoopService, worker settlement | Dubbele events zijn idempotent; grants zijn geen usage; normale terminale projectie is correct | Gerichte tests, typecheck, lint, alleen test-DB |
| Dagen 3–5 | Bestaande task intake, admission, maker/checker, Mission Detail | Eén geïsoleerde normale taak heeft artefact, onafhankelijk verdict en juiste projectie | Alleen met actuele runtime-identiteit en bestaand budget; anders exacte blocker |
| Dagen 6–8 | repo-evidence-packet, explainer provenance | Provenance per graph-feit blijft behouden; verouderd/synthetisch bewijs kan geen actuele claim dragen | Fixtures plus vaste snapshot |
| Dagen 9–10 | PR #1231 | Exacte actuele diff, lease-expiry tests, runtime timeout-reserve | Checks op PR-head; geen productieactivatie |

## Latere, gated investeringen

- **Tweewerker-taak:** pas na echte maker/checker-runtime-bewijzen; vergelijk met één worker bij gelijk totaalbudget. Vereis een observeerbare vervolgactie op ontvangen informatie en onafhankelijke controle van hetzelfde eindartefact.
- **Evolutiecyclus:** pas na betrouwbare attributie; preregistreer taakset, baseline, kandidaat, holdout, grader, budget en beslisregel. Kandidaat mag evaluator/gates niet wijzigen. Vereis hergebruik na herstart en rollback.
- **Waardecontract:** voeg alleen ontbrekende velden toe aan bestaande geautoriseerde intake; geen LLM-businessplan per routineklus en geen nieuwe scheduler.

## Mijlpaaloordeel

- M0: gedeeltelijk bewezen — source inventory en historische hypotheses onderzocht; runtime-inventory en live state zijn incompleet.
- M1: gedeeltelijk bewezen — branch-fix plus gerichte tests; normale echte runtime-uitvoering ontbreekt.
- M2: onbeslist — geen nieuwe waardecontractketen geïmplementeerd.
- M3: geblokkeerd — geen runtimebewijs voor samenwerking.
- M4: niet bewezen — geen kandidaatvergelijking, transfer, retentie of rollbackcyclus.

