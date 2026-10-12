# Klistermärken

Klistermärken är färgade emoji som du placerar på en tavla som reaktion eller dekoration. De sparas på tavlan, så klistermärken fungerar offline och visas i exporter.

## Öppna klistermärkespanelen

Klicka på **Stickers** (Klistermärken) i verktygsraden. Panelen öppnas vid sidan.

- **Set** (Uppsättning) väljer emoji-stil: **Fluent**, **Twemoji** eller **Noto**. Fluent är standard.
- **Search stickers** (Sök klistermärken) filtrerar den aktuella uppsättningen. Resultaten visas efter en kort paus.
- En anteckning under rutnätet anger licensen. Vissa uppsättningar kräver att du anger upphovsperson om du publicerar tavlan. **Licences** (Licenser) öppnar en lista över alla uppsättningar och villkoren för deras licenser.

## Placera ett klistermärke

- Klicka på ett klistermärke för att lägga till det mitt i vyn. Varje klick efter det placerar nästa klistermärke lite längre åt höger och nedåt än det förra, så att de inte hamnar ovanpå varandra. Efter att du har flyttat vyn ett steg bort, eller flyttat eller tagit bort det senast placerade klistermärket, börjar placeringen om mitt i vyn.
- Du kan också dra klistermärket till valfri plats på tavlan.

Klistermärken är större än vanliga ikoner så att de syns tydligt. Markera ett klistermärke om du vill flytta, ändra storlek på (proportionerna behålls), rotera, duplicera, låsa eller ta bort det, precis som andra objekt. Du kan också placera det i en ram.

Klistermärken har inga färgreglage. Färgen kommer från emojin. Egenskapspanelen för ett markerat klistermärke har rubriken **Sticker** (Klistermärke).

## Reaktioner

Så här reagerar du på något på tavlan:

1. Markera en anteckning, form eller ett annat objekt.
2. Klicka på **React with a sticker** (Reagera med ett klistermärke) i snabbåtgärdsfältet.
3. Välj en av de 16 reaktionerna, till exempel en tumme upp, ett hjärta, en partypuff, ögon eller eld.

Ett litet klistermärke placeras bredvid det övre högra hörnet av markeringen. Det följer inte med objektet om du flyttar det senare, och det har ingen räknare. Ta bort det som vilket objekt som helst eller ångra.

<!-- screenshot: menyn React with a sticker öppen ovanför en markerad klisterlapp -->

## Offline

Klistermärken som redan finns på tavlan visas alltid, även i PNG- och SVG-exporter, med eller utan anslutning.

Panelen fungerar offline när du har hämtat klistermärkesuppsättningarna till den här enheten:

1. Öppna panelen **Stickers**.
2. Under rutnätet visar raden **Sticker sets** (Klistermärkesuppsättningar) hur mycket data hämtningen använder och har knappen **Download for offline** (Hämta för offlineanvändning). Raden är dold i webbläsare som saknar offlinelagring.
3. Klicka på **Download for offline**. Raden visar förloppet, till exempel ”Hämtar klistermärkesuppsättningar: 40 av 120 filer”, tillsammans med en stapel. Klicka på **Cancel** (Avbryt) för att stoppa hämtningen. Den fortsätter även om du stänger panelen.
4. När hämtningen är klar står det på raden att uppsättningarna är tillgängliga offline.

När uppsättningarna har hämtats fungerar sökningar och förhandsvisningar utan anslutning för alla tre uppsättningarna (Fluent, Twemoji och Noto).

- **Remove** (Ta bort) på samma rad tar bort offlinekopian. Uppsättningarna finns fortfarande online och klistermärken som redan finns på tavlor påverkas inte.
- Om servern har en nyare version av uppsättningarna står det på raden att en uppdatering finns. **Update** (Uppdatera) hämtar bara ändrade filer, och **Remove** finns kvar.
- Om enheten inte har tillräckligt med ledigt lagringsutrymme avbryts hämtningen och ett meddelande förklarar varför.

Du behöver inte hämta ett klistermärke som du redan har sett. Webbläsaren sparar bilden för varje klistermärke du läser in. Ett klistermärke från en uppsättning som du varken har hämtat eller visat läses inte in förrän du är online igen.

Om panelen inte kan läsa in en uppsättning eller förhandsvisning förklarar den varför och visar **Retry** (Försök igen). Den försöker också igen när anslutningen återkommer.

## Relaterat

- [Former, text och klisterlappar](shapes-text-notes.md)
- [Export och import](export-import.md)
