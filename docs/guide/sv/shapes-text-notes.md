# Former, text och lappar

Verktygsfältet till vänster på en tavla innehåller allt du kan rita med. Den här sidan tar upp former, lappar, text, ritningar, ramar, ikoner, snabbåtgärdsfältet, låsning och lagerlistan.

## Verktygsfältet

Varje verktyg har ett kortkommando på en bokstav. Håll pekaren över en knapp eller flytta tangentbordsfokus till den för att se dess namn och kortkommando. I ett smalt fönster går det att rulla i verktygsfältet, och kanten tonas ut där fler verktyg fortsätter.

| Tangent | Verktyg |
|---|---|
| `V` | **Select** (Markera) |
| `H` | **Hand** (Panorera). Om du håller ned `Space` och drar panorerar du också. |
| `N` eller `S` | **Sticky note** (Lapp) |
| `T` | **Text** (Text) |
| `R` | Rektangel |
| `O` | Ellips |
| `D` | Diamant |
| `L` eller `X` | **Connector** (Kopplingslinje) (se [Kopplingslinjer](connectors.md)) |
| `P` | **Pen** (Penna) |
| `F` | **Frame** (Ram) |
| `C` | **Comment** (Kommentar) (se [Kommentarer](comments.md)) |

Kortkommandon fungerar inte medan du skriver i en textruta. `Esc` avmarkerar och går tillbaka till **Select**.

Under ritverktygen finns menyer för **UML** (UML), **Icons** (Ikoner), **Stickers** (Klistermärken) och **Templates and team exercises** (Mallar och teamövningar), plus knappar för att starta en punktröstning eller snabbomröstning samt **Undo** (Ångra) och **Redo** (Gör om).

Om du bara får visa en tavla är endast **Select** och **Hand** tillgängliga.

## Lappar

1. Tryck på `N` eller klicka på **Sticky note**.
2. Välj en färg i färgpaletten **Note colour** (Lappfärg) som visas bredvid verktygsfältet; på en telefon stängs färgpaletten när du väljer en färg så att den inte täcker tavlan, och du kan trycka på **Sticky note** igen för att byta färg.
3. Klicka på tavlan för att placera en lapp eller dra för att ange dess storlek.
4. Skriv. Tryck på `Esc` eller klicka någon annanstans för att bli klar.

Om du vill byta färg på en lapp senare markerar du den och använder färgrutan **Colour** (Färg) i snabbåtgärdsfältet. **Choose any colour** (Välj valfri färg) i slutet av färgrutorna öppnar en färgväljare.

## Former

Klicka på **Shapes** (Former) i verktygsfältet för att öppna formpanelen. Formerna är grupperade i **Basic** (Grundformer), **Arrows** (Pilar), **Callouts** (Pratbubblor) och **Flowchart** (Flödesschema).

- Skriv i **Search shapes** (Sök efter former) för att filtrera efter namn.
- Klicka på en form och klicka sedan på tavlan för att placera den i standardstorlek, eller dra för att ange storleken. Formverktyget växlar sedan tillbaka till **Select**, så att du genast kan skriva i den nya formen.
- Du kan också dra en form från panelen till tavlan.

Med `R`, `O` och `D` hoppar du över panelen och ritar en rektangel, ellips eller diamant.

Panelen har också **Kanban** (Kanban) under **Boards** (Tavlor). Det placerar en tavla med kolumner och kort. Se [Kanbantavlor](kanban.md).

Om du vill ändra formen på ett befintligt objekt markerar du det och använder knappen **Shape** (Form) i snabbåtgärdsfältet.

## Text

Tryck på `T` och klicka eller dra på tavlan för att lägga till en textruta. Du kan också dubbelklicka på en tom del av tavelytan medan **Select** är aktivt för att skapa en.

Om du vill redigera text i en form, lapp, kopplingslinje eller ramrubrik dubbelklickar du på den eller markerar den och trycker på `Enter`. Medan du redigerar gäller följande:

