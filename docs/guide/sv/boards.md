# Tavlor och startsidan

Sidan **Boards** (Tavlor) listar dina tavlor, och här skapar, öppnar, importerar och tar du bort dem. Sidan ser lite annorlunda ut när din arbetsyta använder inloggning.

## Sidan Boards

I det övre fältet finns Tabulas ordmärke (klicka på det för att komma tillbaka hit) och länkarna **Boards** och **Templates** (Mallar). Om din arbetsyta använder inloggning visas även ditt namn, som är kontomenyn: ditt namn och din färg, **AI tool access** (om administratören har aktiverat AI-verktyg), **Your AI key** (om du får använda din egen), chattaviseringar och **Sign out** (Logga ut). Arbetsytans ägare och administratörer ser också **Admin** (Administratör), och arbetsytor som har spåraren visar en länk **Tracker**.

Under det övre fältet:

- **New board** (Ny tavla) skapar en tom tavla och öppnar den.
- **Import file** (Importera fil) skapar en tavla från en `.drift`- eller `.json`-fil. Se [Exportera och importera](export-import.md).
- **Search boards** (Sök bland tavlor) filtrerar listan efter titel medan du skriver.
- En rad med **Start from a template** (Börja med en mall) och upp till fyra mallar, med dina egna sparade mallar först och länken **All templates** (Alla mallar). Se [Mallar](templates.md).

![Sidan Boards för en inloggad medlem: ett avsnitt för teamet Design, Personal (Personligt) och Shared with you (Delat med dig) med en tavla som bara går att visa, följt av mallraden](images/teams-home.png)

## Öppet läge

Om din arbetsyta inte har inloggning visas en tabell, **Your boards** (Dina tavlor), med varje tavlas namn och när den senast redigerades. Tavlorna lagras i den här webbläsaren. En tavla som du inte har skapat visas här när du har öppnat dess länk en gång.

Klicka på tavlans namn för att öppna den. En tavla som någon delat via en länk har samma adress i webbläsaren, så du kan också bokmärka den.

## Arbetsytor med inloggning

När din arbetsyta använder inloggning grupperas tavlorna:

- Ett avsnitt för varje team du tillhör, med en bricka som visar om du är **Admin** eller **Member** (Medlem) i teamet. **Manage** (Hantera) öppnar teamets inställningar, och **New board** i avsnittet skapar en tavla för teamet.
- **Personal** innehåller tavlor som du äger och som inte tillhör något team.
- **Shared with you** innehåller tavlor som andra har delat med dig. För ägare och administratörer heter avsnittet **Other boards** (Andra tavlor).
- **On this device** (På den här enheten) visar tavlor som bara lagras i den här webbläsaren. **Add to workspace** (Lägg till i arbetsytan) flyttar en tavla till Personligt eller till ett team, så att andra kommer åt den.

Tabellen har kolumnen **Access** (Åtkomst). En bricka visas bara när din åtkomst är begränsad: **View only** (Endast visning) eller **Can comment** (Kan kommentera). Utan bricka kan du redigera.

Ägare och administratörer ser också knapparna **Members** (Medlemmar) och **New team** (Nytt team). Andra personer, förutom gäster, ser **New team**. Information om team och roller finns i [Dela, roller och team](sharing.md).

Om din arbetsyta har ett banderollmeddelande visas det allra högst upp. Om det inte går att nå servern visas meddelandet **You are offline. Showing the last list from this device.** (Du är offline. Visar den senaste listan från den här enheten.) och knappar som behöver servern inaktiveras.

## Öppna en tavla

Klicka på tavlans namn i listan. Du kan också klistra in en tavellänk i adressfältet. I en arbetsyta med inloggning behöver du åtkomst till tavlan för att länken ska fungera.

Gå tillbaka genom att välja knappen **All boards** (Alla tavlor) med husikonen längst upp till vänster på tavlan.

## Byt namn på en tavla

Klicka på tavlans namn längst upp till vänster på en öppen tavla, skriv det nya namnet och tryck på `Enter`. Ett tomt namn blir **Untitled board** (Namnlös tavla). På en tavla som du bara kan visa är namnet låst. När du börjar med en mall får tavlan mallens namn, men du kan byta namn på den.

## Ta bort en tavla

Välj papperskorgsikonen i slutet av tavlans rad och bekräfta sedan med **Delete board** (Ta bort tavla).

- I öppet läge och för tavlor under **On this device** tas tavlan bara bort från den här enheten. Kopior på en synkroniseringsserver eller på andras enheter finns kvar.
- I en arbetsyta med inloggning ser bara tavlans ägare knappen för att ta bort den. När du tar bort tavlan försvinner den för alla som har åtkomst. En administratör för arbetsytan kan återställa den. Se [Administrationspanelen](admin.md).

## Inställningar för tavlan

På en öppen tavla väljer du **Menu** (Meny) och sedan **Board settings** (Tavlinställningar). De här inställningarna är inte tillgängliga på tavlor som bara går att visa.

- **Grid** (Rutnät). Välj **Dots** (Punkter), **Lines** (Linjer), **Isometric** (Isometriskt) eller **None** (Inget).
- **Grid size** (Rutnätsstorlek). 8, 12, 16, 20, 24, 32, 40 eller 48.
- **Snap to grid** (Fäst mot rutnät). När funktionen är på fäster förflyttning och storleksändring mot rutnätet. Håll `Alt` medan du drar för att ignorera rutnätet under en förflyttning. Fästningen är i praktiken av när rutnätet är **None**.
- **Heading font** (Typsnitt för rubriker) och **Body font** (Typsnitt för brödtext). Används för nya lappar, former och ramar.
- **Relay** (Relä). Synkroniseringsserverns adress. **auto** (automatiskt) använder servern som levererar appen, och **off** (av) håller tavlan bara på den här enheten. Om du ändrar inställningen läses tavlan in igen. Ändra den bara om administratören har bett dig göra det.

De här inställningarna hör till tavlan och delas med alla som använder den.

## Tavlans meny

Knappen **Menu** längst upp till höger har följande avsnitt:

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
