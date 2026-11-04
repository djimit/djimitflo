# Uitvoerbare AgenticOS UX-backlog

Bronbasis `38be63d5`; geen gemeten gebruikerstijden of visuele productiedekking. S = doorgaans één afgebakende wijziging; M = meerdere bestaande componenten/contracten; L = meerdere iteraties. Dit zijn relatieve inschattingen, geen offertes. Er is op basis van dit onderzoek geen bevestigde P0-productiestoring. P1 betekent een belangrijke operationele tekortkoming of een risico op verkeerde interpretatie, niet dat reeds een verkeerde productiebeslissing bewezen is.

## 0. Lokale herstelpatch — P1/P2, S, uitgevoerd

**Bewijs:** Commons-link verliest reviewanker via legacy redirect; tabselectie vervangt querycontext; Mission Control maskeert afwezige top/health-metingen als nul; drie aanvullende reads zitten buiten Refresh. Zie verificatiematrix.

**Bestanden:** `TabbedPage.tsx`, `AppShell.test.tsx`, `AgentCommonsPage.tsx` en bestaande test; `SwarmMissionControlPage.tsx` en nieuwe `SwarmMissionControlRefresh.test.tsx`.

**Ingreep:** canonieke link, alleen tabparameter bijwerken, unknown-defaults voor expliciete counters, alle zeven bestaande reads verversen met sequence guards en onafhankelijke weergave. Geen backendwijziging.

**Alternatief:** alleen legacy redirect repareren zou meer oude links helpen maar lost de huidige onnodige redirect niet op. Een nieuwe data-loader is onnodig voor deze reparatie. **Risico:** extra leesverzoeken bij Refresh, expliciet onvolledige/niet-atomaire snapshots; geen extra writes. **Acceptatie:** regressietests falen op bronbasis, slagen op patch; bekende nul behouden; snelle bronnen niet blokkeren; oude response geen overschrijving; herstelde fout verdwijnt. **Effect:** behoud van context en juiste onbekend-semantiek is lokaal getest; tijdwinst niet gemeten. **Confidence:** hoog voor bronoorzaken en lokaal gedrag; productie ongetest.

## 1. Visuele en taakgerichte basislijn — P1, M

**Bewijs/gat:** geen beschikbare ingebouwde browser, geen actuele screenshots of ingelogde journeymetingen. **Componenten:** cockpit, Agents, Swarm, Mission Control/detail, Commons, Knowledge, Configuration, Observability; daarna overige geïnventariseerde routes. **Ingreep:** met bestaande authenticatie read-only bezoeken, relevante screenshots inspecteren en veilige controls toetsen; schrijfdekking apart houden. Reproduceer vijf taken uit ASSESSMENT met dezelfde gegevens op desktop, mobiel en toetsenbord.

**Alternatief:** brononderzoek kan doorgaan, maar vervangt visueel bewijs niet. **Afhankelijkheid:** beschikbare browser of toestemming voor vervangende Playwright-browser; geen nieuwe credentials of toegang. **Risico:** productieknoppen kunnen werk starten; Run Proof, New round, invitations, sync/apply en promotion niet activeren. **Acceptatie:** iedere geteste handeling heeft route, staat, screenshot en resultaat; laden/fout/leeg/unknown onderscheiden; stappen/tijd werkelijk gemeten. **Effect:** bruikbare basislijn voor verbeterclaims en keuze van visuele richting. **Confidence:** hoog voor noodzaak, huidig live gedrag onbekend.

## 2. Directe bewijsnavigatie in het bestaande missiedossier — P1, M

**Bewijs:** MissionDetail bestaat al; meerdere relationship/provenance-ID's en Knowledge skill-card-runs zijn tekst zonder vervolgnavigatie. **Bestanden:** `MissionDetailPage.tsx`, `KnowledgePage.tsx`, `ExecutionTimeline.tsx`, bestaande tests en `lib/api.ts` alleen als een echt ontbrekend leescontract nodig blijkt.

