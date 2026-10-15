# Kanbantavlor

En kanbantavla består av kolumner med kort i dem. Du drar ett kort från en kolumn till en annan i takt med att arbetet går framåt. Tavlan ligger på arbetsytan som vilket annat objekt som helst.

## Lägga till en kanban

1. Öppna panelen **Shapes** (Former) och välj **Kanban** (Kanban) under **Boards** (Tavlor). Du kan också skriva ”kanban” i **Search shapes** (Sök bland former).
2. Klicka på tavlan för att placera den eller dra för att ställa in storleken.

Du får tre kolumner, **To do** (Att göra), **Doing** (Pågår) och **Done** (Klart). I den första kolumnen öppnas **+ Add card** (Lägg till kort) så att du kan skriva det första kortet direkt.

Om du bara kan visa en tavla kan du inte lägga till en kanban. Kopierade och inklistrade kanbaner, importerade tavelfiler och mallar behåller kanbaner precis som andra objekt.

## Lägga till kort

- Välj **+ Add card** längst ned i en kolumn eller dubbelklicka på ett tomt område i kolumnen.
- Skriv en titel. `Enter` lägger till kortet och börjar på nästa. `Esc` avbryter.

På ett kort visas titeln (högst tre rader) och, när de har angetts, etikettbrickor, ett förfallodatum, antalet kommentarer och den ansvariga. Personer har en fyrkantig bricka med initialer. AI-verktyg har en åttkantig bricka. En länkikon öppnar kortets HTTP- eller HTTPS-länk i en ny flik. Att ta bort ett kort fungerar som när du tar bort ett annat objekt.

## Öppna ett kort

Dubbelklicka på ett kort, markera det och tryck på `Enter`, eller välj **Open** (Öppna) i snabbåtgärdsfältet. Kortdialogrutan innehåller:

- **Title** (Titel) och **Description** (Beskrivning).
- **Owner** (Ansvarig): du, personerna som är på tavlan nu, någon som redan har namngivits på kortet (bara utan inloggning) eller ett namn som du skriver. Ett kort har en ansvarig.
- **Owner type** (Typ av ansvarig): person eller AI-verktyg. Äldre kort utan ansvarigtyp tillhör personer. En ansvarig som är ett AI-verktyg är ett AI-verktyg som du har anslutit (se nedan). Brickan har en särskild åttkantig form.
- **Link** (Länk): en webbadress som hör till kortet, till exempel ärendet som kortet kommer från. När den har sparats öppnar **Open link** (Öppna länk) adressen i en ny flik.
- **Due date** (Förfallodatum), med webbläsarens datumväljare.
- **Labels** (Etiketter), som väljs bland tavlans etiketter.
- **Comment** (Kommentar), **Turn into sticky** (Gör om till lapp) och **Delete** (Ta bort).

Varje fält sparas när du lämnar det, och varje fält är ett steg i ångra. På en telefon visas dialogrutan som ett fönster längst ned. Kommentatörer ser kortet som skrivskyddat men kan fortfarande kommentera. Läsare kan inte öppna det.

![Kortdialogrutan i det engelska gränssnittet med titel, beskrivning, ansvarig, förfallodatum och etiketter](images/kanban-card-dialog.png)

## Länkar

Lägg till en webbadress på ett kort, till exempel adressen till ett ärende, dokument eller en design. Bara webbadresser som börjar med `http://` eller `https://` godkänns. De får innehålla högst 2 000 tecken, inga mellanslag och inget användarnamn eller lösenord. Allt annat, till exempel `javascript:` eller en filadress, avvisas och sparas inte. **Open link** öppnar sidan i en ny flik. I en lista har varje rad med en länk en egen knapp **Open link**. Rensa fältet för att ta bort länken.

## Ansvariga

