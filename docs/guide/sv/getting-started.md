# Kom igång

Tabula är en gemensam whiteboard. Du placerar lappar, former, text och ritningar på en obegränsad tavelyta, och alla som har tavlan öppen ser ändringarna direkt. Den här sidan tar upp grunderna: öppna en tavla, hitta rätt och använda kortkommandon.

## Öppna appen

Öppna adressen till din Tabula-server i en webbläsare. Du kommer till sidan **Boards** (Tavlor), där dina tavlor visas.

Om din arbetsyta kräver inloggning visas först **Sign in to Tabula** (Logga in på Tabula). Ange din jobbmejladress, välj **Email me a link** (Skicka en länk till min e-post) och öppna länken i mejlet. En sida säger **Joining as** (Ansluter som) din e-postadress; välj **Continue to Tabula** (Fortsätt till Tabula) för att slutföra inloggningen. Länken fungerar en gång och upphör att gälla efter 15 minuter. När du har loggat in kommer du till **Boards**. Utan inloggning (öppet läge) frågar sidan inte vem du är, utan öppnas direkt med dina tavlor.

## Skapa din första tavla

1. Välj **New board** (Ny tavla) och sedan **Blank board** (Tom tavla) på sidan **Boards**.
2. Den tomma tavlan visar ett tips. Tryck på `N` för att skapa en lapp, `R` för en rektangel eller dubbelklicka på tavelytan för att skriva text.
3. Klicka på tavlans namn längst upp till vänster och skriv ett namn. Tryck på `Enter` för att spara det.

Om du hellre vill börja med en färdig layout väljer du **Start from a template** (Börja från en mall). Se [Mallar](templates.md).

![En ny tom tavla med tipset som visas första gången, det vänstra verktygsfältet, tavlans namn och synkstatus uppe till vänster samt knapparna för delning och meny uppe till höger](images/getting-started-board.png)

## Skärmen