**Ingreep:** maak expliciet opgenomen run-ID's links naar de bestaande runroute; groepeer uitkomst, uitvoering, deelnemers en evidence rond dezelfde missie. Identificeer eerst het bevoegde artifact retrieval-contract: de huidige “View Artifact”-div is geen werkende handeling. Bij ontbreken daarvan toon expliciet dat openen niet beschikbaar is. Geen verzonnen `/artifacts/:id`-route.

**Alternatief:** kopieerbare ID's als kleine tussenstap; die laten handmatig zoekwerk bestaan. **Afhankelijkheid:** bestaande IDs en route-/permissioncontracten. **Risico:** een verkeerd getypeerde ID kan naar een ander entiteittype wijzen; evidence kan buiten scope vallen. **Acceptatie:** opgenomen run in één handeling bereikbaar; speciale tekens geëncodeerd; ontbrekende bron geen link; Back herstelt context; unauthorized evidence blijft ontoegankelijk. **Effect:** minder cross-page zoekacties, te meten tegen taakbasislijn. **Confidence:** hoog voor navigatiegat, voordeelomvang onbekend.

## 3. Fouten en onbekende staten per bron — P1, M

**Bewijs:** resterende pilot/runner-defaults produceren nul bij afwezigheid; Swarm leesfouten zijn deels console-only; Agents toont tijdens eerste ophalen “No agents configured”. Zie commissiebronnen. **Bestanden:** `SwarmMissionControlPage.tsx` en models/paneltests, `SwarmOverviewPage.tsx`, `AgentsPage.tsx`, bestaande `useResource` en `LoadErrorNotice`.

**Ingreep:** laad/fout/leeg/knownzero/stale onderscheiden per onafhankelijke bron; hergebruik laatste goede data met expliciete fout/freshness en retry. Maak geen pagina-brede “alles gezond” uit een subset. In de lokale patch is alleen de genoemde top/health-scope opgelost.

**Alternatief:** hele pagina blokkeren tot alle bronnen terug zijn; te veel beschikbaarheid verliezen bij één optionele fout. **Afhankelijkheid:** benoemde bronfouten en observatietijden waar beschikbaar. **Risico:** stale records als actueel tonen, of gedeeltelijke data verbergen. **Acceptatie:** deferred/reject/empty/zero/recover/race-tests voor iedere gewijzigde bron; geen schijnnul; snelle paneeldata zichtbaar bij langzame peer. **Effect:** minder foutieve conclusies over inactiviteit; meet misinterpretaties en herstelstappen. **Confidence:** hoog bron, frequentie onbekend.

## 4. Menselijke aandacht op uitzonderingen — P1, M

**Bewijs:** Cockpit/NeedsYou bestaat; Swarm-errors verwijzen slechts naar “check logs”. **Bestanden:** `OperatorCockpitPage.tsx`, `SwarmOverviewPage.tsx`, bestaande decision/assurance-views en read-model dat een werkelijk gekoppelde failure kan leveren.

**Ingreep:** ieder relevant probleem toont resultaatimpact, bron, tijd, verantwoordelijke, agent-oplosbaar versus bevoegdheidsbesluit en eerstvolgende toegestane actie. Voeg geen click toe aan gewone peeruitwisseling. Verbind een fout alleen aan de uitvoering die de bron noemt, nooit aan een toevallige current task.

**Alternatief:** extra centraal logdashboard; verliest de taakcontext en dupliceert Observability. **Afhankelijkheid:** bestaande task/run/decision-links, huidig authbeleid. **Risico:** verkeerde failure-attributie of bevoegdheidsverschuiving. **Acceptatie:** diagnose van seedfailure zonder ID overtypen; onbekende oorzaak blijft onbekend; geen nieuwe approval-loop of automatische productiehandeling. **Effect:** minder onderbrekingen per onafhankelijk geverifieerd resultaat, met gelijke juistheid. **Confidence:** middel/hoog; live journey nog nodig.

## 5. Toegankelijke agent- en mobiele navigatie — P1/P2, S–M

**Bewijs:** Swarm-agentcards zijn `div onClick`; Agents-namen openen hun detailroute niet; gesloten mobiele sidebar is alleen uit beeld getransformeerd. **Bestanden:** `SwarmOverviewPage.tsx`, `AgentsPage.tsx`, `Layout.tsx`, shell/page-tests; ontwerptokens alleen waar nodig.

