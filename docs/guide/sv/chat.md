# Chatt

En chatt är ett pågående samtal. Varje tavla har en egen, varje team har en och hela arbetsytan kan ha en. Den visas i arbetsytor med inloggning, där den är på som standard; den som driver Tabula-servern kan stänga av den. På en server utan inloggning finns ingen chatt. Om du inte ser knappen eller länken **Chat** (Chatt) är funktionen inte tillgänglig för dig.

Kommentarer är knutna till en plats på tavlan och används för att diskutera en viss sak. Chatten hör till hela tavlan, teamet eller arbetsytan och används för att prata medan ni arbetar.

## Var du kan chatta

- **Chatt på tavlan**: personerna med konto som kan öppna tavlan. Personer som har anslutit med en anslutningskod har ingen chatt. Den öppnas i chattpanelen vid tavlans högra kant; kommentarerna har sin egen panel. På en telefon som är smalare än 380 px öppnar du den med **Chat** i tavlans **Menu**; en punkt på knappen **Menu** visar olästa meddelanden.
- **Teamchatt**: teamets medlemmar. Personer som har anslutit till en tavla med en anslutningskod har ingen chatt. Arbetsytans ägare och administratörer kan läsa alla teams chattar och ta bort meddelanden, men de kan bara skriva i team de tillhör. När ett team arkiveras går det bara att läsa chatten.
- **Chatt för arbetsytan**: alla i arbetsytan utom gäster. En administratör kan stänga av den (se [Administratörspanelen](admin.md)).

Chatt för team och arbetsytor finns på sidan **Chat page** (chattsidan). Chatten på tavlan visas också där medan den är aktiv.

## Chattsidan

Välj **Chat** i det övre fältet på startsidan eller öppna adressen `#/chat`.

Kanallistan och den öppna konversationen är mörka paneler, som chattpanelen på en tavla. På en telefon är listan och konversationen en skärm var.

- Listan till vänster innehåller **Workspace** (Arbetsyta), **Teams** (Team), **Other teams** (Andra team) (team du kan läsa som administratör utan att tillhöra dem) och **Boards** (Tavlor) (tavlor vars chatt har haft ett meddelande under de senaste 14 dagarna).
- En bricka på en rad visar antalet olästa meddelanden. Om någon har nämnt dig står ett @ före antalet.
- Välj en rad för att läsa chatten. Samtalet till höger fungerar som på en tavla, och adressen ändras så att du kan komma tillbaka till det.
- När du öppnar sidan visas kanalen där du har blivit nämnd, eller den med flest olästa meddelanden.
- På en telefon visas listan på en skärm och samtalet på en annan. **All channels** (Alla kanaler) (eller webbläsarens bakåtknapp) tar dig tillbaka till listan.
- I en team- eller arbetsytekanal kanske du inte kan skriva. Då visar rutan varför, till exempel om teamet är arkiverat eller arbetsytan är skrivskyddad.

Länken **Chat** i det övre fältet visar hur många olästa meddelanden du har i alla dina kanaler. På sidan **Boards** visas antalet olästa chattmeddelanden bredvid tavlans namn.

## Chattpanelen

Chatten öppnas i en flytande panel vid skärmens högra kant. Det är samma panel på en tavla, på sidan **Boards** (Tavlor) och i spåraren, så samtalet följer med dig när du rör dig i appen.

