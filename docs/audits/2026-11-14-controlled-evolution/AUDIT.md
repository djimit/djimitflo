# DjimitFlo: gecontroleerde uitvoering en evolutie

Onderzoeksstand: 14 november 2026. Dit is een begrensde bron-, test- en snapshot-audit; geen productiecertificering.

## Baseline

| Scope | Identiteit | Status |
|---|---|---|
| Repository | djimit/djimitflo | geïsoleerde worktree /private/tmp/djimitflo-functional-improvements-20261114 |
| Actuele main tijdens onderzoek | 7758d153e415177de8e977721011c9675482934c | remotely fetched; geïnventariseerd als baseline |
| Werkbranch code na verificatie | codex/functional-improvements-20261114, e7baf39f | lokale codecommit; auditbewijs volgt als aparte commit |
| Primaire gebruikerscheckout | 9946ea4da760e266fb27f554f1d779d7f5837ad4, dirty | onaangeraakt; geen wijzigingen overgenomen |
| Runtime/data-tool | snapshot; commit_sha null | loopdata laatst bijgewerkt 19 juli, taskdata 13 november; geen actuele server-runtime-identiteit |

## Oordeel

De repository bevat een substantiële uitvoerings- en governancekern: taken, loop-workers, geneste leases, maker/checker, providergebruik, skills/memory, evidence en DjimitSec-contracten. Dat deze onderdelen als één betrouwbare productieflow werken, is niet aangetoond. De belangrijkste actuele belemmering is bewijs- en lifecycle-samenhang, niet een tekort aan agenten of voorstellen.

Op actuele main bevestigde broninspectie dat nested spawn-aanvraag een lease voorbereidt en prepared teruggeeft; workerdispatch is een aparte route. De spawn-tree telde toegekende grants als consumed gebruik voordat uitvoering plaatsvond. De normale workerstatus werd niet consequent teruggeprojecteerd naar sub_agent_spawns; alleen ProofRun had een expliciete statusupdate. De branch scheidt reservering van gemeten gebruik, projecteert normale terminale lease-uitkomsten en maakt onzekere voorbereiding zichtbaar als duurzame requested-intent. Herhaalde aanvragen met dezelfde sleutel delen een receipt; kleine geneste budgetten worden vooraf verdeeld of afgewezen. Een token grant is geen hard provider-tokenplafond; gebruik kan tijdens inference de grant overschrijden. De ToolBroker wordt beschikbaar gesteld maar is geen bewezen interceptor voor CLI-interne toolcalls. Dispatch blijft expliciet een aparte, policy-begrensde handeling.

De verbonden DjimitFlo MCP leest een snapshot. Dat toont bestaande data en freshness-gaten, maar bewijst geen huidige runtime, ingestelde productieflags of live uitvoering. Lokale runtime-CLI's bestaan; authenticatie, effectieve policy, budget en normale productiedispatch zijn in deze iteratie niet bewezen. Daarom is geen productie-taak gestart en geen echte swarm- of leerwinst geclaimd.

## Scope en dekking

- Statisch geïnventariseerd: 596 API-routeverklaringen en 61 MCP-tools. 551 routes en 60 tools hebben statische testverwijzingen. Dit bewijst niet dat handlers zijn uitgevoerd of domeingedrag is gevalideerd.
- Vier kritieke API-entries zijn door de bestaande route-inventory niet aan een testreferentie gekoppeld: openmythos GET /cases; swarms GET /intelligence/missions/:id/execution; swarms POST /expert/experts/:id/capabilities/:capability/review; swarms POST /expert/experts/:id/deprecate.
- Runtime-route-inventory ontbreekt; het bestaande script rapporteert NOT_EXECUTED zonder route-registration fixture. De runtime-facade summary-call faalde omdat zijn lokale entrypoint ontbreekt. De DjimitFlo read-only tools geven een snapshot terug, geen commit-bound live instance.
- Kritieke ketens onderzocht: nested spawn → lease → worker execution → status/accounting; tool-mediated runtime boundary; skill/memory attribution; readiness poller; DjimitSec finding/scan/verification/import.
- Geen productie-, VPS-, browser-, betaalde provider- of live CLI-taakuitvoering.
- Na de codewijzigingen: 874 Vitest-bestanden geslaagd, 2 overgeslagen; 8.202 tests geslaagd, 1 expliciet verwachte failure en 23 overgeslagen (`npm test --workspace=@djimitflo/server`).
- Voor nieuwe intent-/budgetregressies: baseline-worktree op 7758d153 faalt 9 assertions; branch slaagt 27/27 gerichte nested-spawn-tests.
- Repositorybrede typecheck en build geslaagd; lint heeft nul fouten en één bestaande unused-eslint-disable-waarschuwing in `packages/server/src/__tests__/github-pr-review-llm.test.ts:120`. `git diff --check` geslaagd.
- Typecheck en build geslaagd; lint heeft 0 errors en 1 bestaande warning (github-pr-review-llm.test.ts:120, ongebruikte eslint-disable). npm run audit:ci is in deze repository alleen de production dependency audit; die vond geen niet-geaccepteerde high/critical advisory.
- Draft PR #1272 bevat de eerdere code- en auditcommits. De nieuwe intent-/recoverywijziging is lokaal gevalideerd op e7baf39f maar moet nog naar de PR gepusht worden; checks op die codehead zijn daarom nog niet beschikbaar.
- Eerdere UX- en swarm-audits zijn historische onderzoeksscope, niet opnieuw als actuele productieobservatie gebruikt.

## Evolutionair oordeel

De bestaande skillroute heeft versie/digest, assignment-injectie en outcome-attributie onder expliciete configuratie, maar bewijst op zichzelf geen causale uplift. Memory-accesslog bewijst assemblage/selectie, niet dat modelgedrag de inhoud gebruikte. OutcomeLearningService blokkeert promotie bij alleen gerapporteerde causale labels. De oudere Gym-score combineert niet-vergelijkbare metrics zonder consistente richting; er is geen bewijs dat die score de aparte Evolve-selectie bestuurt. Er is geen gecontroleerde baseline/kandidaat/holdout/retentie/rollbackcyclus uitgevoerd. Evolutionaire verbetering is niet bewezen.

## Artefacten

- CAPABILITIES.csv: broninventaris van API- en MCP-ingangen; ontbrekende operationele velden zijn expliciet UNKNOWN.
- FINDINGS.json: H1–H13, inclusief nieuwe crash-intent, klein-budget en token-grantbeperkingen.
- SCENARIOS.json: test- en uitvoeringstatus; mocks tellen niet als live bewijs.
- NEXT_STEPS.md: maximaal vijf investeringen, afhankelijkheden en eerste iteratie.