**Ingreep:** echte Links voor details, met bestaande focusstijl. Maak gesloten mobiele navigatie daadwerkelijk niet-focusbaar; voeg juiste expanded/control-semantiek en Escape/focusherstel toe via bestaande componentpatronen. Toets Commons-filter/tabsemantiek en geef zoekveld een label. Behoud aanwezige lijst/tabelalternatieven voor de graaf.

**Alternatief:** handmatig role/tabindex/keydown op cards; native link heeft minder code en betere browsersemantiek. **Afhankelijkheid:** echte viewport/focustests. **Risico:** desktopnav per ongeluk verbergen of focus verliezen op breakpoint. **Acceptatie:** 375/768/1440 px, Tab/ShiftTab/Enter/Escape, zichtbare focus, geen verborgen focusdoelen; zoom/reflow/schermlezer aanvullend. **Effect:** gelijke taakbereikbaarheid zonder muis; geen claim van volledige WCAG-conformiteit. **Confidence:** hoog voor brongaten, visueel onbewezen.

## 6. Commons: van kenniskloof naar toetsbare volgende stap — P1, M

**Bewijs:** bestaande reflection/proposal dispositions, grounding-outcomes en reviewroute; co-participatie is al correct begrensd. **Bestanden:** `AgentCommonsPage.tsx`, bestaande Commons-read-contracten en tests; proposal-reviewservice alleen als expliciete lineage ontbreekt.

**Ingreep:** thread-permalink en bewijsfase met opgenomen reflection/proposal/goal/run-links; onzekerheid, tegenbewijs, voorgestelde onderscheidende test en stopconditie tonen waar vastgelegd. Technisch falende review apart van afwijzing van idee. Volgende stap en verantwoordelijke vanuit bestaande evidence.

**Alternatief:** uitgebreidere constellation zonder lineage; levert activiteit maar geen aantoonbare vooruitgang. **Afhankelijkheid:** expliciete bestaande IDs, dezelfde gates/caps. **Risico:** onterecht causale verbinding of automatische promotie. **Acceptatie:** thread/context reproduceerbaar uit URL; geen edge uit co-occurrence; reflection nooit automatisch promoted; timeout/needs-evidence/opposed verschillen; geen nieuwe mensklik voor gewone dialoog. **Effect:** grounded, onafhankelijk geteste hergebruikuitkomsten per vergelijkbare threadcohort, naast gesprekstokens; nog geen positieve winstclaim. **Confidence:** middel/hoog.

## 7. Bewijs voor memory- en skillwaarde — P1/P2, M

**Bewijs:** fitness is observationeel, skill cards record-only, niet alle injection/transferrelaties bestaan. **Bestanden:** `KnowledgePage.tsx`, `EvolutionExperiments.tsx` en bestaande evaluatie/read-modelservices; uitvoeringsprompts en memoryregels zijn beschermd en blijven tijdens lopende experimenten bevroren.

**Ingreep:** lifecyclebronnen, taak/run, versie, gebruik en hercheck naast elkaar tonen. Causale vergelijking alleen bij vooraf geregistreerde behandeling/controle; anders letterlijk geen causale vergelijking. Bestaande experimenten voortzetten volgens oorspronkelijke analysemomenten.

**Alternatief:** relevantie/volume als kwaliteitsproxy; onvoldoende voor leerwaarde. **Afhankelijkheid:** bestaande experimentregistratie en toegestane evaluatieomgeving. **Risico:** leakage, selectiebias, tussentijds aanpassen of herhaald gunstig toetsen. **Acceptatie:** opslag/retrieval/gebruik/uitkomst/causaleffect apart; exacte versies en held-out taakdefinitie; tegenbewijs en onzekerheid zichtbaar; geen injection-claim uit record-only card. **Effect:** bewijs welke kennis daadwerkelijk taakprestaties verbetert. **Confidence:** hoog semantisch, effect onbekend.

## 8. Swarmwaarde per token en meetbare energie — P1/P2, M UI, experiment apart

