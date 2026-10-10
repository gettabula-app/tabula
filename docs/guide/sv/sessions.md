# Sessioner och fokusbegäran

En session är en tidsstyrd följd av steg som du leder på tavlan, till exempel skriva, gruppera, rösta och diskutera. Alla på tavlan ser samma steg och samma timer.

## Starta en session

Du kan starta en session på tre sätt:

- Lägg till en sessionmall från **Templates and team exercises** (Mallar och teamövningar) i verktygsfältet. Mallarna för tillbakablick, idégenerering, prioritering och planering innehåller ramar och färdiga steg. Se [Mallar](templates.md).
- Klicka på **Start a dot vote** (Starta en punktröstning) i verktygsfältet för ett enda röstningssteg utan mall. Först får du välja vad som går att rösta på (se [Punktröstning](#punktröstning)); klicka på knappen medan du håller ned `Shift` om du vill starta direkt med allt.
- Klicka på **Start a quick poll** (Starta en snabbomröstning) för ett enda omröstningssteg. Se [Omröstningar](polls.md).

När en tavla har steg men ingen session körs visar fältet längst ned **Session ready** (Sessionen är klar), antalet steg och den sammanlagda tiden i minuter. Klicka på **Start session** (Starta session) för att börja med steg 1, eller på **Edit steps** (Redigera steg) för att ändra dem först.

En tavla kan bara köra en session åt gången. Om du lägger till en ny mall ersätts den gamla mallens steg.

<!-- screenshot: sessionsfältet längst ned på tavlan medan en session pågår, med stegräknare, timer och knappen Next step -->

## Sessionsfältet

Medan en session pågår visar fältet längst ned:

- Knapparna **Previous step** (Föregående steg) och **Next step** (Nästa steg). På det sista steget ändras **Next step** till **Finish** (Slutför).
- Stegräkningen (till exempel 2/5), stegets namn, läge och instruktioner. Klicka på det här området för att öppna hela listan med steg.
- En timer med **Start timer** (Starta timer) eller **Pause timer** (Pausa timer), och **+1** (Lägg till en minut).
- Knappar som är särskilda för stegets läge (se nedan).
- **Ask everyone to look here** (Be alla titta här), en knapp med en målikon. Se [Fokusbegäran](#fokusbegäran).

Om ett steg är länkat till en ram flyttas vyn för personen som flyttar sessionen till det steget till ramen. Alla andra får ett kort där det står vem som flyttade till vilket steg, och väljer själva om de vill gå dit. Se [Fokusbegäran](#fokusbegäran).

## Vem kan leda en session

Alla som kan redigera tavlan kan starta, flytta, pausa och avsluta en session. Det finns ingen särskild ledarroll, så kom överens i rummet om vem som styr. De som bara kan kommentera eller visa tavlan ser fältet, men knapparna är inaktiverade. Om din arbetsyta använder inloggning kan du läsa mer i [Dela, roller och team](sharing.md).

## Redigera stegen

Klicka på stegets namn i fältet eller på **Edit steps** i fältet **Session ready**. I listan **Steps** (Steg) kan du:

- Byta namn på ett steg, ange antal minuter och ändra dess **mode** (läge).
- Klicka på numret för att hoppa till det steget.
- Klicka på **Add step** (Lägg till steg). Om en ram är markerad på tavlan länkas det nya steget till den ramen.
- Ta bort ett steg med papperskorgsknappen.
- Klicka på **Summary** (Sammanfattning) för att ladda ned en Markdown-sammanfattning av sessionen. Den tar inte med andras privata anteckningar eller röstningens löpande antal röster innan du visar resultatet.
- Klicka på **End session** (Avsluta session) för att stoppa en pågående session.

### Steglägen

| Läge | Vad det gör |
|---|---|
| **Write** (Skriv) | Alla lägger till anteckningar som vanligt. |
| **Private writing** (Privat skrivande) | Anteckningar är dolda för andra tills du visar dem. |
| **Group** (Gruppera) | Ett steg där anteckningar flyttas till grupper. |
| **Dot vote** (Punktröstning) | Alla placerar punkter på anteckningar. |
| **Discuss** (Diskutera) | Ett steg för samtal. |
| **Poll** (Omröstning) | Ställer en fråga med en fast lista med svar. |

## Timer

Du kan ange antal minuter för varje steg. Timern är pausad när ett steg börjar. Klicka på **Start timer** för att starta den, på **Pause timer** för att stoppa den och på **+1** för att lägga till en minut. En timer som har mindre än en minut kvar får en varningsstil, och en ljudsignal hörs när tiden når noll. Alla ser samma tid.

## Privat skrivande

I ett steg med **Private writing** är anteckningar som du skapar bara synliga för dig. Andra ser inte vad du har skrivit. Klicka på **Reveal notes** (Visa anteckningar) i fältet om du vill visa allas anteckningar på en gång. När du går vidare till ett annat steg döljs anteckningarna igen, men anteckningar som redan har visats fortsätter att vara synliga.

Andras dolda anteckningar går inte heller att använda med någon markering: Markera alla, markering genom att dra, kopiera, duplicera, justera, **Arrange** (Ordna), byta färg, spara som mall, AI-fältet eller exportera (tavelfil, JSON, Mermaid). De blir tillgängliga igen när du har visat dem.

Markörer för kommentarer på dolda anteckningar är också dolda. Se [Kommentarer](comments.md).

## Punktröstning

**Vad går att rösta på.** **Start a dot vote** öppnar en liten panel med ett val och antalet objekt:

- **Selected items** (Markerade objekt) är standardvalet när något är markerat. Det är det enda sättet att rösta på en ram, och då används exakt de objekt du har markerat.
- **Everything** (Allt) omfattar alla anteckningar, former, kort, texter och bilder på tavlan. Ramar, ritningar, kanbankolumner och kopplingslinjer ingår inte.
- **Sticky notes only** (Bara klisterlappar).

**Start vote** (Starta röstning) börjar röstningen; **Start on everything** (Starta med allt) hoppar över valet. Medan röstningen pågår har objekt som kan få en punkt en streckad kontur, och om du klickar på något annat får du veta att det inte ingår i röstningen.

I ett steg med **Dot vote**:

1. Klicka på ett objekt med kontur för att lägga till en punkt. Klicka igen för att lägga till fler.
2. Håll ned `Shift` och klicka för att ta bort en av dina punkter. På en pekskärm finns ingen `Shift`: slå på **Remove dots** (Ta bort punkter) i fältet och tryck sedan på ett objekt för att ta tillbaka en av dina punkter. Stäng av funktionen om du vill lägga till punkter igen. Den stängs av automatiskt när röstningen avslutas.
3. Fältet visar hur många punkter du har kvar. Klicka på det för att ange **Dots per person** (Punkter per person) (1, 2, 3, 5, 10, valfritt antal eller **No limit** (Ingen gräns)). Ändringen gäller genast för alla, och redan placerade punkter ligger kvar.
4. Klicka på **Reveal votes** (Visa röster) för att visa det sammanlagda resultatet.
5. Klicka på **Copy results** (Kopiera resultat) för att kopiera den rangordnade listan som Markdown.

På en telefon är röstningsfältet en kompakt rad: **Reveal votes** (som en ögonikon), **Remove dots**, dina återstående punkter, **Finish** och en knapp med **Info** (Information) som visar instruktionerna. Stegets namn, timern och de andra stegens knappar är dolda medan röstningen pågår.

När sessionen avslutas ligger punkterna kvar på tavlan. Fältet visar **Vote results** (Röstningsresultat), med **Copy results** och **Clear dots** (Ta bort punkter) för att ta bort dem.

## Omröstningssteg

På en telefon används ett kompakt sessionsfält för en pågående omröstning (antalet svar och dess knappar), så att både omröstningskortet och fältet får plats; kortet och fältet väntar medan Chat (Chatt) eller Comments (Kommentarer) är öppet. Meddelandet om att en omröstning eller röstning har startat visas ovanför kortet och fältet (allra högst upp i fönstret när listan **All steps** (Alla steg) är öppen), och listan **All steps** flyttas upp ovanför fältet när du lägger till ett steg, så att **Next step** går att nå.

I ett steg med **Poll** visas ett svarskort ovanför fältet. Fältet har **Reveal results** (Visa resultat), följt av **Copy results** och **Add results to board** (Lägg till resultat på tavlan). Omröstningen stängs när du går vidare till nästa steg. Läs mer i [Omröstningar](polls.md).

## Fokusbegäran

Ingen kan flytta din vy eller få dig att följa efter sig. Om du vill att andra ska titta på något skickar du en begäran, och var och en bestämmer själv vad hen vill göra.

### Be andra titta

1. Flytta vyn till det du vill visa för andra.
2. Klicka på **Ask everyone to look here** i sessionsfältet. Ett meddelande visar "Du har bett alla att titta på din vy".

Din egen vy ändras inte. Knappen är inte begränsad till personer som kan redigera, så även de som bara kan visa eller kommentera kan skicka en begäran. När du har skickat en begäran inaktiveras knappen i 10 sekunder och dess hjälptext räknar ned ("Be igen om 7 sek"). Begäranden från samma person som kommer inom 10 sekunder från varandra ignoreras.

När en session flyttas till ett steg med en ram flyttas bara vyn för personen som flyttade sessionen dit. De andra får en begäran där personen och steget anges.

<!-- screenshot: begärandekortet längst ned på tavlan med knapparna Go to, Follow, Dismiss och Mute -->

### När någon ber dig titta

Ett kort visas längst ned på skärmen: "Namn ber dig titta på hens vy" eller "Namn flyttade till steget Titeln". Kortet försvinner av sig självt efter 20 sekunder. Högst tre kort visas samtidigt. Välj ett:

- **Go to** (Gå dit) flyttar din vy till platsen där personen var. Du kan fortfarande flytta vyn själv.
- **Follow** (Följ) håller kvar din vy på personens medan hen panorerar och zoomar. En bricka visar "Du följer Namn. Panorera, zooma eller tryck på Esc för att sluta." Följandet avslutas när du panorerar eller zoomar, trycker på `Esc`, klickar på **Stop** (Sluta följa) eller när personen lämnar tavlan.
- **Dismiss** (Stäng) stänger kortet.
- **Mute Name** (Tysta Namn) ignorerar personens begäranden framöver.

Du får inget kort för dina egna begäranden eller från någon som du redan följer.

### Tysta och slå på igen

Tystningen sparas för personen på den tavlan och bara på den här enheten. När någon är tystad visar tavlans meny **Muted people** (Tystade personer) med ett antal. Öppna det och klicka på **Unmute** (Sluta tysta) bredvid ett namn för att se personens begäranden igen.

Utanför en session kan du se var någon annan är genom att klicka på personens avatar i det övre fältet. Det flyttar bara din egen vy.

## Avsluta en session

Klicka på **Finish** på det sista steget eller på **End session** i listan med steg. Timern stannar och fältet återgår till viloläge. Steg från en snabb röstning eller snabbomröstning tas bort; steg från en mall finns kvar, så **Session ready** visas igen och du kan köra sessionen en gång till.

## Dölj det inaktiva fältet

När ingen session pågår kan fältet visa **Session ready**, **Vote results** och **Poll results** (Omröstningsresultat). Om du vill dölja det:

- Klicka på **Hide** (Dölj) (x), eller
- Tryck på `Esc`.

`Esc` döljer fältet bara när det inte har något annat att göra: inget är markerat, verktyget **Select** (Markera) är aktivt, du drar inte och redigerar ingen text, ingen kommentar är öppen och inget fält eller någon dialogruta har fokus. Annars gör `Esc` som vanligt.

Att dölja fältet ändrar inget på tavlan, och valet sparas bara för dig på den här enheten. **Session ready** visas igen när du öppnar steglistan, lägger till en mall eller startar en session. **Poll results** visas igen när någon startar en omröstning, när du klickar på omröstningsverktyget eller när en senare omröstning avslutas. **Vote results** går inte att dölja: ta bort punkterna i stället. Fältet för en pågående session går inte att dölja.

## Återställa versioner under en session

[Versionshistorik](version-history.md) tillåter inte återställning medan en session pågår. Avsluta sessionen först.

## Relaterat

- [Omröstningar](polls.md)
- [Mallar](templates.md)
- [Kommentarer](comments.md)
- [Versionshistorik](version-history.md)
