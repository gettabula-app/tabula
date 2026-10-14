# Länkkort

Ett länkkort lägger en webbadress på tavlan som ett litet kort med sidans titel, en kort beskrivning och en bild. Markera det för att flytta det, och öppna det för att läsa sidan. Det är ett objekt som alla andra: du kan ändra storlek på det, lägga det i en ram, koppla det och kommentera det.

Länkkort visas där din arbetsyta har länkförhandsvisningar påslagna. Utan förhandsvisningar får du ändå ett kort, men det visar bara adressen (se [När det saknas förhandsvisning](#när-det-saknas-förhandsvisning)).

## Lägg till en länk

Det finns tre sätt.

- **Klistra in.** Kopiera en webbadress och tryck på `Ctrl+V` (`Cmd+V` på Mac) med tavlan framme. Kortet hamnar där pekaren är, eller mitt i din vy. Ett kort meddelande säger ”Link added” (Länken har lagts till) och erbjuder **Turn into text** (Gör om till text).
- **Link-knappen.** Öppna gruppen **Text**, **Table** (Tabell), **Code block** (Kodblock), **Markdown block** (Markdown-block) och **Link** (Länk) i det vänstra verktygsfältet och välj sedan **Link**. Skriv eller klistra in adressen och tryck på `Enter` eller **Add** (Lägg till).
- **Släpp.** Dra en länk från en annan webbläsarflik till tavlan. Du får ett kort för varje adress, upp till 10 åt gången.

Kortet visas direkt med adressen och webbplatsens namn. En tunn linje längs dess nederkant rör sig medan Tabula läser sidan, oftast i en sekund eller två. Sedan fylls titeln, beskrivningen och bilden i. `Ctrl+Z` tar bort hela kortet igen, inte bara ett tomt kort.

Bara en enda `http`- eller `https`-adress blir ett länkkort. En adress som ingår i annan text förblir text, och det gäller även en adress med ett användarnamn eller lösenord (`https://name:password@…` kan inte läggas till). Om du vill klistra in en adress som vanlig text trycker du på `Ctrl+Shift+V` (`Cmd+Shift+V` på Mac).

> Alla som kan öppna tavlan kan se ett länkkort och adressen i det. Om en adress ser ut att innehålla en hemlighet, till exempel `?token=…`, frågar Tabula först med meddelandet ”Add this link?” (Lägg till den här länken?) och visar adressen med hemligheten borttagen. Välj **Cancel** (Avbryt) för att låta bli att lägga till kortet.

Bara personer som kan redigera tavlan kan lägga till länkkort.

## Öppna en länk

Ett enkelklick markerar kortet, så att dra i ett kort aldrig öppnar en flik. Så här öppnar du sidan i en ny flik:

- tryck på `Enter` (eller `Ctrl+Enter` / `Cmd+Enter`) på ett markerat kort;
- dubbelklicka på kortet;
- håll ned `Ctrl` (`Cmd` på Mac) och klicka på det; eller
- välj **Open** (Öppna) i snabbåtgärdsfältet.

Alla som kan se tavlan kan öppna ett kort, även personer som bara kan läsa den. Håll pekaren över ett kort för att se adressen som verktygstips. Om adressen har skickat vidare till en annan plats, säger verktygstipset vart.

## De tre storlekarna

Kortets storlek avgör dess layout. Välj **Compact** (Kompakt), **Card** (Kort) eller **Large** (Stor) i snabbåtgärdsfältet för att ändra storleken till respektive standardstorlek, eller dra i ett hörn.

| Layout | Visar |
|---|---|
| **Compact** | En rad: webbplatsens ikon, titeln (eller adressen) och domänen. |
| **Card** | Webbplatsens namn och ikon, titeln på upp till två rader, en rad beskrivning, domänen och sidans bild till höger. |
| **Large** | Bilden över kortets överkant, sedan webbplatsens namn, titel, beskrivning och domän. |

Långa titlar och adresser skärs av med ”…” och går aldrig utanför kortet.

## Ändra ett kort

Markera ett kort för att se dess snabbåtgärdsfält. Personer som bara kan läsa eller kommentera ser enbart **Open**.

- **Refresh preview** (Uppdatera förhandsvisningen) läser sidan igen, till exempel när den har fått en ny titel. En titel eller beskrivning som du själv har redigerat behålls.
- **Edit** (Redigera) gör titeln och beskrivningen till två textrutor på kortet. Skriv och klicka utanför kortet för att spara, eller tryck på `Esc` för att avbryta.
- **Turn into text** (Gör om till text) ersätter kortet med en textruta som innehåller adressen. `Ctrl+Z` återställer kortet.
- En text eller lapp som bara innehåller en adress har **Turn into link card** (Gör om till länkkort) i sitt snabbåtgärdsfält.

På en telefon ligger **Open** kvar i fältet, och resten finns i menyn **⋯**.

## När det saknas förhandsvisning

- **Loading preview…** (Läser in förhandsvisning…) Sidan läses. Det tar högst några sekunder.
- **No preview.** (Ingen förhandsvisning.) Sidan kunde inte läsas: webbplatsen svarade inte i tid, den är inte en vanlig webbsida, den är för stor eller den kräver inloggning. Peka på kortet för att se orsaken. Kortet fungerar fortfarande som en länk, och **Refresh preview** försöker igen.
- **Address only.** (Endast adress.) Din arbetsyta har länkförhandsvisningar avstängda, eller så är du gäst på tavlan. Kortet visar adressen och domänen, och **Open** fungerar.

En sida som kräver inloggning (ett delat dokument, ett företagsverktyg) kan Tabula inte läsa, eftersom Tabula inte loggar in någonstans. Ett sådant kort visar **No preview** och sin adress.

## Integritet

När du lägger till eller uppdaterar ett länkkort läser **Tabulas server** den länkade sidan en gång för att hämta dess titel, beskrivning och bild. Ingen webbläsare kontaktar webbplatsen för att rita kortet. Den länkade webbplatsen ser en förfrågan från Tabulas server, inte från dig och inte från någon som tittar på tavlan. Bilden och webbplatsens ikon sparas med tavlan, precis som vilken bild som helst, och visas därifrån. Sidan får aldrig veta vem som tittar på tavlan.

Den som driver din arbetsyta bestämmer om förhandsvisningar är påslagna (se [Adminpanelen](admin.md)). En webbplatsägare som inte vill att Tabula läser deras sidor kan spärra Tabula: se [Länkförhandsvisningar](link-previews.md).

## Export och andra verktyg

- **PNG**- och **SVG**-exporter ritar kortet med dess bild. I en SVG är kortet en länk som fortfarande öppnar adressen när du öppnar filen i en webbläsare.
- **Markdown summary** (Markdown-sammanfattningen) listar ett kort som `- [Title](address)`, eller bara adressen när kortet saknar titel.
- En mall behåller ett kortets adress, titel och beskrivning, men inte dess bild eller ikon. Den visar en bokstav i en färg tills någon uppdaterar den.
- Ett kort som du kopierar till en annan tavla behåller sin adress och text. Bilden tillhör den tavla som läste sidan, så på den nya tavlan visar kortet webbplatsens första bokstav tills du trycker på **Refresh preview**.
- **AI tools** (AI-verktyg) som läser tavlan ser ett kort som adress, titel och beskrivning. Det är text från den länkade sidan och behandlas som all annan text på tavlan.

## Relaterat

- [Bilder](images.md)
- [Exportera och importera](export-import.md)
- [Länkförhandsvisningar: för webbplatsägare och administratörer](link-previews.md)