- Välj **Chat** i det övre fältet, eller tryck på `M`, så öppnas panelen där du är; du lämnar inte sidan. Tryck på `M` igen om du vill stänga den. På sidan **Boards** (Tavlor) och i spåraren öppnar länken **Chat** i det övre fältet panelen på samma sätt. När du öppnar den med tangentbordet flyttas fokus till meddelandefältet.
- Panelen öppnas på kanalen där någon har nämnt dig eller som har flest olästa meddelanden, och annars på den du använde senast.
- Knappen **Open the full Chat page** (Öppna hela chattsidan) i panelens rubrikrad tar dig till [chattsidan](#chattsidan).
- En bricka på knappen visar antalet olästa meddelanden. Den får en röd kontur när någon har nämnt dig.
- Överst i panelen finns kanalflikar: **This board** (Den här tavlan), arbetsytan och dina team, var och en med sitt antal olästa. En knapp **+N** listar de övriga kanalerna. En rad under flikarna säger vem som är på tavlan just nu.
- Panelen har tre storlekar. Använd knapparna i rubrikraden för att göra den **Compact** (Kompakt), **Minimise** (Minimera) den till en rund chattknapp ovanför zoomkontrollerna eller **Close** (Stäng) den. Den runda knappen visar antalet olästa i alla kanaler och har en röd kontur när någon har nämnt dig. Välj den om du vill öppna panelen igen.
- Panelen kommer ihåg storleken du lämnade den i och kanalen du senast använde. Det gäller bara dig, på den här enheten.
- I ett brett fönster flyttas zoomkontrollerna, snabbverktygsfältet, sessionsfältet, omröstningskortet, AI-verktygsfältet och meddelanden till vänster om den öppna panelen, och **Fit board** lämnar plats åt den. När du öppnar **Comments** läggs chattpanelen undan, och när du öppnar chattpanelen läggs **Comments** undan.
- `Esc` behåller fokus i panelen (ett meddelandefält, en meny eller en redigering använder sin första `Esc` själv), och en andra `Esc` stänger panelen och för dig tillbaka till knappen **Chat**. Fokus faller aldrig tillbaka till sidan när panelen stängs eller minimeras.
- På en telefon (en skärm smalare än 600 px) öppnas panelen som ett bottenark över tavlan. Dra handtaget nedåt, eller tryck på det, så blir arket till chattknappen. Knapparna är stora och meddelandefältet ligger ovanför tangentbordet.
- Panelen visas inte på sidorna för inloggning, inbjudan, anslutning och godkännande av appar, och inte heller på chattsidan, som redan är hela chatten.

![Tavlachatten med svar, en reaktion, en omnämning och objektbrickor, i det engelska gränssnittet (äldre sidopanelslayout)](images/chat-tray.png)

## Läsa

Meddelandena visas i en uppdaterad lista, med de äldsta överst.

- Rulla uppåt för att läsa äldre meddelanden. Din plats ligger kvar när äldre eller nyare meddelanden kommer in.
- **Jump to latest** (Hoppa till senaste) tar dig längst ned om du har rullat därifrån.
- Varje person har en färgad ruta. Dina egna meddelanden ligger till höger som pratbubblor, och ett meddelande som nämner dig är markerat.
- Flera meddelanden från samma person inom fem minuter grupperas. Datumrader skiljer dagarna åt.
- Raden **New messages** (Nya meddelanden) visar var du slutade läsa. Den flyttas när det senaste meddelandet syns på skärmen.
- **edited** (redigerat) markerar ett meddelande som författaren har ändrat. Ett borttaget meddelande visas som **Message deleted** (Meddelandet har tagits bort) eller **Message removed by a moderator** (Meddelandet har tagits bort av en moderator), så att svaren fortfarande går att förstå.
- Ett svar visar ett citat på en rad av meddelandet det svarar på.
- Reaktioner visas som små brickor under meddelandet. Håll pekaren över ett meddelande för att se **React** (Reagera), **Reply** (Svara) och **More** (Mer).
- Den kompakta chatten visar en rad per meddelande. En tom chatt säger vem som kan läsa den och vad du kan göra.
- Webblänkar (`http` och `https`) öppnas i en ny flik. Meddelanden visas alltid som vanlig text.

## Skriva

1. Klicka i rutan längst ned i panelen och skriv.
2. Tryck på `Enter` för att skicka. `Shift+Enter` börjar en ny rad. `Esc` lämnar rutan.

Rutan växer till sex rader. Ett meddelande får innehålla högst 2 000 tecken.

### Nämna någon

Skriv `@` för att se vilka som kan läsa kanalen och välj en person. Personen markeras i meddelandet och får en bricka på sin **Chat**-knapp. Du kan nämna upp till 10 personer i ett meddelande.

Hur personen får veta det beror på var hen befinner sig:

- Om hen har Tabula öppet men inte tittar på den kanalen visas ett kort med vem som nämnde hen, var det hände och meddelandets första ord. Kortet har knapparna **Open** (Öppna) och **Dismiss** (Stäng). Det försvinner av sig självt efter 20 sekunder.
- Om hen har Tabula öppet på den kanalen ser hen bara ditt meddelande.
- Om hen har stängt Tabula får hen ett mejl efter 10 minuter, så länge ingen har öppnat Tabula eller läst meddelandet sedan dess. Se [Aviseringar](#aviseringar).

### Peka på något på tavlan

I tavlchatten väljer du ett objekt på tavlan och sedan **Reference selection** (Referera till markering) bredvid meddelanderutan. En rad ovanför rutan visar vad du pekar på, med en knapp för att ta bort det. Skicka meddelandet så följer en bricka med objektets text.

Välj en bricka för att flytta vyn till objektet och markera det. Brickan följer tavlan, så den visar objektets aktuella text. Om objektet har tagits bort står det på brickan och den leder ingenstans. På chattsidan öppnar en bricka tavlan vid objektet.

Referensmarkering är avstängd om inte exakt ett objekt är markerat. Anteckningar som [privat skrivande](sessions.md) döljer för dig, och objekt som är dolda i panelen Lager, visar ingen text och du kan inte flyga till dem. Andra typer av kanaler har inga brickor.

### Svara, kopiera, redigera och ta bort

Varje meddelande har en meny:

- **Reply** (Svara) citerar meddelandet i ditt nästa.
- **Copy text** (Kopiera text).
- **Edit** (Redigera), för dina egna meddelanden. Meddelandet märks då som **edited**.
- **Delete** (Ta bort), för dina egna meddelanden. Tavlans ägare kan också ta bort andras.

### Reagera

Välj åtgärdsknappen på ett meddelande (de tre punkterna) och välj **React** (Reagera), sedan en av sex reaktioner: 👍 ❤️ 😄 🎉 👀 ✅. Reaktionen visas som ett litet antal under meddelandet. Välj antalet för att lägga till eller ta bort din egen reaktion. Du kan använda varje reaktion en gång per meddelande. Reaktioner skickar aldrig någon avisering. Du kan inte reagera på ett borttaget meddelande.

## Vem kan skriva

Alla med konto som kan öppna tavlan kan läsa chatten; personer som har anslutit med en anslutningskod kan inte det. Ägare, redigerare och kommentatörer kan skriva. Personer som bara kan visa tavlan får skriva endast om en administratör för arbetsytan har tillåtit det. Rutan är inaktiverad och visar orsaken när du inte kan skriva: läsåtkomst, en skrivskyddad arbetsyta eller förlorad åtkomst till tavlan.

## Aviseringar

Under **Chat notifications** (Chattaviseringar) i tavlans meny (eller **Notifications** (Aviseringar) längst ned i kanallistan på chattsidan) kan du välja om du vill få ett mejl när någon nämner dig. Det är aktiverat tills du stänger av det.

Mejlet berättar vem som nämnde dig, på vilken tavla, i vilket team eller på vilken arbetsyta, och visar meddelandets första ord samt en länk. Det skickas bara om du inte har haft Tabula öppet på 10 minuter, och inte för ett meddelande som du har läst eller som har tagits bort eller ändrats så att det inte längre nämner dig. Du får högst ett mejl per samtal var tionde minut och 20 om dagen. Att redigera ett meddelande skickar aldrig mejlet igen.

**Konfiguration av e-post:** Med standardvärdet `TABULA_MAIL=log` levereras inga mejl om omnämnanden. Reläet skriver i stället ut innehållet i processens utdata, inklusive meddelandets första 140 tecken. Om din installation ska leverera mejl om omnämnanden, ställ in `TABULA_MAIL=smtp` eller `TABULA_MAIL=webhook` med avsikt.

## Offline

Chatten sparar de senaste 50 meddelandena från varje tavla du har öppnat på den här enheten. Utan anslutning visas de med **Offline, showing saved messages** (Offline, visar sparade meddelanden).

Meddelanden som du skickar offline väntar i en kö och visas i grått med **Sending…** (Skickar…). De skickas i ordning när anslutningen kommer tillbaka. Om ett meddelande inte kan skickas visas **Not sent** (Skickades inte) med knapparna **Retry** (Försök igen), **Copy** (Kopiera) och **Discard** (Kasta). Om servern avvisar det visas orsaken. Det krävs en anslutning för att redigera och ta bort meddelanden. När du loggar ut tas de sparade meddelandena bort från enheten.

## När någon lämnar

När en medlem tas bort finns hens chattmeddelanden kvar. De visas under namnet som användes när de skrevs, men utan ett konto bakom namnet. Reaktioner, läskvitton och omnämningar av personen tas bort.

Administratörer kan också hantera en begäran om en kopia av någons chattdata eller om att uppgifterna ska raderas. Under **Admin** (Admin) > **Members** (Medlemmar) finns två åtgärder för varje person:

- **Export chat** (Exportera chatt) laddar ned en JSON-fil med allt personen har skrivit och de reaktioner hen har lämnat. Borttagna meddelanden saknar text.
- **Erase chat messages** (Radera chattmeddelanden) gör om alla meddelanden personen har skrivit i alla kanaler till borttagna meddelanden från ”Tidigare medlem”. Du måste klicka en gång till för att bekräfta. De som tittar på kanalen ser ändringen direkt.

Båda åtgärderna registreras i granskningsloggen med personen och ett antal, men aldrig meddelandetexten. Filtrera på **Chat** för att hitta dem. Säkerhetskopior innehåller raderade meddelanden tills säkerhetskopiorna löper ut. Det här är inte en fullständig export av personens personuppgifter.

## Olästa meddelanden i flikens titel

När fliken ligger i bakgrunden börjar sidans titel med antalet olästa chattmeddelanden, till exempel `(3) Roadmap - Tabula`.

## Bra att veta

- Chatten ingår inte i versionshistoriken och finns inte med i exporter eller tavelfiler. En tavla som du exporterar och öppnar någon annanstans saknar sin konversation.
- Chatten är separat från kommentarerna, och de visas inte tillsammans.
- På en telefon flyttas sessionsfältet (timer, röstning, omröstning) åt sidan medan chattpanelen är öppen, så att meddelanderutan inte täcks. Det kommer tillbaka när du stänger panelen.
- Om du redigerar ett meddelande och nämner någon ny får de nya personerna en avisering, inte de som nämndes tidigare.
- En administratör väljer hur länge meddelanden sparas. De tas bort efter ett år om administratören inte väljer något annat.

## Relaterat

- [Kommentarer](comments.md)
- [Delning, roller och team](sharing.md)
- [Administratörspanelen](admin.md)