Välj **Owner** i kortdialogrutan eller snabbåtgärdsfältet. Du kan välja dig själv eller någon som är på tavlan nu, eller skriva ett namn för någon som saknar konto; i en arbetsyta utan inloggning erbjuder listan också personer som redan namngetts på tavlan. På en tavla med inloggning erbjuder listan bara dig själv och de inloggade personer som är på tavlan nu, och ett kort som ägs av en gammal identitet som inte längre är känd visar **Unknown** (Okänd). Namnet sparas även om personen lämnar senare. Ett kort har en ansvarig, och filtret **Mine** (Mina) visar kort som du ansvarar för.

Ett kort som har ett AI-verktyg som ansvarig har en åttkantig bricka i stället för en rund i kortet, dialogrutan och listan. I kortdialogrutan kan du inte ge ett kort en ansvarig som är ett AI-verktyg eller byta namn på den ansvariga. Den ansvariga är knuten till åtkomsttokenen som tog kortet. Om du öppnar och sparar ett sådant kort i dialogrutan står AI-verktyget kvar som ansvarigt. Det blir aldrig en person när du sparar. Detsamma gäller ett namn som du har skrivit in och som saknar konto: att spara kortet ersätter inte namnet med ditt. Se [Åtkomsttoken och AI-verktyg](ai-tools.md).

## Förfallodatum och försenade kort

Ange ett **Due date** och kortet visar datumet som ”I dag”, ”I morgon”, en veckodag med datum eller ”för 3 dagar sedan”. Ett kort är **Overdue** (Försenat) när datumet har passerat och kolumnen inte har fasen **Done**. Då visas kortet med en varningsfärg och text, så att informationen inte bara förmedlas med färg. Ett kort i en kolumn med fasen Done blir aldrig försenat. ”I dag” baseras på datumet på din egen enhet, så två personer i olika tidszoner kan se olika datum i några timmar runt midnatt. Använd **Due** (Förfaller) i filtret för att se försenade kort, kort som förfaller i dag eller den här veckan. Påminnelser under klockan använder UTC-datum, så de kan skilja sig från kortets egen färg för **Overdue** (Försenad) i några timmar.

## Etiketter

Välj **Labels** i kortdialogrutan, snabbåtgärdsfältet eller en kanbans egenskapspanel för att hantera tavlans etiketter. Du kan skapa, byta namn på, ändra ordning på och ta bort etiketter. Du kan ge varje etikett en av åtta namngivna färger. Bara redigerare kan ändra etiketter. En etikett på ett kort visas som en bricka med en bock i väljaren.

## Göra om lappar till kort

- Markera lappar eller kort och tryck på `K`, eller välj **Turn into card** (Gör om till kort) eller **Turn into sticky**. Det är samma objekt, så kommentarer, kopplingslinjer, röster och historik finns kvar. Den första raden blir titeln och resten blir beskrivningen.
- En lapp som ligger över en kolumn läggs till i den kolumnen. Ett kort som görs om till en lapp stannar där det ritades.
- Dra en lapp till en kolumn för att göra den till ett kort där. En linje visar var kortet hamnar.
- **Make kanban from selection** (Skapa kanban från markering) lägger de markerade lapparna i den första kolumnen på en ny kanban, i läsordning.
- Ingen annans anteckning görs om medan privat skrivande pågår.

## Flytta kort

- **Dra ett kort** till en annan plats i kolumnen, till en annan kolumn eller till en tom kolumn (där står **Drop here** (Släpp här)). En linje visar var kortet hamnar. Inget ändras förrän du släpper kortet, och hela flytten är ett steg i ångra.
- **Med tangentbordet** markerar du ett kort och trycker på `Alt` och en piltangent: uppåt eller nedåt flyttar kortet inom kolumnen, vänster eller höger flyttar det till nästa kolumn. En ring och ordet **Moving** (Flyttas) visar det. En skärmläsare läser upp vart kortet flyttades, till exempel ”Flyttades till Doing, plats 2 av 5”.
- Släpp ett kort utanför kanbantavlan så blir det ett fristående kort på tavlan.
- Läsare och kommentatörer kan titta på kort men inte dra dem.

## Kopplingslinjer

