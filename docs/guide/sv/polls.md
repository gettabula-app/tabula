# Omröstningar

I en omröstning ställer du en fråga till alla på tavlan och ger dem en fast lista med svarsalternativ. Du kan starta en på några sekunder från verktygsfältet eller lägga till den som ett steg i en [session](sessions.md).

## Starta en snabbomröstning

1. Klicka på **Start a quick poll** (Starta snabbomröstning) i verktygsfältet till vänster.
2. Skriv frågan i **Ask a question** (Ställ en fråga). Den får vara högst 200 tecken.
3. Fyll i svarsalternativen. En omröstning har 2 till 10 alternativ, vart och ett på högst 120 tecken. Klicka på **Add option** (Lägg till alternativ) för att lägga till fler eller på **x** bredvid ett alternativ för att ta bort det. Alternativen måste innehålla text och vara olika.
4. Välj hur personer ska svara:
   - **More than one answer** (Fler än ett svar): personer kan markera flera alternativ. Utan det kan varje person välja ett alternativ.
   - **Anonymous (names stay hidden)** (Anonymt (namnen förblir dolda)): är aktiverat som standard. Stäng av det om du vill visa vem som har valt vad i resultatet.
5. Klicka på **Start poll** (Starta omröstning) eller tryck på `Ctrl+Enter` (`Cmd+Enter` på Mac).

<!-- screenshot: formuläret för snabbomröstning med en fråga och tre ifyllda alternativ -->

Omröstningen öppnas direkt för alla på tavlan. Om en session redan pågår läggs omröstningen till direkt efter det aktuella steget och sessionen går vidare till den. Om ingen session pågår läggs omröstningen till sist bland tavlans steg, och sessionen startar med den.

Bara en omröstning kan vara öppen åt gången. Om du försöker starta en till visas meddelandet ”En omröstning är öppen. Avsluta den eller gå vidare först.”

## Lägg till en omröstning i en session

1. Öppna steglistan: klicka på **Edit steps** (Redigera steg) i fältet **Session ready** (Sessionen är redo), eller klicka på stegnamnet i fältet för den pågående sessionen.
2. Lägg till ett steg med **Add step** (Lägg till steg) eller välj ett befintligt.
3. Ställ in läget **Poll** (Omröstning). Omröstningsformuläret öppnas.
4. Klicka på **Save poll** (Spara omröstning).

Frågan används som stegets rubrik. Om du vill ändra omröstningen senare klickar du på **Edit poll** (Redigera omröstning) bredvid steget. När omröstningen har öppnats går det inte längre att ändra frågan eller alternativen. Läs om hur stegen körs i [Sessioner och fokusbegäranden](sessions.md).

## Svara på en omröstning

När ett omröstningssteg pågår visas ett kort ovanför sessionsfältet med frågan och svarsalternativen.

- Klicka på ett alternativ för att svara. Svaret sparas när du väljer.
- Om **More than one answer** är aktiverat klickar du på ett alternativ igen för att avmarkera det.
- Om du vill ändra ditt svar väljer du ett annat alternativ. Du kan ändra det tills omröstningen stängs.
- Klicka på **Clear my answer** (Rensa mitt svar) för att ta tillbaka ditt svar.

Texten **N av M har svarat** bredvid kortrubriken visar hur många som har svarat av alla som är på tavlan just nu. Varje person räknas en gång, även om personen har två flikar öppna.

Om du bara kan visa tavlan står det på kortet ”Endast visning. Bara personer som kan redigera tavlan kan svara.” Läs om roller i [Dela, roller och team](sharing.md).

## Stäng en omröstning

En omröstning är öppen medan dess steg pågår. Den stängs när sessionen går vidare till ett annat steg eller avslutas. Därefter kan ingen ändra sitt svar.

## Visa resultatet

Resultaten är dolda medan personer svarar, så att ingen påverkas av antalet röster. Den som leder sessionen bestämmer när resultaten ska visas.

1. Klicka på **Reveal results** (Visa resultat) i sessionsfältet. Du kan göra det medan omröstningen är öppen eller efter att den har stängts.
2. På kortet visas nu **Ranked results** (Rangordnade resultat): varje alternativ med antal röster och procentandel, med det mest valda först. Vid lika många röster behålls ordningen du skrev in alternativen i.
3. Om omröstningen inte är anonym visas namnen på personerna som valt varje alternativ under det.

Alla ser resultaten samtidigt. När resultaten har visats går det inte att ångra, men du kan rensa hela omröstningen (se nedan).

## Kopiera eller spara resultaten

När resultaten har visats finns två knappar i sessionsfältet:

- **Copy results** (Kopiera resultat) kopierar frågan och de rangordnade alternativen som Markdown, så att du kan klistra in dem i ett dokument.
- **Add results to board** (Lägg till resultat på tavlan) lägger en klisterlapp på tavlan med frågan och den rangordnade listan. Den placeras till höger om ditt befintliga innehåll. Anteckningen är en ögonblicksbild: den ändras inte om omröstningen ändras.

Båda åtgärderna avvisas tills resultaten har visats (”Visa resultaten först.”).

**Markdown summary** (Markdown-sammanfattningen) i tavlans meny listar också alla omröstningar som har öppnats. För omröstningar där resultatet inte har visats står det ”Resultatet har inte visats.”

## Efter sessionen

När sessionen avslutas behåller fältet ett block med **Poll results** (Omröstningsresultat) för den senaste omröstningen. Där visas frågan och antalet svar, med följande knappar:

- **Copy results** och **Add results to board** (tillgängliga när resultaten har visats).
- **Reveal results**, om du inte visade dem under sessionen.
- **Clear poll** (Rensa omröstning) tar bort omröstningen, dess svar och steget från tavlan.
- **Hide** (Dölj) (x) döljer blocket bara på din skärm. Det visas igen när någon startar en omröstning eller använder omröstningsverktyget, och när en nyare omröstning stängs.

På en telefon flyttas omröstningskortet och dess reglage ur vägen medan **Comments** (Kommentarer) eller **Chat** (Chatt) är öppet. De visas igen när du stänger panelen.

## Vem kan göra vad

- Alla som kan redigera tavlan kan starta en omröstning, svara, visa resultat och rensa den.
- Kommentatörer och läsare kan se omröstningskortet och resultaten när de har visats, men kan inte svara.
- I en anonym omröstning visas namnen aldrig i resultatet.

## Relaterat

- [Sessioner och fokusbegäranden](sessions.md)
- [Dela, roller och team](sharing.md)
- [Export och import](export-import.md)
