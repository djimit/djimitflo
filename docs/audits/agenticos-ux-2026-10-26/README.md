# DjimitFlo: AgenticOS UX-onderzoek en eerste reparaties

Onderzoek: 26 oktober 2026. Bronbasis: `38be63d520bb5fef89be99458cf3b562098224c3`.

**Dit is een brononderzoek met lokale functionele verificatie en beperkt publiek HTTP-bewijs. Het is geen voltooide visuele audit van productie.** De ingebouwde browser leverde geen beschikbare browsers en kon `iab` niet openen. Toestemming voor Playwright als vervanging is gevraagd; zolang die ontbreekt is deze route niet gebruikt. Er zijn daarom geen actuele screenshots of gemeten gebruikerstijden. De productie-HTML en JavaScript-entry zijn wel alleen-lezen opgehaald; dat bewijst geen ingelogde functionaliteit. De gekoppelde MCP-database meldt `mode: snapshot` en `commit_sha: null`, en is niet gebruikt als actuele productiewaarheid.

## Leesvolgorde

1. [Beoordeling en doelervaring](ASSESSMENT.md): huidige mogelijkheden, tekortkomingen, AgenticOS-werkmodel, leerkring en meetplan.
2. [Uitvoerbare backlog](BACKLOG.md): prioriteiten, bestanden, alternatieven, risico's en acceptatiecriteria.
3. [Route-inventaris](ROUTES.md) en [machineleesbare inventaris](route-inventory.json): 50 routedeclaraties; directe API-aanroepen per pagina met expliciete extractiebeperkingen. Dit is geen bewijs dat alle routes voor iedere rol toegankelijk zijn.
4. Onafhankelijke commissie: [navigatie](committee-navigation.md), [bewijs en leren](committee-evidence.md), [kritische controle](committee-checker.md).
5. [Verificatiematrix](VERIFICATION.md), [HTTP-bewijs](http-evidence.json) en [evidence-register](evidence.json).

## Afgebakende codewijzigingen

- Commons-voorstellen verwijzen direct naar de bestaande Assurance-reviewinbox.
- Het bestaande gedeelde tabcomponent behoudt andere URL-parameters, inclusief herhaalde filters, bij klikken en toetsenbordbediening.
- Mission Control toont ontbrekende uitvoerings- en gezondheidsmetingen als `unknown`; een werkelijk gerapporteerde nul blijft nul.
- Refresh herhaalt alle zeven bestaande leesbronnen, verwijdert herstelde bronfouten en negeert achterhaalde responses. Snelle bronnen wachten niet op tragere bronnen voor hun weergave.

Geen nieuwe pagina, endpoint, dependency, database, scheduler, autorisatieregel of leermechanisme is toegevoegd. Dit herstelt bestaande lees- en navigatiecontracten; er is geen nieuw experimenteel gedrag om te activeren. Productie, uitvoeringsbeleid en de lopende experimentoppervlakken blijven ongewijzigd. De wijzigingen zijn een eerste herstelstap; zij realiseren nog niet de volledige voorgestelde ervaring en bewijzen geen versnelde agent-evolutie.