- **Uppe till vänster.** Knappen **All boards** (Alla tavlor) (husikonen) går tillbaka till sidan Boards. Bredvid den finns tavlans namn och synkroniseringsstatus. Märket **View only** (Endast visning) eller **Can comment** (Kan kommentera) visas här när du inte kan redigera tavlan.
- **Uppe till höger.** Personerna på tavlan (runda avatarer på en rad, så många som ryms; ett **+N**-märke räknar resten), kommentarknappen, **Share** (Dela) och knappen **Menu** (Meny) (tre punkter).
- **På en telefon** (en skärm upp till 480 px bred) delar båda fälten en rad. Till vänster finns huset, ett förkortat tavelnamn och synkpunkten. Till höger finns en personbricka (dold medan du är ensam och inget [AI-verktyg](ai-tools.md#se-en-agent-arbeta) arbetar; annars visar den upp till två avatarer och ett **+N**-antal som även räknar verktyg i arbete, och ett tryck listar alla), kommentarknappen med sitt märke för olästa, **Share** (Dela) som ikon och knappen **Menu** (Meny). På en skärm smalare än 380 px flyttas **Chat** (Chatt) in i **Menu**, och en liten punkt på knappen **Menu** visar att chatten har olästa meddelanden.
- **Vänstra verktygsfältet.** Verktygen beskrivs nedan.
- **Nere till höger.** Zooma ut, zoomnivå, zooma in, **Fit board** (Visa hela tavlan) och en knapp för att visa eller dölja minikartan.
- **Nedtill.** Sessionsraden för faciliterade sessioner. Se [Sessioner och fokusbegäranden](sessions.md).

### Vänstra verktygsfältet

Uppifrån och ned:

- **Select** (Markera) (`V`) och **Hand** (Hand) (`H`).
- **Sticky note** (Lapp) (`N`), **Text** (Text) (`T`), **Markdown block** (Markdown-block) (för längre anteckningar med rubriker, listor och uppgiftsrutor, se [Markdown-block](markdown-blocks.md), och utan kortkommando med en enda tangent), **Link** (Länk) (öppnar ett adressfält), **Table** (Tabell) (`G`, se [Tabeller](tables.md)), **Code block** (Kodblock) (för kod med färger, se [Kodblock](code-block.md)), **Shapes** (Former), **Connector** (Kopplingslinje) (`L`), **Pen** (Penna) (`P`), **Frame** (Ram) (`F`) och **Comment** (Kommentar) (`C`). **Shapes** öppnar en panel med ett sökfält. Klicka på en form för att rita den eller dra den till tavlan.
- Menyer för **UML** (UML), **Icons** (Ikoner), **Stickers** (Klistermärken) och **Templates and team exercises** (Mallar och teamövningar).
- En knapp för punktröstning och en knapp för snabbomröstning.
- **Undo** (Ångra) och **Redo** (Gör om).

Håll pekaren över en knapp i en halv sekund eller flytta tangentbordsfokus till den för att se ett verktygstips med namnet och, om det finns, kortkommandot som en tangentbricka. `Esc` stänger verktygstipset. Verktygstips visas inte på pekskärmar. På en tavla som du bara får visa är bara **Select** och **Hand** aktiva (och **Comment** om du får kommentera).

### Snabbåtgärdsfältet

Markera ett objekt så visas ett litet fält bredvid det. Beroende på vad du markerat kan du ändra färg, form, fyllning, linje, kopplingslinjens linjetyp, textalternativ eller justering (för två eller fler objekt), lägga till en klistermärkesreaktion, låsa, duplicera eller ta bort objektet. **More properties** (Fler egenskaper) (tre punkter) öppnar hela egenskapspanelen. Se [Former, text och lappar](shapes-text-notes.md).

### Tavlans meny

Knappen **Menu** längst upp till höger innehåller åtgärder för hela tavlan, med **Search actions** (Sök åtgärder) överst för att hitta en åtgärd med namn: **User guide** (Användarguide) först i listan, **Board settings** (Tavleinställningar), **Version history** (Versionshistorik), **Your name and colour** (Ditt namn och din färg), **Show comments** (Visa kommentarer), import, teman under **Appearance** (Utseende), export och **Keyboard shortcuts** (Kortkommandon). Om din arbetsyta kräver inloggning visas avsnittet **Account** (Konto) först. Där finns **Your AI key** (Din AI-nyckel) när administratören tillåter personliga nycklar. Se [Tavlor och startsidan](boards.md).

## Förflytta dig

- **Panorera.** Håll ned `Space` och dra, använd verktyget **Hand**, dra med mitten- eller högerknappen på musen eller rulla. På en styrplatta panorerar du med två fingrar.
- **Zooma.** Håll ned `Ctrl` (`Cmd` på Mac) och rulla, eller nyp på en styrplatta eller pekskärm. Knapparna nere till höger zoomar i steg. Klicka på procentsatsen för att återgå till 100 %. Att nypa över en textruta du redigerar zoomar också tavlan, och `Ctrl+0` (`Cmd+0` på Mac) återställer tavlans zoom till 100 % när tavlan har fokus; en notis visas när själva sidan är zoomad.
- **Anpassa vyn.** **Fit board** (`Shift+1`) visar allt på tavlan. `Shift+2` anpassar vyn till markeringen. När du öppnar en tavla på en telefon anpassas den första vyn redan till tavlan mellan verktygsfältet och högerkanten, så snart innehållet har lästs in; om du flyttar eller zoomar först lämnas din vy ifred.
- **Minikarta.** Kartknappen nere till höger visar en liten översikt. Klicka eller dra i den för att hoppa till en annan del av tavlan.
- **Gå till en person.** Klicka på någons avatar längst upp till höger för att hoppa till platsen där personen arbetar.

## Markera, flytta och ändra storlek

- Klicka på ett objekt för att markera det. `Shift`+klick lägger till eller tar bort objekt från markeringen.
- Dra på en tom del av tavelytan för att rita en markeringsruta. Håll ned `Shift` för att lägga till objekt i den aktuella markeringen.
- `Ctrl+A` (`Cmd+A` på Mac) markerar allt som inte är låst.
- Dra ett markerat objekt för att flytta det. Piltangenterna flyttar det en pixel. `Shift`+pil flyttar det ett rutnätssteg.
- Dra i ett handtag för att ändra storlek. Håll ned `Shift` för att behålla proportionerna. Dra i rotationshandtaget för att rotera objektet. `Shift` låser rotationen till steg om 15 grader.
- Håll ned `Alt` medan du drar för att ignorera rutnätets fästning.
- Tryck på `Enter` när ett enda objekt är markerat, eller dubbelklicka på det, för att redigera texten. Dubbelklicka på en tom del av tavelytan för att lägga till en textruta.
- Tryck på `Esc` för att avmarkera och gå tillbaka till verktyget **Select**.

## Ångra och göra om

Tryck på `Ctrl+Z` (`Cmd+Z` på Mac) för att ångra och `Shift+Ctrl+Z` eller `Ctrl+Y` för att göra om. Du kan också använda knapparna längst ned i det vänstra verktygsfältet.

## Spara och synkronisera

Tabula sparar varje ändring på din enhet medan du arbetar. Du behöver inte trycka på Spara, och tavlan fungerar även utan nätverksanslutning.

När en synkroniseringsserver går att nå visas ändringarna direkt för de andra på tavlan. Synkstatusen bredvid tavlans namn är en punkt. Dess form visar läget, och orden visas när du håller pekaren över den eller ger den tangentbordsfokus; skärmläsare läser upp orden när läget ändras.

| Form och status | Betydelse |
|---|---|
| Punkt: **Ansluten** / **Ansluten med 2** | Ansluten. Ändringar synkroniseras i realtid, och siffran visar hur många andra som är här. |
| Ring: **Sparad på den här enheten** | Allt är sparat lokalt. Tabula väntar på en anslutning och synkroniserar så snart det går. |
| Ring med en punkt i mitten: **Återställer…** | Arbetsytan återställs från en säkerhetskopia. Dina ändringar är sparade på den här enheten. |
| Stapel: **Endast lokalt** | Synkronisering är av. Tavlan finns bara i den här webbläsaren. |
| Triangel: **Inloggning krävs** / **Ingen åtkomst** | Servern avvisade anslutningen. Dina ändringar finns kvar på enheten. |

Välj **Share** (Dela) för att visa och kopiera tavlans länk. Synkstatusen öppnar den inte. I öppet läge kan alla med länken redigera tillsammans med dig utan att behöva ett konto. Om din arbetsyta kräver inloggning kan bara personer med åtkomst till tavlan öppna länken. Se [Dela, roller och team](sharing.md).

Om du rensar webbläsardata tas tavlor som aldrig har synkroniserats bort. Exportera viktiga tavlor från tavlans meny. Se [Exportera och importera](export-import.md).

## Ditt namn och din färg

Ditt namn och din färg visas bredvid markören och på lapparna du skriver. Klicka på din egen avatar eller välj **Your name and colour** i tavlans meny, välj sedan ett namn och en färg och välj **Save** (Spara). Om din arbetsyta kräver inloggning är namnet ditt kontonamn och sparas på servern. Färgen sparas på den här enheten. Din avatar visar första bokstaven i ditt namn; om ditt namn börjar med en emoji är hela emojin initialen, likadant för alla som ser den.

## Kortkommandon

På Mac använder du `Cmd` där tabellen anger `Ctrl`. Tavlans meny visar alla kortkommandon under **Keyboard shortcuts**.

### Verktyg

| Tangent | Åtgärd |
|---|---|
| `V` | Markera |
| `H` | Hand (panorera) |
| `N` eller `S` | Lapp |
| `T` | Text |
| `R` | Rektangel |
| `O` | Ellips |
| `D` | Diamant |
| `L` eller `X` | Kopplingslinje |
| `P` | Penna |
| `F` | Ram |
| `C` | Kommentar |
| `Esc` | Avmarkera och gå tillbaka till Select |

### Markering och redigering

| Tangent | Åtgärd |
|---|---|
| `Ctrl+A` | Markera allt (låsta objekt hoppas över) |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Kopiera, klipp ut, klistra in |
| `Ctrl+D` | Duplicera |
| `Delete` eller `Backspace` | Ta bort markeringen |
| `Enter` | Redigera texten i det markerade objektet |
| Piltangenter | Flytta 1 pixel |
| `Shift`+piltangenter | Flytta ett rutnätssteg |
| `]` | Flytta längst fram |
| `Ctrl+]` | Flytta fram ett steg (`Cmd+]` på Mac) |
| `Ctrl+[` | Flytta bakåt ett steg (`Cmd+[` på Mac) |
| `[` | Flytta längst bak |
| `Shift+H` | Vänd markeringen vågrätt |
| `Shift+V` | Vänd markeringen lodrätt |
| `Ctrl+Z` | Ångra |
| `Shift+Ctrl+Z` eller `Ctrl+Y` | Gör om |

### Vy

| Tangent | Åtgärd |
|---|---|
| `Space` + dra | Panorera |
| `Ctrl` + rulla | Zooma |
| `Ctrl+=` / `Ctrl+-` | Zooma in / ut |
| `Shift+1` | Visa hela tavlan |
| `Shift+2` | Anpassa vyn till markeringen |
| `Shift+0` | Återställ zoom till 100 % |

### När du drar

| Modifierare | Effekt |
|---|---|
| `Alt` | Ignorera rutnätet och smarta hjälplinjer |
| `Shift` när du ändrar storlek | Behåll proportionerna |
| `Shift` när du roterar | Lås rotationen till steg om 15 grader |
| `Shift`+klick | Lägg till eller ta bort objekt från markeringen; under en punktröstning tar det bort en punkt |

Kortkommandon fungerar inte medan du skriver i ett textfält. På en tavla som bara går att visa byter bara `V`, `H` och `C` (om du får kommentera) verktyg.

## Relaterat

- [Tavlor och startsidan](boards.md)
- [Former, text och lappar](shapes-text-notes.md)
- [Mallar](templates.md)
- [Teman](themes.md)
