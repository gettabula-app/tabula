# Kopplingslinjer

Kopplingslinjer binder ihop former och sitter kvar när du flyttar dem. För en enkel linje som inte är fäst vid något, se [Linjer](lines.md). De kan ha pilspetsar, en etikett och en av tre linjedragningar.

## Rita en kopplingslinje

Det finns tre sätt:

1. **Kopplingslinjeverktyget.** Tryck på `L` (eller `X`), eller klicka på **Connector** (Kopplingslinje). Dra från en form till en annan. Släpp på en form om du vill fästa änden där, eller på en tom yta om du vill låta änden vara fri. Verktyget växlar sedan tillbaka till **Select** (Markera).
2. **Kopplingspunkter.** När **Select** är aktivt håller du pekaren över en form. Blå punkter visas på dess fyra sidor. Dra från en punkt till en annan form eller till en tom yta.
3. **Klicka på en punkt.** Klicka på en punkt utan att dra. Se nedan.

Kopplingslinjer kan fästas vid former, klisterlappar, text, ikoner och UML-element. De kan inte fästas vid ramar eller ritningar, och inte heller vid låsta objekt.

![En kopplingslinje som dras från en rektangel till en ellips, där ellipsen visar sina fyra blå kopplingspunkter](images/connector-drag.png)

## Klicka på en kopplingspunkt

Att klicka på en punkt är ett snabbt sätt att skapa ett diagram.

- Om en annan form ligger intill den här i den riktningen läggs en kopplingslinje till den. Om de redan är ihopkopplade markeras bara formen.
- Om det inte finns något där skapar Tabula en kopia av formen på den sidan, kopplar ihop dem och startar textredigering så att du kan skriva dess etikett. Kopian placeras precis bortom formen. Om andra former ligger där flyttas kopian längre åt samma håll till närmaste lediga plats i stället för att hamna ovanpå dem.

Ångra (`Ctrl+Z`, `Cmd+Z` på Mac) gör om åtgärden i ett steg.

## Linjedragning

Markera en kopplingslinje. Välj **Route** (Dragning) i snabbåtgärdsfältet:

- **Straight** (Rak)
- **Elbow** (Rätvinklad) (med räta vinklar). Det här är standardvalet.
- **Curved** (Böjd)

Samma val finns i egenskapspanelen. Ditt senaste val blir standard för nästa kopplingslinjer du ritar.

## Linjestil och färg

I egenskapspanelen har en kopplingslinje färgen **Line** (Linje), **Width** (Bredd) (1 till 6 px) och **Style** (Stil) (heldragen, streckad eller prickad).

## Pilspetsar

Öppna **More properties** (Fler egenskaper) och ställ in pilspetsar för **Start** (Start) och **End** (Slut). Varje alternativ i listorna visas med en liten förhandsvisning av pilspetsen, riktad åt det håll som kopplingslinjen ska gå, så att du kan välja det alternativ som ser rätt ut. Alternativen är None (Ingen), Arrow (Pil), Open arrow (Öppen pil), Hollow triangle (Ihålig triangel), Filled diamond (Fylld romb), Hollow diamond (Ihålig romb), Circle (Cirkel), Bar (Streck) och Crow's foot (Kråkfot) (många eller en). Nya kopplingslinjer börjar utan pilspets i början och med en pil i slutet. **Reverse direction** (Byt riktning) byter plats på ändarna.

## Etiketter

Dubbelklicka på en kopplingslinje, eller markera den och tryck på `Enter`, och skriv sedan. Tryck på `Enter` eller `Esc` för att avsluta. Du kan också skriva i fältet **Label** (Etikett) i egenskapspanelen. Radera texten om du vill ta bort etiketten.

## Flytta eller koppla om en ändpunkt

Markera en kopplingslinje. Ett runt handtag visas i varje ände. Dra ett handtag till en annan form om du vill fästa änden där, eller till en tom yta om du vill låta den vara fri. När du flyttar en form följer de fästa ändarna med.

Om du tar bort en form ligger kopplingslinjer som satt fast i den kvar på tavlan, med den änden fri där den var.

## Flera kopplingslinjer på samma sida

När flera kopplingslinjer möter samma sida av en form sprids ändarna ut längs sidan, ordnade efter vart varje linje går, i stället för att samlas i mitten. Ändarna placeras jämnt på var sin sida om mitten, med högst 28 enheters avstånd mellan dem, längs formens kontur. En ensam kopplingslinje stannar i mitten. På former med en böjd eller oregelbunden kontur (hjärta, moln, rund pratbubbla, dokument, fördröjning och visning) stannar alla kopplingslinjer i mitten. Exporter och miniatyrbilder av mallar visar samma placering.

## UML-relationer

I panelen **UML** (UML) visas relationer under **Relationships** (Relationer): association, riktad association, generalisering, realisering, beroende, aggregering, komposition, synkront meddelande, asynkront meddelande, svar, include, extend och övergång. Välj en och dra sedan från ett element till ett annat. Varje val ställer in rätt pilspetsar och linjestil.

Om du vill ändra en befintlig kopplingslinje markerar du den, öppnar **More properties** och använder **UML relationship** (UML-relation). Välj **None** om du vill återgå till en vanlig kopplingslinje. Om du ändrar en pilspets manuellt tas relationen också bort.

## Relaterat

- [Former, text och klisterlappar](shapes-text-notes.md)
- [Exportera och importera](export-import.md#kopiera-som-mermaid)