- `Esc` eller `Ctrl+Enter` (`Cmd+Enter` på Mac) avslutar redigeringen.
- `Tab` avslutar redigeringen.
- I former, lappar och textrutor skapar `Enter` en ny rad. I ramnamn och kopplingslinjeetiketter avslutar `Enter` redigeringen.
- Välj **Add emoji** (Lägg till emoji) i det lilla fältet bredvid textrutan för att öppna emojiväljaren: skriv för att söka, använd piltangenterna eller tryck för att välja en emoji, så infogas den vid markören. Senast använda emoji visas först. Emoji som består av flera delar, till exempel flaggor och familjer, hålls ihop när en rad bryts och exporteras som en hel emoji i PNG- och Markdown-filer och visas så för alla andra på tavlan.

### Justering

![Textmenyn med Align (Justera), Vertical (Lodrät) och Text colour (Textfärg)](images/text-options.png)

I snabbåtgärdsfältet ställer **Text** in vågrät justering (vänster, mitten, höger) och textfärg. För former och lappar ställer det också in **Vertical** justering: överst, i mitten eller nederst.

### Teckensnitt

Öppna egenskapspanelen (se nedan) och använd **Font** (Teckensnitt). Teckensnittslistan har ett sökfält (**Search Fontshare fonts** (Sök Fontshare-teckensnitt)) som hittar namn och stilord, till exempel ”serif”. Exakta namn visas först, följt av kategorifilter och ett avsnitt med teckensnitt som redan används på tavlan. Håll pekaren över ett teckensnitt för att förhandsvisa det på markeringen. Klicka för att behålla det eller tryck på `Esc` för att återställa det tidigare teckensnittet. Du kan också ställa in **Size** (Storlek) och **Weight** (Vikt) där. Storleken ändras med 1 med piltangenterna eller mushjulet och med 10 när du håller ned `Shift`.

Rubrik- och brödtextteckensnitt för nya objekt på hela tavlan ställs in under **Board settings** (Tavleinställningar) i tavlans meny.

## Rita, ramar och ikoner

