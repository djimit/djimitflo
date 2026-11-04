# Functionele verificatie en grenzen

Alle onderstaande UI-handelingstests zijn lokaal met React Testing Library/jsdom uitgevoerd; **geen enkele rij is bewijs van werking in de ingelogde productiebrowser**. Bronbasis: `38be63d520bb5fef89be99458cf3b562098224c3`.

| Handeling / functie | Verwacht | Geconstateerd op bronbasis | Patch / oordeel | Bewijs |
|---|---|---|---|---|
| Commons: review-inbox openen | Canonieke Assurance-bestemming met sectieanker | Legacy `/compliance`-redirect verliest hash | WORKING lokaal voor linkbestemming; scroll/focus NOT_TESTABLE | Bestaande Conversation-renderingtest controleert exacte href en alleen proposed-status. |
| Gedeelde tabs: klik/keyboard/Back | Alleen tab verandert; andere filters behouden | Hele query vervangen | WORKING lokaal | AppShell-test bewaart trace en herhaalde filters, wisselt met klik/Home en gaat terug. |
| Mission Control: eerste/failed read | Afwezige uitvoerings-/healthtellers unknown | Top5/healthtellers werden nul | WORKING lokaal voor genoemde scope | `SwarmMissionControlRefresh.test.tsx`: failed core met overige bronnen aanwezig. |
| Mission Control: geregistreerde nul | Nul blijft nul | Werkte al | WORKING lokaal behouden | Zelfde suite: Active Exec expliciet nul. |
| Refresh | Alle zeven zichtbare leesbronnen opnieuw; herstelde fout weg | Curve/events/missionexecutions alleen bij mount | WORKING lokaal | Zelfde suite: requestaantallen per bron en herstelde learningfout. |
| Trage optionele bron | Snelle kerngegevens verschijnen | Eerste patch introduceerde head-of-line wachten; checker vond dit | WORKING lokaal na correctie | Deferred learningread; core Active Exec wordt nul vóór afronden optionele read. |
| Optionele bron antwoordt nooit | Refresh/afgeronde operatoractie niet vasthouden; kernfout direct tonen | Tussenversie hield loading vast tot alle zeven reads klaar waren | WORKING lokaal na correctie | Refresh opnieuw klikbaar bij pending learningread; core failure zichtbaar terwijl alle optionele reads pending zijn. |
| Oude refreshresponse | Geen overschrijving van nieuwere data | Geen uniforme guard voor complete readset | WORKING lokaal | StrictMode dubbele mount; oude respons met9 kan latere0 niet vervangen. |
| View Artifact | Evidence openen | Klikbare vorm zonder link/handler | NOT_IMPLEMENTED in onderzocht component | `ExecutionTimeline.tsx:122–128`; ophalencontract eerst vaststellen. |
| Swarm-agentkaart met toetsenbord | Native link naar agentdetail | Alleen div onClick | BROKEN bronmatig voor native linkbediening; browser ongetest | `SwarmOverviewPage.tsx:332–335`; backlog5. |
| Gesloten mobiele navigatie | Niet-focusbaar/verborgen voor bediening | Alleen transform, geen inert/hide/focusherstel | PARTIAL bronmatig; browser ongetest | `Layout.tsx`; onafhankelijke checker. |
| Commons-leerwinst / swarmvoordeel | Onafhankelijk vergelijkend uitkomstbewijs | Geen vergelijking in dit onderzoek | NOT_TESTABLE | Commissie evidence, ASSESSMENT-meetplan. |
| Overige productiecontrols | Daadwerkelijke veilige interactie plus feedback | Niet bediend | NOT_TESTABLE | Browser ontbreekt; geen writes of credentials gebruikt. |

## Uitgevoerde controles

- Schone fysieke dependency-installatie in geïsoleerde worktree, geen gedeelde gewijzigde source-aliases.
- Gedragsregressies eerst tegen de oude implementatie; daarna tegen de patch. Exacte herhaalbare bronbasis hierboven; extra baseline-worktree met uitsluitend nieuwe/gewijzigde tests gebruikt voor onafhankelijke reproductie.
- In die extra baseline-worktree faalden zes van de 26 tests in de drie gewijzigde testbestanden: querycontext, Commons-doellink, unknown-counters, ontbrekende kernfoutmelding, verouderde responses en onvolledige Refresh. De overige twintig slaagden. Dezelfde 26 tests slagen op de patch. Dit voorkomt dat oude defecten of alleen nieuwe fixtures als herstelbewijs worden beschouwd.
- Volledige dashboardsuite: 61 bestanden, 332 tests geslaagd op de uiteindelijke functionele patch.
- Onafhankelijke checker: 46 tests in zes relevante bestanden geslaagd; tweede maker/checker-perspectief op de async- en contextreparaties.
- Volledige repository type-check geslaagd; dashboard type-check en build na de laatste functionele wijziging geslaagd.
- Repositorylint: geen errors; één bestaande ongebruikte eslint-disable-waarschuwing in een ongewijzigde servertest. Dashboardlint afzonderlijk schoon.
- De dashboardsuite meldt een jsdom-beperking: “Not implemented: navigation to another Document”. Succes in deze tests bewijst geen echte externe documentnavigatie.

Geen volledige server-/fleet-/integratie-/E2E-suite lokaal uitgevoerd voor deze frontendpatch. Geen productiebrowser-, schermlezer-, zoom-/reflow-, contrast- of netwerk-instrumentatie uitgevoerd. GitHub CI en reviewstatus moeten op de exacte uiteindelijke PR-head worden beoordeeld; lokaal groen is geen merge- of deploymentgoedkeuring.

De gedeelde fetchlaag heeft in de onderzochte code geen request-time-out. Een nooit afgeronde kernbron kon loading al vóór deze wijziging vasthouden; die bestaande beperking blijft staan. Aanvullende evidence veroorzaakt dat na de reparatie niet meer. Oude of na unmount afgeronde responses worden genegeerd; verzoeken worden niet fysiek afgebroken. Meerdere bronantwoorden vormen geen atomair snapshot.

## Reproduceren

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test -w @djimitflo/dashboard
npm run type-check
npm run lint
npm run build -w @djimitflo/dashboard
```

De lokale install gebruikte `--ignore-scripts`; hiermee wordt geen native server-/SQLite-runtimevalidatie geclaimd. De volledige productie-install/release blijft de bestaande CI-/deployroute volgen.
