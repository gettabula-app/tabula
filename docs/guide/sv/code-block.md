# Kodblock

Ett kodblock lägger kod på tavlan som ett kort med färgad text med fast teckenbredd: en titel om du vill ha en, språket och radnummer om du vill ha dem. Det är ett objekt som alla andra: du kan flytta, låsa, kopiera och kommentera det, och det finns med i exporter.

> **En person i taget.** Koden i ett block är en enda text. Om två personer skriver i *samma* block samtidigt ersätter den senare ändringen den tidigare. Olika block är oberoende av varandra.

![Ett kodblock med titeln total.js, språket JavaScript, radnummer och färgad kod samt knapparna Wrap lines och Copy code uppe till höger](images/code-block.png)


## Lägg till ett

Öppna gruppen **Text** i det vänstra verktygsfältet (knappen med en liten pil, under lappen) och välj **Code block** (Kodblock). Klicka sedan på tavlan för ett block som är 520 brett, eller dra för att välja bredd. Det öppnas för skrivning direkt. Ett nytt block börjar på det språk du använde senast på den här tavlan, eller på **Plain text** (Ren text). På en telefon eller surfplatta bryts långa rader.

## Skriv i blocket

Dubbelklicka på blocket, eller markera det och tryck på `Enter`, för att skriva i det. Textrutan ligger exakt över koden, så ingenting flyttas när du börjar. Medan du skriver är färgerna avstängda; de kommer tillbaka när du avslutar.

| Tangent | Åtgärd |
|---|---|
| `Tab` | Två mellanslag. Med flera markerade rader indrar den alla. |
| `Shift+Tab` | Tar bort upp till två mellanslag från varje markerad rad |
| `Enter` | En ny rad med samma indrag |
| `Esc` eller `Ctrl+Enter` (`Cmd+Enter` på Mac) | Avsluta. Att klicka utanför avslutar också. |

Ett block rymmer upp till 20 000 tecken. En längre inklistring kapas, och du får veta det. Allt du skriver i ett svep är ett enda steg för **Undo** (Ångra).

## Kopiera, radbryt och rulla

Håll pekaren över ett block (eller markera det) så visas två knappar i dess övre högra hörn: **Wrap lines** (Radbryt) och **Copy code** (Kopiera kod). **Copy code** lägger den rena koden på urklipp, utan färger och radnummer. På en pekskärm visas knapparna alltid.

När **Wrap lines** är av kapas en lång rad vid kortets kant. Rulla koden åt sidan med ett svep i sidled eller med hjulet, `Shift` + hjulet, eller klicka in i blocket med `Tab` och använd `Left`, `Right`, `Home` och `End`.

## Egenskaper

Markera ett block och öppna **More properties** (Fler egenskaper):

- **Language** (Språk): en lista med ett sökfält. **Plain text** står först, sedan de vanliga språken och sedan resten efter namn.
- **Title** (Titel): visas i ett huvud på kortet. Om fältet är tomt finns inget huvud.
- **Line numbers** (Radnummer) och **Wrap lines**: två reglage som ser ut som reglagen på andra ställen i Tabula.
- **Width** (Bredd), som för andra objekt. Blockets höjd anpassas alltid efter koden.

Kodens färger följer tavlans tema; du behöver inte ställa in något.

## Dela och exportera

PNG-, SVG- och utskriftsexporter visar blocket så som det ser ut på tavlan, utan knapparna. En tavelfil (`.drift`) och en JSON-ögonblicksbild behåller koden, språket och titeln. En AI-agent som är ansluten med en åtkomsttoken kan skapa och ändra kodblock, och Tabulas inbyggda AI-funktioner läser koden på samma sätt som texten i andra objekt.

## Tangentbord och skärmläsare

Varje block är en region som namnges efter sin titel och sitt språk, till exempel ”Code, Deploy script, Shell”. Använd `Tab` för att nå kodytan och piltangenterna för att rulla den. I högkontrastläget i Windows har kortet en enkel kant, och koden visas i systemfärgerna.

## Ännu inte

Kodblock i Markdown-block är ännu inte färgade, och det finns varken hopfällning, radmarkering eller val av färgtema.