- **Pen** (`P`): dra för att rita på fri hand. När pennan är aktiv visas en färgpalett med tre linjebredder.
- **Frame** (`F`): dra för att rita ett område med rubrik. Objekt som helt ligger inuti en ny ram blir dess underordnade objekt och flyttas med den. Dubbelklicka på en ram för att byta namn på den. För att ange ramens storlek markerar du den och öppnar egenskaperna (**More properties**, fler egenskaper): menyn **Size** (Storlek) har Screen (skärm: 1920 × 1080, 1440 × 900, 1280 × 800), Tablet (surfplatta: 1024 × 768 och 768 × 1024), Phone (mobil: 390 × 844), Paper (papper: A3, A4 och Letter, stående och liggande) och Square (kvadrat: 1000 × 1000). Fälten **Width** (Bredd) och **Height** (Höjd) anger vilken annan storlek som helst, och menyn visar då Custom (anpassad).
- **Icons**: öppna menyn **Icons** och skriv i **Search icons** (Sök efter ikoner). Sökningen omfattar alla ikonuppsättningar eller den valda uppsättningen i listan (**All icon sets** (Alla ikonuppsättningar) som standard) och söker bland namn, alias och kategorier. Klicka på en ikon för att lägga till den eller dra den till tavlan. Varje klick placerar ikonen 24 pixlar åt höger och ned från den föregående ikonen så att de inte hamnar ovanpå varandra, och stegen börjar om från vyområdets mittpunkt när du flyttar vyn ett steg eller flyttar eller tar bort den senast placerade ikonen. Ändra ikonens färg i egenskapspanelen.
- **Ikoner utan anslutning**: när **All icon sets** är valt innehåller raden **Popular icon sets (N)** (Populära ikonuppsättningar (N)) alternativet **Download for offline** (Ladda ned för offlineanvändning). När en uppsättning är vald visas i stället uppsättningens namn på raden. Nedladdade uppsättningar kan sökas och förhandsvisas utan anslutning; **Update** (Uppdatera) och **Remove** (Ta bort) fungerar som för klistermärken (se [Klistermärken](stickers.md)). Ikoner som redan finns på tavlan ligger kvar.
- **Online sets** (Uppkopplade uppsättningar): den här knappen i ikonmenyn hämtar fler uppsättningar från Iconify. De uppsättningarna går inte att ladda ned, kräver en anslutning och varje sökning skickar din fråga till Iconify.
- **UML** (UML): menyn **UML** innehåller klasser, aktörer, livslinjer och andra UML-element samt kopplingslinjer för relationer. Se [Kopplingslinjer](connectors.md#uml-relationer).
- **Import Mermaid** (Importera Mermaid): se [Exportera och importera](export-import.md).

Se [Klistermärken](stickers.md) för emoji.

## Snabbåtgärdsfältet

Markera något så visas ett litet fält ovanför det (nedanför om det annars skulle täcka en kopplingslinje). Fältet visar bara de kontroller som gäller för markeringen.

På en telefon är fältet så brett som skärmen tillåter och går att rulla i sidled om det innehåller fler kontroller än vad som får plats.

![Snabbåtgärdsfältet ovanför en markerad ellips](images/quick-actions.png)

- **Colour**: färg på lappen.
- **Shape**: ändra formtyp.
- **Fill** (Fyllning) och **Line** (Linje): färg på fyllning och kontur.
- **Route** (Linjetyp): för kopplingslinjer, **Straight** (Rak), **Elbow** (Rätvinklig) eller **Curved** (Böjd).
- **Text**: justering och textfärg.
- **Align**: när du har markerat minst två objekt kan du justera kanter och mittpunkter. Med minst tre objekt kan du också fördela dem vågrätt eller lodrätt.
- **React with a sticker** (Reagera med ett klistermärke): se [Klistermärken](stickers.md).
- **Lock** (Lås) / **Unlock** (Lås upp).
- **Duplicate** (Duplicera) (`Ctrl+D`, `Cmd+D` på Mac).
- **Delete** (Ta bort) (`Del`).
- **More properties** (Fler egenskaper): öppnar egenskapspanelen.

I ett smalt fönster (860 pixlar brett eller mindre) börjar fältet till höger om verktygsfältet i stället för att täcka det, och det går att rulla i sidled om fältet är bredare än utrymmet.

## Egenskapspanelen

**More properties** öppnar en panel vid sidan med objekttypen som rubrik. Beroende på markeringen innehåller den: form- eller klasstyp, fill, line colour, **Width** (Bredd) (1 till 6 px), **Style** (Stil) (heldragen, streckad, prickad), font, size, weight, alignment, text colour, **Opacity** (Opacitet), align and distribute, bring to front (`]`), bring forward (`Ctrl+]`), send backward (`Ctrl+[`), send to back (`[`), duplicate, lock, **Copy as Mermaid** (Kopiera som Mermaid) och delete. När du ändrar ordningen med flera markerade objekt behåller de sin inbördes ordning. Om flera markerade objekt skiljer sig åt visas ett fält som blandat tills du ändrar det. På en telefon har panelen en fällknapp som fäller ihop den till rubrikraden, så att du kan se tavlan ovanför.

## Markera, flytta och gruppera

- Klicka för att markera. `Shift`+klick lägger till eller tar bort ett objekt. Dra på en tom del av tavlan för att markera med en ruta.
- `Ctrl+A` markerar allt som inte är låst.
- Dra för att flytta. Piltangenterna flyttar objektet en pixel; med `Shift` flyttas det ett rutnätssteg.
- Markera en textruta och dra i ett handtag på vänster eller höger sida för att ändra bredden som texten radbryts vid; rutan blir högre eller lägre så att raderna får plats. Dra i ett hörnhandtag för att göra texten större eller mindre: bredden skalar med texten, så radbrytningarna förblir desamma. På en pekskärm är handtagen större. Med tangentbordet ändrar `Alt`+`Shift`+`Left` eller `Right` bredden och `Alt`+`Shift`+`Up` eller `Down` storleken.
- Håll ned `Alt` medan du drar för att ignorera rutnätet och [smarta hjälplinjer](smart-guides.md).
- Justeringslinjer och avståndsmarkörer visas medan du flyttar eller ändrar storlek; se [Smarta hjälplinjer](smart-guides.md).
- Håll ned `Shift` medan du ändrar storlek för att behålla proportionerna.
- Högerklicka på ett objekt (eller en markering) för att öppna en meny med **Bring to front** (Flytta längst fram), **Bring forward** (Flytta framåt), **Send backward** (Flytta bakåt), **Send to back** (Flytta längst bak), **Flip horizontal** (Vänd vågrätt), **Flip vertical** (Vänd lodrätt), **Duplicate**, **Lock**, **Unlock** och **Delete**. Bring forward och Send backward flyttar markeringen ett steg förbi det närmaste objektet som den överlappar, inte längst fram eller längst bak.
- Vänd en markering med `Shift+H` (vågrätt) eller `Shift+V` (lodrätt), från högerklicksmenyn eller från menyn med fler åtgärder i snabbåtgärdsfältet. Former, ikoner, klistermärken, bilder, linjer och UML-former speglas runt markeringens mitt. Text speglas aldrig och förblir läsbar, och kopplingslinjer sitter kvar på de synliga sidorna. Vändning är avstängd för en markering som inte kan speglas, och orsaken visas. På ett tvåsidigt kort heter åtgärden för att se andra sidan **Turn over** (Vänd kortet), inte Flip.
- Kopiera och klistra in med `Ctrl+C` och `Ctrl+V`. Om du klistrar in vanlig text skapas ett textobjekt där radbrytningarna bevaras. Lång text radbryts vid en bestämd bredd.

Om du vill hålla ihop objekt placerar du dem i en **Frame** (när du flyttar ramen flyttas innehållet med den) eller skapar en **grupp**.

### Grupper

En grupp samlar objekt så att du kan markera dem som ett enda. Gruppen har ingen egen bild.

- Markera minst två objekt och tryck på `Ctrl+G` (`Cmd+G` på Mac), eller välj **Group** (Gruppera) i snabbåtgärdsfältet. `Shift+Ctrl+G` (`Shift+Cmd+G`) eller **Ungroup** (Dela upp grupp) delar upp gruppen igen. Båda åtgärderna utgör ett steg i ångra-historiken. Ramar går inte att gruppera, och ett meddelande säger till om du utelämnar en ram.
- Kopplingslinjer med båda ändarna i markeringen läggs till i gruppen.
- Klicka på ett objekt i en grupp för att markera hela gruppen. Om du drar en ruta över en del av en grupp markeras också hela gruppen.
- **Dubbelklicka** på ett objekt för att gå in i gruppen. Resten av tavlan tonas ned, gruppen får en streckad kontur och sitt namn, och du kan markera, redigera och flytta objekten inuti den. Tryck på `Esc`, klicka på **Done** (Klart) eller klicka på en tom del av tavlan för att avsluta. Grupper kan innehålla grupper. `Esc` går ut en nivå i taget och **Ungroup** delar bara upp den yttersta gruppen.
- Om du väljer en färg eller en annan stil för en grupp ändras alla objekt i den som har den egenskapen.
- På en telefon använder du knapparna **Group** och **Ungroup** i snabbåtgärdsfältet eller håller fingret på ett markerat objekt eller en grupp för att öppna en meny med dem, även när Kommentarer eller Chatt är öppna. Menyn öppnas en bit från fingret och går att rulla om den är lång, och när du lyfter fingret väljs inget i menyn. Dubbeltryck för att gå in; **Done**-brickan lämnar gruppen. Gruppens namn och **Done**-brickor döljs när Kommentarer, Chatt eller en panel är öppen och visas igen när den stängs. Ångra och Gör om finns kvar längst ned i verktygsfältet.
- Under en punktröstning får objektet du klickar på en punkt, inte dess grupp, och dubbelklick på ett objekt räknar fortfarande dess röster utan att du går in i gruppen.

Om du tar bort eller klipper ut en grupp tas gruppen och allt i den bort i ett steg. Lappar vars privata skrivande är dolt för dig bevaras och flyttas ut ur gruppen i stället. En grupp försvinner också om dess sista objekt tas bort.

Kopiera, klippa ut, duplicera och klistra in håller ihop en grupp, även grupper inuti grupper. Vissa åtgärder fungerar ännu inte på en hel grupp: flytta, ändra storlek och rotera. Gå in i gruppen för att flytta eller redigera dess objekt tills vidare.

Du kan låsa en markerad grupp med **Lock**. En låst grupp släpper igenom klick, tryck och markeringsrutor, precis som alla låsta objekt. Håll länge för att låsa upp den yttersta låsta gruppen.

## Låsa

Lås ett objekt så att det inte är i vägen.

1. Markera objektet och klicka på **Lock** i snabbåtgärdsfältet.
2. Markeringen försvinner och ett meddelande visas: ”Låst. Håll fingret länge för att låsa upp.”

![Den lilla låsbrickan på en låst ellips](images/locked-badge.png)

Låsta objekt fungerar som bakgrund: klick och markeringsrutor passerar över dem, **Select All** (Markera alla) hoppar över dem och du kan inte redigera dem eller fästa kopplingslinjer i dem. Om du håller pekaren över ett låst objekt visas en liten låsbricka.

Lås upp genom att hålla fingret på objektet i 0,6 sekunder. En ring fylls, sedan låses objektet upp och markeras. Punktröstning fungerar fortfarande på låsta lappar.

## Lager

**Layers** (Lager) i verktygsfältet (eller `Alt+L` eller **Layers** i tavlans meny) visar allt på tavlan med objektet som ligger överst först. Ramar visas sist eftersom de alltid ligger bakom allt annat, och objekten inuti en ram visas under den; klicka på triangeln för att fälla ihop ramen.

- Klicka på ett objekt för att markera det på tavlan och håll ned `Shift`, `Ctrl` eller `Cmd` för att lägga till eller ta bort objekt.
- Dra ett objekt uppåt eller nedåt för att placera det ovanför eller nedanför ett annat objekt intill det. På en telefon drar du det i handtaget till höger. Med tangentbordet flyttar `Alt+Up` och `Alt+Down` det fokuserade objektet en plats.
- Dubbelklicka på ett namn eller tryck på `F2` för att byta namn på ett objekt. Namnet visas bara i listan, utom för en ram, där det är ramens rubrik. Ett objekt utan namn visas med sina första ord eller med en beskrivning av vad det är.
- Ögat döljer ett objekt och låset låser det (`H` och `L` på det fokuserade objektet).

Ett **dolt** objekt döljs för alla på tavlan, inte bara för dig: det ritas inte ut, går inte att klicka på eller markera och tas inte med i PNG- eller SVG-exporter eller i sessionssammanfattningen. Kopplingslinjer till ett dolt objekt och allt inuti en dold ram döljs också. **Att dölja är inte privat**: objektet finns fortfarande på tavlan, alla som kan redigera kan visa det igen från listan, och det finns kvar i tavelfiler (`.drift`) och JSON-exporter. Panelens rubrik visar hur många objekt som är dolda. Läsare och kommentatörer ser listan, men kan inte ändra något i den.

## Punktröstning

Knappen **Start a dot vote (no limit)** (Starta punktröstning (utan gräns)) i verktygsfältet startar en omröstning. Klicka på en lapp för att lägga till din punkt. `Shift`+klick tar bort en punkt. Med fältet längst ned kan du ställa in hur många punkter varje person får. Mer information finns i [Sessioner](sessions.md).

## Relaterat

- [Kopplingslinjer](connectors.md)
- [Klistermärken](stickers.md)
- [Kommentarer](comments.md)
- [Exportera och importera](export-import.md)
