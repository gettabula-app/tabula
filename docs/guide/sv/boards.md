# Tavlor och startsidan

Sidan **Boards** (Tavlor) listar dina tavlor, och här skapar, öppnar, importerar och tar du bort dem. Sidan ser lite annorlunda ut när din arbetsyta använder inloggning.

## Sidan Boards

I det övre fältet finns Tabulas ordmärke (klicka på det för att komma tillbaka hit) och länken **Boards** (Tavlor). Om din arbetsyta använder inloggning visas även ditt namn, som är kontomenyn: ditt namn och din färg, **My templates** (Mina mallar), **AI tool access** (om administratören har aktiverat AI-verktyg), **Your AI key** (om du får använda din egen), chattaviseringar och **Sign out** (Logga ut). Arbetsytans ägare och administratörer ser också **Admin** (Administratör), och arbetsytor som har spåraren visar en länk **Tracker**.

Under det övre fältet:

- **New board** (Ny tavla) öppnar en meny. **Blank board** (Tom tavla) skapar en tom tavla och öppnar den, **From a template…** (Från en mall…) öppnar sidan Mallar och **Import a file…** (Importera en fil…) skapar en tavla från en `.drift`- eller `.json`-fil. Se [Exportera och importera](export-import.md).
- **Search boards** (Sök bland tavlor) filtrerar listan efter titel medan du skriver.
- I en arbetsyta med inloggning visas tavlorna som kort, med en omkopplare för **Cards | List** (Kort | Lista) och en omkopplare för **Show pictures** (Visa bilder). Se [Arbetsytor med inloggning](#arbetsytor-med-inloggning). Så länge du inte har några tavlor hjälper mallkort dig att komma igång: se [Första gången](#första-gången).

![Sidan Boards för en inloggad medlem: ett avsnitt för teamet Design, Personal (Personligt) och Shared with you (Delat med dig) med en tavla som bara går att visa](images/teams-home.png)

## Öppet läge

Om din arbetsyta inte har inloggning visas en tabell, **Your boards** (Dina tavlor), med varje tavlas namn och när den senast redigerades. Tavlorna lagras i den här webbläsaren. En tavla som du inte har skapat visas här när du har öppnat dess länk en gång.

Klicka på tavlans namn för att öppna den. En tavla som någon delat via en länk har samma adress i webbläsaren, så du kan också bokmärka den.

Öppet läge har inga konton, så alla som når servern kan öppna dess tavlor. Använd det bara på din egen dator eller i ett nätverk du litar på. För allt som delas bredare slår du på inloggning; servern varnar vid start när öppet läge lyssnar på en nätverksadress.

## Arbetsytor med inloggning

När din arbetsyta använder inloggning grupperas tavlorna:

- Ett avsnitt för varje team du tillhör, med en bricka som visar om du är **Admin** eller **Member** (Medlem) i teamet. **Manage** (Hantera) öppnar teamets inställningar, och **New board** i avsnittet skapar en tavla för teamet.
- **Personal** innehåller tavlor som du äger och som inte tillhör något team.
- **Shared with you** innehåller tavlor som andra har delat med dig. För ägare och administratörer heter avsnittet **Other boards** (Andra tavlor).
- **On this device** (På den här enheten) visar tavlor som bara lagras i den här webbläsaren. **Add to workspace** (Lägg till i arbetsytan) flyttar en tavla till Personligt eller till ett team, så att andra kommer åt den.

Ägare och administratörer ser också knapparna **Members** (Medlemmar) och **New team** (Nytt team). Andra personer, förutom gäster, ser **New team**. På en smal skärm ligger **New team** och **Members** bakom knappen **More actions** (Fler åtgärder), som visas som tre punkter. Information om team och roller finns i [Dela, roller och team](sharing.md).

Om din arbetsyta har ett banderollmeddelande visas det allra högst upp. Om det inte går att nå servern visas meddelandet **You are offline. Showing the last list from this device.** (Du är offline. Visar den senaste listan från den här enheten.) och knappar som behöver servern inaktiveras.

### Kort och lista

Varje tavla är ett kort. Överst växlar **Cards | List** mellan ett rutnät med kort och en lista med en rad per tavla. **Show pictures** slår på eller av bilderna på korten. Båda valen sparas på den här enheten.

Ett kort visar:

- En bild av tavlan, eller en enkel ruta när det inte finns någon. En tavla som ännu saknar innehåll visar **Empty board** (Tom tavla) under namnet.
- Tavlans namn, som öppnar den, och en rad under: vem som redigerade den sist och när (”Lin · 12 min ago”; ett AI-verktyg märks med ”(agent)”), eller ”Edited 3 Oct” när servern inte anger vem, eller ”On this device”.
- Vilka som är här nu (se nedan).
- En bricka när din åtkomst är begränsad: **View only** (Endast visning) eller **Can comment** (Kan kommentera). Utan bricka kan du redigera.
- På bilden ett litet tal för de olästa chattmeddelandena i tavlan, markerat när någon har nämnt dig. Det visas bara när chatten är på.
- En meny med **More actions** (tre punkter). Alla kan välja **Open** (Öppna). De som kan redigera kan också välja **Rename** (Byt namn) och **Duplicate** (Duplicera), och ägaren kan också välja **Delete** (Ta bort). En tavla som bara finns på den här enheten erbjuder **Open**, **Add to workspace** och **Delete**.

I listvyn är varje tavla en rad med sitt namn och kolumnerna **Here now** (Här nu), **Edited** (Ändrad) och **Access** (Åtkomst). På en smal skärm utelämnas de extra kolumnerna.

**Here now** visar vem som har tavlan öppen just nu, för tavlor du kan öppna:

- Varje annan person är en liten ruta med sin initial och markörfärg. De tre första personerna visas, sedan **+N** för resten. Personerna visas i den ordning de kom.
- Om du också har tavlan öppen i en annan flik följer en ruta **You** (Du) efter de andra. När ingen annan är där syns inget: din egen närvaro ensam visar ingenting, och inte heller en nolla.
- Peka på rutorna för att se allas namn. Personer som anslöt med en anslutningskod är markerade med **(guest)**.
- Skärmläsare läser upp det som ”Here now: AB, CD, and 3 more”: initialerna för de tre första personerna och sedan hur många fler det är.
- När någon lämnar finns rutan kvar i ungefär tre sekunder, så att en kort återanslutning inte får den att flimra.
- Du ser bara personer på tavlor du kan öppna. AI-verktyg visas aldrig. Personer som anslöt med en anslutningskod ser inte detta.
- Den uppdateras direkt via chattanslutningen. Om chatten är avstängd på din server kontrollerar sidan igen var 15:e sekund.

### Bilder på kort

Bilden är en liten kopia av det som finns på tavlan, och den görs av webbläsaren hos någon som kan redigera tavlan. När en ägare eller någon som kan redigera har tavlan öppen och ändrar den, ritar webbläsaren bilden och skickar den till servern, efter att varje bild på tavlan har krympts till högst 480 pixlar. Personer som bara kan visa eller kommentera skapar aldrig någon bild. Tills en tavla har en bild visar kortet en ritad kontur av tavlan, eller en enkel ruta när tavlan är tom.

Alla som kan se en tavlas kort ser dess bild. Den visar det som finns på tavlan, så en tavla vars innehåll ska hållas dolt bör inte visa någon bild:

- **Show pictures** överst på sidan döljer alla bilder för dig, på den här enheten.
- Tavlans ägare och en administratör för arbetsytan kan öppna tavlans meny och stänga av **Show a picture on the card** (Visa en bild på kortet). Då visar kortet en enkel ruta, och den bild som sparats för tavlan tas bort. Ingen annan ser omkopplaren.
- En administratör för arbetsytan kan stänga av tavlornas bilder för hela arbetsytan i **Admin**, under **Privacy** (Integritet). Den som kör din Tabula-server kan också stänga av dem för hela servern; serverns egen dokumentation beskriver hur.

### Första gången

När du inte har några tavlor visar sidan **No boards yet** (Inga tavlor än) och erbjuder **New board**. I en arbetsyta med inloggning visas också **Start your first board** (Starta din första tavla): kort för de inbyggda mallarna och ett kort för **Blank board**. Välj ett kort för att öppna en ny tavla utifrån det. **Skip, start with a blank board** (Hoppa över, börja med en tom tavla) öppnar en tom tavla, och **Hide** (Dölj) tar bort förslagen på den här enheten. De försvinner av sig själva när du har en tavla.

Ett team utan tavlor visar **No boards in** teamets namn **yet** (Inga tavlor i teamets namn än), med **New board** för dem som får lägga till tavlor där, och i avsnittet **Shared with you** visas **No boards shared with you yet** (Inga tavlor delade med dig än).

## Aviseringar

I arbetsytor med inloggning sitter en klocka i det övre fältet på sidan Boards, bredvid ditt namn. En bricka på klockan räknar det som inte har lästs än. Den får en röd kontur när någon har nämnt dig. Öppna klockan för att se listan, nyaste först:

- **Chattomnämnanden**: någon nämnde dig i en tavel-, team- eller arbetsytechatt.
- **Svar**: någon svarade på en kommentar av dig.
- **Delningar**: någon delade en tavla direkt med dig.
- **Kort**: ett kort som du äger förfaller i morgon, förfaller i dag eller är försenat, eller någon tilldelade dig ett kort. Om du väljer raden öppnas tavlan.
- **Teamanslutningar**: någon du bjöd in gick med i teamet, också när personen loggade in via din inbjudningslänk.
- **Spåraren**: ärenden som tilldelats dig, kommenterats och flyttats, om din arbetsyta har spåraren.

Varje rad säger vem, vad och var, med de första orden i ett meddelande eller en kommentar, och när. Välj en rad för att gå dit. Välj bocken på en rad, eller **Mark all as read** (Markera alla som lästa), för att markera som läst. Att läsa en chatt rensar dess omnämnanden. **All** (Alla) och **Mentions** (Omnämnanden) filtrerar listan, **Show older** (Visa äldre) läser in fler, och listan går 90 dagar tillbaka. **Notification settings** (Aviseringsinställningar) har reglage för vad som visas här (omnämnanden, svar, kort och delningar) och för chattmejlet, och kan skicka ett mejl om dagen med vad som är nytt i dina aviseringar (avstängt tills du slår på det).

Ett objekt försvinner från listan, och från räkningen, när du inte längre kan öppna det det pekar på, till exempel när en tavla inte längre delas med dig. Räkningen uppdateras direkt medan chatten är på, och varje minut när chatten är av. I öppet läge, utan inloggning, finns ingen klocka.

## Öppna en tavla

Klicka på tavlans namn i listan. Du kan också klistra in en tavellänk i adressfältet. I en arbetsyta med inloggning behöver du åtkomst till tavlan för att länken ska fungera.

Gå tillbaka genom att välja knappen **All boards** (Alla tavlor) med husikonen längst upp till vänster på tavlan.

## Byt namn på en tavla

Klicka på tavlans namn längst upp till vänster på en öppen tavla, skriv det nya namnet och tryck på `Enter`. Ett tomt namn blir **Untitled board** (Namnlös tavla). På en tavla som du bara kan visa är namnet låst. När du börjar med en mall får tavlan mallens namn, men du kan byta namn på den.

## Ta bort en tavla

I en arbetsyta med inloggning öppnar du menyn **More actions** (tre punkter) på tavlans kort eller rad och väljer **Delete**. I öppet läge väljer du papperskorgsikonen i slutet av tavlans rad. Bekräfta sedan med **Delete board** (Ta bort tavla).

- I öppet läge och för tavlor under **On this device** tas tavlan bara bort från den här enheten. Kopior på en synkroniseringsserver eller på andras enheter finns kvar.
- I en arbetsyta med inloggning erbjuds bara tavlans ägare **Delete**. När du tar bort tavlan försvinner den för alla som har åtkomst. En administratör för arbetsytan kan återställa den. Se [Administrationspanelen](admin.md).

## Inställningar för tavlan

På en öppen tavla väljer du **Menu** (Meny) och sedan **Board settings** (Tavlinställningar). De här inställningarna är inte tillgängliga på tavlor som bara går att visa.

- **Grid** (Rutnät). Välj **Dots** (Punkter), **Lines** (Linjer), **Isometric** (Isometriskt) eller **None** (Inget).
- **Grid size** (Rutnätsstorlek). 8, 12, 16, 20, 24, 32, 40 eller 48.
- **Snap to grid** (Fäst mot rutnät). När funktionen är på fäster förflyttning och storleksändring mot rutnätet. Håll `Alt` medan du drar för att ignorera rutnätet under en förflyttning. Fästningen är i praktiken av när rutnätet är **None**.
- **Heading font** (Typsnitt för rubriker) och **Body font** (Typsnitt för brödtext). Används för nya lappar, former och ramar.
- **Relay** (Relä). Synkroniseringsserverns adress. **auto** (automatiskt) använder servern som levererar appen, och **off** (av) håller tavlan bara på den här enheten. Om du ändrar inställningen läses tavlan in igen. Ändra den bara om administratören har bett dig göra det.

De här inställningarna hör till tavlan och delas med alla som använder den.

## Tavlans meny

Knappen **Menu** (Meny) längst upp till höger har följande avsnitt. Skriv i **Search actions** (Sök åtgärder) överst i menyn (eller tryck på `/` när menyn är öppen) för att hitta en åtgärd med namn. **Appearance** (Utseende) och **Export** (Exportera) öppnas som undermenyer bredvid menyn:

- **Account** (Konto) i arbetsytor med inloggning: ditt namn och din e-postadress, **Sign out**, **Sign out everywhere** (Logga ut överallt) och **Admin** för ägare och administratörer. Om administratören har aktiverat AI-verktyg visas även **AI tool access** (Åtkomst till AI-verktyg). Om du får använda din egen AI-nyckel visas även **Your AI key** (Din AI-nyckel). Se [Åtkomsttoken och AI-verktyg](ai-tools.md) och [Din AI-nyckel](ai-keys.md).
- **Board** (Tavla): **Board settings**, **Save board as template** (Spara tavlan som mall) ([Mallar](templates.md)), **Version history** (Versionshistorik) ([Versionshistorik](version-history.md)), **Your name and colour** (Ditt namn och din färg), **Show comments** (Visa kommentarer) ([Kommentarer](comments.md)), **Import a board file into this board** (Importera en tavelfil till den här tavlan) och **Import Mermaid** (Importera Mermaid).
- **Appearance** (Utseende): färgteman. Se [Teman](themes.md).
- **Export** (Exportera) (eller **Export selection** (Exportera markering) när något är markerat): PNG, SVG, tavelfil, JSON, Markdown-sammanfattning och **Copy as Mermaid** (Kopiera som Mermaid). Se [Exportera och importera](export-import.md).
- **Help** (Hjälp): **Keyboard shortcuts** (Kortkommandon).

Alternativ som ändrar tavlan är gråtonade när du bara kan visa den.

## Relaterat

- [Kom igång](getting-started.md)
- [Mallar](templates.md)
- [Dela, roller och team](sharing.md)
- [Versionshistorik](version-history.md)
