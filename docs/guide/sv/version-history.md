# Versionshistorik

Med versionshistoriken kan du se tidigare lägen för en tavla, förhandsvisa en version utan att ändra något och återställa den. Använd funktionen för att rätta till ett misstag eller gå tillbaka till en viktig tidpunkt.

## Öppna versionshistoriken

Öppna tavlans meny och välj **Version history** (Versionshistorik). Alternativet finns i gruppen **Board** (Tavla), under **Board settings** (Tavleinställningar). En panel öppnas till höger.

Menyalternativet visas för ägare och redigerare samt för alla när arbetsytan inte kräver inloggning. Kommentatörer och läsare ser det inte.

Versionshistoriken lagras på servern. Om du är offline eller om tavlan inte är ansluten till en server står det i panelen: ”Versionshistoriken lagras på servern och kräver en anslutning.”

![Panelen Version history med flikarna All och Named och knappen Save version, en namngiven version och automatiska versioner grupperade under Today](images/version-history.png)

## Automatiska och namngivna versioner

Listan visar versionerna med den nyaste först, grupperade efter dag. Översta raden, **Current board** (Aktuell tavla), är den aktuella tavlan. Varje version visar sin tid, en rubrik och hur många objekt tavlan hade, tillsammans med ändringen jämfört med den närliggande versionen, så att det är lätt att upptäcka en plötslig minskning.

- **Automatic version** (Automatisk version): sparas åt dig medan andra redigerar, högst ungefär var tionde minut, när den sista personen lämnar tavlan och precis före en stor borttagning.
- **Named version** (Namngiven version): en version som du själv sparar med ett namn, till exempel ”Före workshopen”.
- **Before restore** (Före återställning) och **Restored a version** (Version återställd): sparas i samband med en återställning (se nedan).

Använd flikarna **All** (Alla) och **Named** (Namngivna) för att filtrera listan.

### Spara en namngiven version

1. Klicka på **Save version** (Spara version) längst upp i panelen.
2. Skriv ett namn (högst 80 tecken).
3. Klicka på **Save** (Spara).

Du kan också namnge en automatisk version: markera den och klicka på **Name** (Namnge) eller **Name this version** (Namnge den här versionen) i förhandsvisningen. Markera en namngiven version och klicka på **Rename** (Byt namn) för att ändra namnet. Om du inte har lagt till något på tavlan ännu står det ”Inget att spara ännu.”

## Förhandsvisa en version

1. Klicka på en version i listan eller använd piltangenterna och tryck på `Enter`.
2. Tavlan täcks av en skrivskyddad vy av versionen med en banderoll där det står **Viewing version** (Visar version).
3. Dra för att panorera, rulla för att zooma eller klicka på **Fit to content** (Anpassa till innehållet).
4. Klicka på **Back to current board** (Tillbaka till aktuell tavla) eller tryck på `Esc` för att lämna förhandsvisningen.

Förhandsvisningen ändrar inte tavlan. Den visar inte kommentarer, markörer eller markeringar. Kortkommandon påverkar inte tavlan medan du förhandsvisar.

## Återställa en version

1. Förhandsvisa versionen du vill återställa.
2. Banderollen beskriver vad en återställning skulle göra, till exempel ”Återställningen lägger till 4, ändrar 7 och tar bort 12 objekt”.
3. Klicka på **Restore this version** (Återställ den här versionen).
4. Bekräfta genom att klicka på **Restore** (Återställ) i rutan **Restore this version?** (Återställa den här versionen?).

Alla på tavlan ser ändringen. Ett meddelande visas: ”Versionen har återställts. Tryck på Ctrl+Z för att ångra.”

Det här händer:

- Tavlan som den ser ut nu sparas först som en version av typen **Before restore**, så att du alltid kan gå tillbaka till den från listan.
- Själva återställningen är en vanlig redigering. Tryck på `Ctrl+Z` (`Cmd+Z` på Mac) för att ångra allt i ett steg, i fliken där du gjorde återställningen. Det fungerar tills du läser in sidan igen; versionen **Before restore** sparas längre.
- Återställningen visas sedan i listan som **Restored a version**.

### Det här återställs inte

En återställning ändrar objekten på tavlan och tavlans inställningar, till exempel rutnätet. Följande påverkas inte:

- Tavlans namn.
- Den aktiva sessionen och eventuella omröstningar.
- Kommentarer. Nålar till objekt som kommer tillbaka fästs på dem igen, medan nålar till objekt som tas bort blir kvar på samma plats.
- Anteckningar som andra personer döljer för dig i ett steg för privat skrivande.

### När återställning inte är tillgänglig

Knappen **Restore this version** är inaktiv och visar orsaken när:

- En session pågår: ”Avsluta den pågående sessionen innan du återställer en version.”
- Du bara kan visa tavlan eller arbetsytan är skrivskyddad.
- Versionen skapades med en nyare version av Tabula än den du använder.

Om versionen motsvarar tavlan som den ser ut nu står det i banderollen: ”Den här versionen motsvarar tavlan som den ser ut nu.”

## Ta bort en version

Markera en version och klicka på **Delete** (Ta bort), och klicka sedan på **Confirm delete** (Bekräfta borttagning).

- Tavlans ägare kan ta bort alla versioner.
- Redigerare kan bara ta bort namngivna versioner som de själva har sparat.
- Ägare kan byta namn på alla namngivna versioner. Redigerare kan namnge en onamngiven version och byta namn på namngivna versioner som de själva har sparat.

Versionshistoriken behåller innehåll som personer har tagit bort från tavlan, även [bilder](images.md). Om något känsligt har funnits på tavlan tar du bort alla versioner där det finns kvar.

## Hur länge versioner sparas

- Automatiska versioner: alla i 24 timmar, sedan en per timme i upp till 7 dagar och därefter en per dag i upp till 30 dagar. Efter 30 dagar tas de bort.
- **Before restore** och **Restored a version**: 30 dagar.
- Namngivna versioner: tills du tar bort dem, högst 100 per tavla.

Varje tavla har också en lagringsgräns. Om en mycket aktiv tavla når gränsen tas de äldsta automatiska versionerna bort först. Den nyaste versionen sparas alltid.

## Vem kan använda funktionen

| Roll | Visa och förhandsvisa | Spara, namnge, återställa |
|---|---|---|
| Ägare | Ja | Ja |
| Redigerare | Ja | Ja |
| Kommentatör | Nej | Nej |
| Läsare | Nej | Nej |

I en arbetsyta utan inloggning kan alla använda funktionen. Se [Dela, roller och team](sharing.md).

## Relaterat

- [Exportera och importera](export-import.md): spara en kopia av tavlan som en fil.
- [Sessioner och fokusbegäranden](sessions.md)
- [Kommentarer](comments.md)
