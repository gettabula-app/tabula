# Markdown-block

Ett Markdown-block är en plats på tavlan för längre anteckningar, med rubriker, listor, uppgiftsrutor, tabeller och länkar. Du skriver det i Markdown, ett enkelt sätt att markera upp text, och Tabula ritar upp det formaterat. Det är ett objekt som alla andra: du kan flytta, ändra storlek på, låsa och kommentera det, och det finns med i exporter.

> **En person i taget.** Två personer som redigerar samma Markdown-block samtidigt skriver över varandra: den senare ändringen gäller. Redigera i stället olika block samtidigt.

## Lägg till ett

Välj **Markdown block** (Markdown-block) i det vänstra verktygsfältet, under **Text** (Text), och klicka sedan på tavlan. En ruta öppnas för texten: skriv i Markdown och tryck sedan på `Esc` (eller `Ctrl+Enter`, `Cmd+Enter` på Mac) för att se den formaterad. Dra i stället för att klicka om du vill välja bredd.

## Redigera

Dubbelklicka på ett block, eller markera det och tryck på `Enter`, för att se och redigera dess källtext. `Tab` indrar ett listobjekt; `Esc` avslutar. Om du tömmer rutan och avslutar tas blocket bort.

Dra handtagen på dess vänstra och högra sida för att ändra bredden. Höjden följer texten.

## Vad du kan skriva

| Du skriver | Du får |
|---|---|
| `# Heading`, `## Smaller heading` | Rubriker (upp till sex nivåer) |
| `**bold**`, `*italic*`, `~~struck~~` | Fet, kursiv och genomstruken text |
| `` `code` `` och ett kodblock med tre backticks | Kod med fast teckenbredd |
| `- item`, `1. item`, indragna rader | Listor och kapslade listor |
| `- [ ] task` och `- [x] done` | Uppgiftsrutor du kan bocka av på tavlan |
| `> quote` | Ett citat |
| `[text](https://example.com)` | En länk |
| `[text](#obj:ID)` | En länk till ett annat objekt på tavlan |
| En tabell med `\|` och en `---`-rad | En tabell |
| `---` | En linje |

Allt annat visas så som du skrev det. Tabula kör inte HTML: om du skriver `<b>x</b>` ser du `<b>x</b>`. Länkar fungerar för adresser som börjar med `https://`, `http://` och `mailto:`, samt för objekt på tavlan. Andra typer av länkar visas som vanlig text.

## Bocka av en uppgift

Markera blocket och klicka sedan på en uppgiftsruta för att bocka av eller ta bort bockmarkeringen. Ett `Ctrl+Z` ångrar det. Personer som bara kan läsa tavlan, och block som är låsta, kan inte bocka av uppgifter.

## Öppna en länk

Markera blocket först och klicka sedan på länken (eller håll ned `Ctrl`, `Cmd` på Mac, och klicka). En webblänk öppnas i en ny flik. En länk till ett objekt på tavlan markerar objektet och flyttar vyn dit. Om du klickar på ett block som du inte har markerat blir det bara markerat, så att du aldrig öppnar en sida av misstag när du drar.

## Kopiera Markdown

Markera blocket och välj **Copy as Markdown** (Kopiera som Markdown) i snabbåtgärdsfältet (eller i egenskapspanelen). Texten kopieras så som du skrev den, så att du kan klistra in den i ett annat dokument.

## Dela och exportera

PNG- och SVG-exporter ritar blocket formaterat. En tavelfil (`.drift`) behåller texten som du skrev den. Tavlans **Markdown summary** (Markdown-sammanfattningen), som agenter läser, tar med blocket. En AI-agent som är ansluten med en åtkomsttoken kan läsa och skriva Markdown-block. Tabulas inbyggda AI-funktioner läser dem bara, via Markdown-sammanfattningen; de skriver inte till ett block.

## För skärmläsare

Tavlans översikt listar ett Markdown-block som ”Markdown block” tillsammans med dess första rubrik eller rad, och läser upp hela texten och hur många uppgifter som är klara. Se [Tangentbord och skärmläsare](accessibility.md).

## Gränser

Ett block rymmer upp till 20 000 tecken. En agent som skriver med en åtkomsttoken kan skriva upp till 4 000 tecken i taget. Bilder från tavlans eget bibliotek kan nämnas i ett block, men ett block visar dem som en märkt ruta tills vidare.
