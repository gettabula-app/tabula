# Bilder

Du kan lägga in bilder på en tavla: en skärmbild, ett foto av en whiteboard, en logotyp eller ett diagram. En bild är ett objekt som alla andra. Du kan flytta och ändra storlek på den, placera den i en ram och kommentera den.

## Lägg till en bild

Det finns tre sätt. Alla fungerar med flera filer samtidigt, upp till 10 filer.

- **Paste.** (Klistra in.) Kopiera en bild eller skärmbild och tryck sedan på `Ctrl+V` (`Cmd+V` på Mac) när tavlan är aktiv. Bilden placeras mitt i vyn.
- **Drop.** (Släpp.) Dra en eller flera filer från datorn till tavlan. De placeras där du släpper dem.
- **Image button** (Bildknapp). Välj **Image** (Bild) i det vänstra verktygsfältet, nedanför **Frame** (Ram), och välj filer. Om servern inte lagrar bilder visas inte knappen.

PNG-, JPEG-, GIF-, WebP- och SVG-filer fungerar. Andra format, till exempel ett HEIC-foto från en telefon, avvisas med ett meddelande som anger filnamnet. Övriga filer som du lade till samtidigt läggs ändå in.

De nya bilderna markeras. Flera bilder placeras sida vid sida, en rad i taget. Ett enda `Ctrl+Z` tar bort dem allihop igen.

> Bara personer som får redigera tavlan kan lägga till bilder. Alla som kan öppna tavlan kan se dem.

## Vad händer med filen

Tabula förbereder bilden i webbläsaren innan den skickas:

- En bild som är större än 2 560 pixlar på sin längsta sida skalas ned. Den visas i en rimlig storlek på tavlan, högst ungefär 60 procent av vyn. Du kan förstora den igen.
- Plats- och kamerainformation i ett foto (den del av filen som kan innehålla GPS-koordinater) tas bort, och bilden vänds rätt.
- En SVG-fil blir en vanlig PNG-bild, så den ser likadan ut överallt.
- En animerad GIF lämnas som den är. Den måste vara mindre än 10 MB och högst 2 560 pixlar bred eller hög. Annars avvisas den.
- En fil som är större än 10 MB efter bearbetningen avvisas. Det finns också en gräns för hur många bilder en tavla kan lagra. När utrymmet är slut visas meddelandet ”Den här tavlan har använt sitt bildlagringsutrymme”. Ta bort bilder du inte längre behöver eller be administratören om hjälp.

## Arbeta med en bild

Markera en bild för att flytta, rotera, låsa, duplicera eller ta bort den, eller för att placera den i en ram. Dra i ett hörn för att ändra storlek. Bildens proportioner behålls. En bild kan ha kopplingslinjer och kommentarer, precis som en form.

Snabbåtgärdsfältet har två knappar för bilder:

- **100%** återställer bildens naturliga storlek, kring dess mittpunkt.
- **Alt text** (Alternativtext) öppnar ett fält där du beskriver bilden med en mening. Skärmläsare använder texten. AI-verktyg som läser tavlan gör det också.

<!-- screenshot: snabbåtgärdsfältet ovanför en markerad bild, med 100% och Alt text -->

## När en bild inte har kommit fram än

Bilden sparas först på din enhet och skickas sedan till servern i bakgrunden. Den visas direkt för dig. Om du är offline eller servern är långsam ser andra personer en grå ruta med texten ”Bilden har inte laddats upp än” tills den kommer fram. Den skickas när anslutningen är tillbaka. Du behöver inte göra något mer.

Om kopian på din enhet har försvunnit, eller servern nekade uppladdningen, släpps inte bilden. Du får ett meddelande (”An image could not be uploaded because this browser no longer has it. Add it again.”), och rutan visar ”Not uploaded: add this image again”. En nekad uppladdning provas en gång till varje gång tavlan öppnas.

I en hostad arbetsyta går det tills vidare inte att ladda upp en bild över 1 MB. Du ser ”This image is over 1 MB, which is the upload limit for now. Use a smaller image.”, och rutan visar ”Not uploaded: over 1 MB”. Om du släpper flera på en gång räknar meddelandet dem (”2 images are over 1 MB and may not upload to this workspace yet. Use smaller images.”). Tabula försöker skicka bilder på cirka 900 KB, så de flesta foton krymps så att de ryms.

Om webbläsaren inte kan behålla en kopia av bilden att ladda upp från (lagringsutrymmet är fullt eller webbplatsdata är blockerad) läggs bilden inte till på tavlan. Du ser ”The image was not added: this browser could not save a copy to upload. Its storage may be full, or site data may be blocked. Free up space or allow site data, then add it again.” (med flera bilder: ”2 images were not added: …”). Inget lämnas kvar på tavlan som aldrig kan laddas upp.

En grå ruta kan också visa:

| Meddelande | Vad det betyder |
|---|---|
| Läser in | Bilden håller på att hämtas. |
| Offline | Enheten kan inte nå servern och har ingen kopia. Den försöker igen när du är online. |
| Ingen åtkomst till den här bilden | Du har inte längre åtkomst till tavlan. |
| Bilden hittades inte | Servern har inte filen. |

## Bilder i exporter och mallar

- Exporterna **PNG image** (PNG-bild) och **SVG vector** (SVG-vektor) innehåller bilderna.
- **Board file (.drift)** (Tavelfil (.drift)) innehåller bilderna. Om du öppnar den som en ny tavla eller använder **Import a board file into this board** (Importera en tavelfil till den här tavlan) återskapas bilderna och skickas till tavlan i bakgrunden. En bild som inte kan läsas från filen (en typ som Tabula inte stöder eller en fil som är för stor) visas som en platshållare. Resten av tavlan öppnas som vanligt.
- **JSON snapshot** (JSON-ögonblicksbild) anger vilka bilder som finns men innehåller dem inte. Filen säger det. Använd en `.drift`-fil om du vill behålla bilderna.
- **Markdown summary** (Markdown-sammanfattning) listar en bild i en ram som `Image: ` följt av dess alternativtext, eller `Image (image/png, 640 x 480)` om den saknar sådan text.
- När du sparar en tavla eller en markering som mall utelämnas bilderna. Dialogrutan visar hur många. Mallar kan inte innehålla bilder än.

## Ta bort en bild

Om du tar bort en bild försvinner den från tavlan, men inte från tavlans historik. Äldre versioner i [Versionshistorik](version-history.md) visar den fortfarande, och om du återställer en sådan version kommer bilden tillbaka. Tabula behåller filen så länge någon sparad version eller själva tavlan hänvisar till den. Några dagar efter att den sista hänvisningen försvinner tas filen bort automatiskt. Fram till dess kan alla som kan öppna tavlan fortfarande se bilden i de versionerna.

Om en bild måste försvinna helt tar du bort den från tavlan och raderar sedan versionerna där den visas.

## Relaterat

- [Former, text och lappar](shapes-text-notes.md)
- [Exportera och importera](export-import.md)
- [Dela, roller och team](sharing.md)