**Bewijs:** completioncohorten/usagecoverage bestaan; solo-versus-swarm causaliteit ontbreekt; `resource-ledger.ts` noemt GPU package energy op twee plekken onjuist wall-meter. **Bestanden:** `SwarmMissionControlPage.tsx`, `UsagePage.tsx`, experimentviews, `resource-ledger.ts` en tests.

**Ingreep:** eerst de energieomschrijving corrigeren zonder berekening te veranderen. Toon daarna vergelijkbare, vooraf geregistreerde solo/swarmuitkomsten: kwaliteit, verificatietijd, tokens en hun dekking; GPU Wh afzonderlijk met host-/jobafbakening en allocatie. Geen nieuwe optimizer of automatische routing.

**Alternatief:** tokens of watt minimaliseren; kan taakfalen goedkoper maken zonder waarde te leveren. **Afhankelijkheid:** stabiele taken, onafhankelijke evaluator, model/policy/runtimeversies, toestemming voor experimentkosten. **Risico:** verkeerd denomintor, selectiebias, ongemeten cloudenergie. **Acceptatie:** missingusage/energy geeft geen efficiëntiewinst; gym/maintenance/production apart; paired baseline en stopregel vooraf; functionele hercheck na promotie. **Effect:** aantoonbare kwaliteitsbehoudende resourcewinst, niet vooraf beloofd. **Confidence:** hoog voor meetgat, winst onbekend.

## 9. Effectieve configuratie vanuit de uitvoering — P2, M

**Bewijs:** Configuration biedt provenance/default/override/restart al, maar niet task-contextueel. **Bestanden:** `ConfigurationPage.tsx`, `MissionDetailPage.tsx`, bestaande config-view/expliciete read-contracten.

**Ingreep:** contextuele filters/links naar bestaande instellingen; toon runtimebron en observatietijd. Nieuwe waarde-editor alleen als echte operatorbehoefte en bestaand schrijfcontract veilig aangetoond zijn. **Alternatief:** nieuwe configuratieservice; niet gerechtvaardigd. **Afhankelijkheid:** juiste koppeling runtime→effectieve configuratie. **Risico:** geheimen, verkeerde runtimewaarden, env als deploymentbewijs. **Acceptatie:** redactie blijft server-side, runtime scope herkenbaar, restartsemantiek behouden; geen production write vanuit onderzoek. **Effect:** minder lookupwerk bij configdrift. **Confidence:** middel.

## 10. Visuele samenhang en navigatie pas na taakbewijs — P2, M

**Bewijs:** huidige bron mixt legacy lichte Swarm-stijlen met semantische donkere tokens; sommige `status-success`-classes hebben geen corresponderende thematoken. Geen actuele geometrie/contrastmeting. **Bestanden:** bestaande pages, `Layout.tsx`, `styles/index.css`.

**Ingreep:** na actuele screenshots drie visuele richtingen beoordelen binnen bestaande tokens, elk rond dezelfde hoofdtaak. Kies daarna één, implementeer de kleinste complete journey en vergelijk met de basislijn. Geen nieuwe pagina voor iedere backendcomponent. Maak animatie optioneel en informatie ook zonder kleur begrijpelijk.

**Alternatief:** globale visuele rewrite vóór bewijs; groter regressierisico en geen diagnosewinst aangetoond. **Afhankelijkheid:** backlog1 en gekozen visuele richting. **Risico:** regressie van bekende workflows en informatieverlies door overmatige vereenvoudiging. **Acceptatie:** dezelfde kernhandelingen werken, mobiele/keyboardstates getest, contrast gemeten, geen status alleen in kleur, geen verloren route/bookmark. **Effect:** herkenning en taakprestatie meten; decoratie is geen zelfstandig succescriterium. **Confidence:** bronmatig middel, visueel ongetest.

## Implementatievolgorde

Herstelpatch → browser/taakbasislijn → bewijsnavigatie + bronstatus + toegankelijkheid → Commons-lineage en configuratiecontext → gecontroleerde memory/swarmwaarde → gekozen visuele uitwerking. Reviews en CI per kleine wijziging; operator merge/deployment met bestaande bevoegdheden. Geen volledig nieuw AgenticOS-framework, eventbus, graphdatabase, skillregister of approvalsubsystem is hiervoor nodig aangetoond.