Du kan koppla ihop två kort eller koppla ett kort till ett annat objekt med en kopplingslinje. Den följer kortet när det flyttas till en annan kolumn. En kolumn och själva kanbanen kan inte kopplas till andra objekt. De visar inga kopplingspunkter, och en kopplingslinje som dras till dem förblir lös.

## Kolumner

Varje kolumn visar hur många kort den innehåller. Klicka på ett kort, en kolumn eller behållaren för att markera den.

Redigerare har en knapp **⋯** på varje kolumn. Den innehåller:

- **Rename** (Byt namn).
- **Colour** (Färg), en av åtta namngivna färger.
- **Stage** (Fas): to do, doing eller done. Kort i en kolumn med fasen done visas inte som försenade.
- **WIP limit** (WIP-gräns): ange eller ta bort det högsta antal kort kolumnen ska innehålla och välj **warn** (varna) eller **block** (blockera) (se nedan).
- **Move left** (Flytta vänster) och **Move right** (Flytta höger).
- **Delete lane** (Ta bort kolumn) flyttar korten till kolumnen till vänster, eller till höger om det är den första kolumnen. **Delete lane and its cards** (Ta bort kolumn och dess kort) tar bort båda.

Om du vill ändra ordning på kolumnerna manuellt håller du ned en kolumns rubrik och släpper den i mellanrummet där den ska ligga. En linje visar var kolumnen släpps medan du flyttar den. Det fungerar med mus eller penna. På en pekskärm använder du **Move left** och **Move right** eller listan. En kolumn som är dold i panelen Lager flyttas inte.

Välj **+** till höger om den sista kolumnen för att lägga till en kolumn. Den öppnas med namnet redo att skrivas in. Varje sådan åtgärd är ett steg i ångra. En låst kolumn eller kanban visar det i stället för att ändras.

### Gränser för pågående arbete

En kolumn med en gräns visar till exempel `3 / 3`, med en röd markering när den är full. I läget **warn** händer inget mer. I läget **block** avvisar en full kolumn också fler kort: ett kort eller en lapp som släpps där, en flytt med `Alt` och piltangenterna eller ett nytt kort. Ett meddelande förklarar varför, till exempel ”Review är full: 3 av 3”. När du drar över en full kolumn får den en streckad kontur och visar **Full** (Fullt). **+ Add card** i kolumnen inaktiveras. Du får alltid flytta ett kort inom en full kolumn eller ut ur den. Gränserna kontrolleras bara i din webbläsare.

## Hela kanbanen

Menyn **⋯** i kanbanens rubrik (för redigerare) innehåller **Rename**, **Add lane** (Lägg till kolumn), **Labels**, **Lock** (Lås) eller **Unlock** (Lås upp), och **Delete kanban** (Ta bort kanban). Den innehåller också **Open as list** (Öppna som lista) och **Export cards (CSV)** (Exportera kort (CSV)).

## Filtrera korten

Välj **Filter** (Filtrera) i kanbanens rubrik eller snabbåtgärdsfältet för att bara visa de kort du vill se. Snabbvalen i menyn är **Mine** och **Overdue**. Försenade kort har ett datum före i dag i din lokala tidszon. Kort i en kolumn med fasen **Done** hoppas över. Du kan kombinera snabbvalen med:

- **Mine**: kort som du ansvarar för.
- **Labels**: kort med någon av etiketterna du väljer.
- **Due**: försenade kort, kort som förfaller i dag, den här veckan eller saknar datum.
- **Text** (Text): ord i titeln eller beskrivningen.

Menyn visar hur många kort som matchar, till exempel ”2 av 9 matchar”, och har **Clear** (Rensa). Aktiva filter visas också som brickor i rubriken, var och en med en knapp för att ta bort filtret.

Kort som inte matchar blir nedtonade, inte dolda, och en rektangulär markering hoppar över dem. Kommentarsnålar behåller sin vanliga tydlighet. Ett filter är bara ditt: det sparas i den här webbläsaren, inte på tavlan, så andra ser det inte och exporter tar inte med det. Läsare och kommentatörer kan också filtrera.

