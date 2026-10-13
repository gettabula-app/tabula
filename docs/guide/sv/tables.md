# Tabeller

En tabell är ett rutnät av celler på tavlan, för listor, planer, jämförelser och allt annat som behöver rader och kolumner. Varje cell innehåller en kort text, och tabellen är ett objekt som alla andra: du kan flytta, låsa, kopiera och kommentera den, och den finns med i exporter.

> **Olika celler, ingen konflikt.** Två personer kan skriva i olika celler i samma tabell samtidigt, och båda ändringarna sparas. Skriver två personer i *samma* cell samtidigt skriver de över varandra: den senare ändringen gäller.

## Lägg till en

Tryck på `G` och klicka sedan på tavlan för en tabell med 3 kolumner och 3 rader, eller dra ut en ruta: tabellen får så många kolumner och rader som ryms i den. Den första cellen öppnas för skrivning.

Du kan också kopiera celler från ett kalkylblad (Excel, Google Sheets, Numbers) och klistra in dem på tavlan: cellerna kommer in som en tabell.

## Skriv i cellerna

Dubbelklicka på en cell, eller markera tabellen, klicka på en cell och tryck på `Enter`, för att skriva i den.

| Tangent | Åtgärd |
|---|---|
| `Enter` | En ny rad inne i cellen |
| `Tab` / `Shift+Tab` | Gå till nästa eller föregående cell. `Tab` i den sista cellen lägger till en rad. |
| `Esc` | Avsluta |

Celler visar **bold**, *italic*, `code` och länkar så som du skriver dem i Markdown (`**bold**`, `*italic*`, `` `code` ``, `[text](https://example.com)`). Rubriker, listor och andra block känns inte igen i en cell; de visas så som du skrev dem. En cell rymmer upp till 1 000 tecken och växer i höjd för att rymma texten.

## Markera celler

Markera tabellen och klicka sedan på en cell för att markera den. `Shift`-klicka på en annan cell, eller håll ned `Shift` och tryck på en piltangent, för att markera ett block av celler. Piltangenterna och `Tab` flyttar mellan cellerna, `Enter` skriver i den aktiva cellen och `Esc` släpper cellerna.

Med markerade celler:

- `Delete` tömmer dem.
- `Ctrl+C` (`Cmd+C` på Mac) kopierar dem som text som du kan klistra in i ett kalkylblad. Om du klistrar in tabbseparerad text i en markerad cell fylls celler från den platsen, och rader och kolumner läggs till vid behov.

## Rader, kolumner och stil

Högerklicka på en cell (eller tryck och håll ned på en pekskärm) för tabellmenyn:

- **Insert** (Infoga) en rad ovanför eller under, eller en kolumn till vänster eller höger.
- **Move** (Flytta) en rad upp eller ned, eller en kolumn åt vänster eller höger.
- **Delete** (Ta bort) raden eller kolumnen.
- **Header row** (Rubrikrad) och **header column** (Rubrikkolumn) gör första raden eller kolumnen fet, tonad och avdelad med linjer.
- **Align** (Justera) kolumnens text till vänster, mitten eller höger.
- **Fill** (Fyll) de markerade cellerna med en färg.
- **Clear cells** (Töm celler), **Copy for a spreadsheet** (Kopiera för ett kalkylblad) och **Copy as Markdown** (Kopiera som Markdown).

Dra i linjen mellan två kolumner för att ändra kolumnens bredd. En tabell har upp till 100 rader och 30 kolumner. En tabells storlek är alltid storleken på dess kolumner och rader, så den har inga handtag för att ändra storlek.

## Dela och exportera

PNG-, SVG- och utskriftsexporter visar tabellen ritad så som den ser ut på tavlan, utan markeringen. En tavelfil (`.drift`) och en JSON-ögonblicksbild behåller varje cell. Tavlans **Markdown summary** (Markdown-sammanfattningen), som agenter läser, tar med tabellen som en Markdown-tabell. En AI-agent som är ansluten med en åtkomsttoken kan skapa en tabell av rader med text och ersätta dess celler. Tabulas inbyggda AI, med **Summarise** (Sammanfatta), **Cluster** (Gruppera) och **Generate ideas** (Generera idéer), läser en tabells celler precis som annan objekttext. Den ändrar aldrig en tabell.

## Ännu inte

Sammanslagna celler, cellkommentarer och kopplingslinjer som fäster vid en enda cell ingår inte i tabeller ännu. En cell innehåller bara ren text, med fet, kursiv, kod och länkar.