När du zoomar långt ut blir korttitlarna till streck, och kolumnrubrikerna visar bara namnen.

## Öppna som lista

**Open as list** visar en kanban som kolumnflikar med en rad per kort. Du hittar funktionen i kanbanens meny **⋯**, i snabbåtgärdsfältet, genom att trycka på `Enter` när en kanban är markerad eller, på en telefon, genom att dubbeltrycka på kanbanen. På en telefon fyller listan skärmen. På en bred skärm visas den i en sidopanel.

Varje rad har:

- Ett handtag för att dra kortet uppåt eller nedåt i kolumnen.
- **Move to…** (Flytta till…), som listar kolumnerna med antal kort och sedan alternativen överst och nederst. En full kolumn med en spärrande gräns är nedtonad och visar varför.
- **Open** och **Turn into sticky**.

`Alt` och piltangenterna flyttar ett kort på samma sätt som på tavlan, och en skärmläsare läser upp vart det flyttades. Fältet **Add card** (Lägg till kort) längst ned lägger till ett kort i kolumnen du tittar på, så länge den inte är full och blockerad. Läsare kan läsa och filtrera listan. Kommentatörer kan öppna kort men inte ändra dem.

På en pekskärm lyfts ett kort på tavlan när du håller ned det i ungefär en halv sekund. Då kan du dra kortet utan att rulla tavlan.

## Kanbanmallar

Mallpanelen och sidan Mallar erbjuder fyra kanbanmallar: **Kanban**, **Sprint board** (Sprinttavla), **Bug triage** (Buggprioritering) och **Personal tasks** (Personliga uppgifter). Mallarnas etiketter läggs till bland tavlans etiketter efter namn, så befintliga etiketter återanvänds. Ansvariga, typer av ansvariga, förfallodatum, kortlänkar och spårarlänkar ingår aldrig i en mall. Spårarlänkar finns bara där din server har spåraren aktiverad och du har åtkomst till den; om du inte ser några länkåtgärder i kanbanmenyn är spåraren inte tillgänglig för dig.

När du sparar ett urval som innehåller en kanban som en egen mall, eller kopierar och klistrar in en kanban, följer dess kolumner och kort med. När mallen sparas tas ansvariga, typer av ansvariga, förfallodatum, kortlänkar och spårarlänkar bort.

## Exportera kort som CSV

Välj **Cards as CSV** (Kort som CSV) i tavlans meny, **Export cards (CSV)** i en kanbans meny **⋯** eller **Export cards (CSV)** i snabbåtgärdsfältet. Du får en rad per kort för alla kanbaner på tavlan eller bara de markerade. Kolumnerna är kanban, kolumn, fas, position, titel, beskrivning, ansvarig, typ av ansvarig, förfallodatum, länk, etiketter, antal kommentarer, vem som skapade kortet, när det senast uppdaterades och dess id. Om typen av ansvarig saknas exporteras värdet **person**. Filen öppnas korrekt i Excel. Celler som börjar med `=`, `+`, `-` eller `@` får en apostrof framför, så att kalkylblad visar dem som text och aldrig kör dem. Kanbaner som är dolda i panelen Lager tas inte med.

## Äldre versioner

En tavla med en kanban öppnas som skrivskyddad i en Tabula-version som ännu inte känner till kanbantavlor. En banderoll talar om det. Läs om sidan för att använda den aktuella versionen.

## I Markdown-sammanfattningen

Tavlans [Markdown-sammanfattning](export-import.md#markdown-sammanfattning) listar varje kanban som en rubrik, varje kolumn under den som en mindre rubrik med sin fas och gräns (till exempel ”pågår, 3 av 3, blockerar”), och korten som punktlista i den ordning de ritades, med ansvarig och förfallodatum inom parentes samt eventuella röster. Kanbaner, kolumner och kort som är dolda i panelen Lager tas inte med.

## Relaterat

- [Former, text och lappar](shapes-text-notes.md)
- [Kommentarer](comments.md)
