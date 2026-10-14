# Åtkomsttoken och AI-verktyg

En åtkomsttoken låter ett AI-verktyg som Claude Code arbeta med dina tavlor åt dig. Verktyget kan läsa tavlor och kommentera på dem, och om du tillåter det även redigera dem medan andra ser ändringarna direkt.

> Den här funktionen måste aktiveras av den som kör din Tabula-server. Om **AI tool access** (AI-verktygsåtkomst) saknas i menyn under ditt namn och i tavlans meny ber du serveransvarig att aktivera den. Funktionen finns i arbetsytor med inloggning.

## Vad ett AI-verktyg kan göra

Vad verktyget kan göra beror på vilken åtkomstnivå du ger tokenen.

- **Read only** (Endast läsning): listar dina tavlor, läser innehållet på en tavla och läser dess kommentarer. Ett verktyg kan också söka efter text på en tavla, exportera den som Markdown eller JSON och, om du är ägare eller redigerare av tavlan, läsa dess versionshistorik och vad som ändrades mellan versioner (ändringarna, aldrig objektens text).
- **Read and comment** (Läsa och kommentera): kan även lägga till kommentarer och svara på dem. Kommentarer märks med ditt namn följt av tokenens namn, så att andra kan skilja dem från kommentarer du själv har skrivit.
- **Read and edit** (Läsa och redigera): kan även skapa, ändra och ta bort objekt på tavlan. Alla på tavlan ser ändringarna direkt.

AI-appar som läser MCP-resurser ser också dina tavlor som resurser (`board://` följt av tavlans id), med exakt den åtkomst som tavelverktygen ger. Ett AI-verktyg kan inte dela tavlor, ändra roller, ta bort tavlor, hantera team eller se medlemslistan.

Två skydd gäller för varje token:

- En token kan aldrig ge större åtkomst än du själv har. Om du bara är läsare på en tavla kan verktyget bara läsa den, även med en redigeringstoken. Om din åtkomst tas bort förlorar tokenen den också.
- Privata anteckningar från en pågående [session](sessions.md) lämnas utanför. Verktyget ser dem inte och kan inte ändra eller ta bort dem.

> En persons `Ctrl+Z` (`Cmd+Z` på Mac) ångrar inte en ändring som ett AI-verktyg har gjort. Borttagningar via verktyget är permanenta, så ge bara redigeringsåtkomst där det behövs. Tavlans text skickas till AI-verktyget, så anslut bara verktyg som du litar på med det innehållet.

## Skapa en token

Administratörer kan också välja **Create a token** (Skapa en token) i avsnittet **Access tokens** (Åtkomsttoken) på administratörssidan. Samma formulär öppnas och en token skapas åt dig, och listan där uppdateras.

1. Öppna ditt namn i det övre fältet på sidan **Boards** (Tavlor) eller **Templates** (Mallar) och välj **AI tool access**, eller öppna tavlans meny och välj alternativet under **Account** (Konto).
2. Välj **New token** (Ny token).
3. Ange ett **Name** (Namn), till exempel ”Claude Code på min bärbara dator”.
4. Välj en **Access**-nivå (Åtkomst): **Read only**, **Read and comment** eller **Read and edit**. Välj den lägsta nivån verktyget behöver.
5. Under **Boards** väljer du **All my boards** (Alla mina tavlor) eller **Only these** (Endast dessa) och markerar tavlorna (högst 20).
6. Välj när tokenen **Expires** (Upphör att gälla): efter 7, 30, 90 eller 365 dagar. Det finns ingen token som aldrig upphör att gälla.
7. Välj **Create token**.

![Formuläret New token i dialogrutan AI tool access: ett namn, Read and comment och Only these valda, två tavlor ikryssade och valen för giltighetstid](images/token-form.png)

Tokenen visas bara en gång. Kopiera den nu och behandla den som ett lösenord. Om du tappar bort den återkallar du den och skapar en ny. Dialogrutan ger dig också ett färdigt kommando och ett kodutdrag med inställningar för verktyget.

### Tavlornas ägare och administratörer måste ange tavlor

Arbetsytans ägare och administratörer har full åtkomst till alla tavlor. Därför måste en ägares eller administratörs token med åtkomstnivån **Read and comment** eller **Read and edit** ange tavlor med **Only these**. Token med **Read only** kan omfatta alla tavlor. Om du blir administratör efter att ha skapat en obegränsad kommentar- eller redigeringstoken fungerar den som en token med enbart läsåtkomst tills du åter blir medlem.

## Anslut Claude Code

Klistra in kommandot från dialogrutan i terminalen. Det har följande format:

```
claude mcp add --transport http board https://YOUR-SERVER/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

Andra verktyg använder en inställningsfil med samma uppgifter:

```
{
  "mcpServers": {
    "board": {
      "type": "http",
      "url": "https://YOUR-SERVER/mcp",
      "headers": { "Authorization": "Bearer YOUR-TOKEN" }
    }
  }
}
```

Serveradressen är samma som du använder för Tabula, följd av `/mcp`. När verktyget är anslutet kan du be det lista dina tavlor eller läsa en av dem.

## Vad ett redigeringsverktyg kan ändra och ta bort

Ett verktyg med åtkomstnivån **Read and edit** kan skapa klisterlappar, former, textrutor, ramar och kopplingslinjer. Det kan bara ändra de egenskaper som finns för varje objekttyp: om verktyget försöker ändra ett fält som inte hör till objektet eller ändra objekttypen avbryts ändringen och inget sparas. En grupp kan döpas om men inte få en ny stil. Bilder, ikoner och ritningar kan flyttas, ändra storlek på, roteras och läggas in i eller tas ut ur en ram eller grupp.

Kanbantavlor kräver försiktighet:

- Ett verktyg kan inte ändra ett kanbankort med det vanliga redigeringsverktyget. Det måste använda kortverktygen nedan. Det kan inte heller ändra kolumner eller etiketter med det vanliga redigeringsverktyget, utan använder kolumn- och etikettverktygen nedan. Det kan skapa en kanbantavla (se Skapa kanbantavlor nedan), men inte döpa om, ändra storlek på eller ta bort den. Gör det i appen.
- Ett verktyg kan inte ta bort en kanbantavla och kan bara ta bort en kolumn med kolumnverktyget nedan. Det kan ta bort ett kort som du kan se, som ligger i en kolumn och inte är låst. Ett kort som ägs av ett annat AI-verktyg kan inte tas bort av det här verktyget. Om ett kort är dolt eller innehåller privata sessionsanteckningar som du ännu inte kan se svarar verktyget som om kortet inte finns.
- Om du tar bort en grupp tas allt i den bort, även grupper, ramar och kanbantavlor i gruppen. Men ett enda låst objekt i gruppen stoppar hela borttagningen (”En medlem i den här gruppen är låst. Lås upp den för att ta bort gruppen.”). Privata anteckningar från en pågående session som ännu inte har visats lämnas kvar på tavlan.
- En borttagning som omfattar flera objekt genomförs helt eller inte alls. Kopplingslinjer som sitter fast i borttagna objekt tas också bort.
- Ett verktyg kan koppla samman kort och andra objekt, men inte en kolumn eller själva kanbantavlan. En ny eller ändrad kopplingslinje som slutar vid en kolumn eller kanbantavla avvisas. Befintliga kopplingslinjer påverkas inte.
- Text som ett verktyg skriver håller ihop emoji som består av flera delar, till exempel familjer och flaggor för England, Skottland och Wales. Dolda tecken tas fortfarande bort.

## Se en agent arbeta

När ett verktyg med åtkomsttoken ändrar en tavla kan alla på tavlan se det:

- **Markör och avatar.** En kort stund efter varje ändring visas verktyget som i arbete: en markör som bär namnet på medlemmen det arbetar åt (till exempel "Adas agent"), med tokenens namn i citattecken efter, som rör sig dit där verktyget ändrar tavlan. I deltagarlistan har det en egen avatar med en gnista; välj den för att gå dit verktyget arbetar. Den som gått med via en anslutningskod ser bara att en agent arbetar, inte vems den är.
- **Agentutkast.** Det ett verktyg skapar är märkt **Agent draft** tills en person redigerar det eller markerar det och väljer **Accept draft** i egenskapspanelen (**Accept drafts** för flera).
- **Agentaktivitet.** I en arbetsyta med inloggning listar **Agent activity** i tavlemenyn vad varje agent gjort de senaste 7 dagarna, senaste först, som en kort rad som "created 6 sticky notes". Texter som personer skrivit visas aldrig. **Go there** tar dig till objekten. Tokenens namn visas i citattecken, skilt från medlemmens namn, så att en token inte kan se ut som en person.
- **Ångra anrop.** Ägare och redigerare kan välja **Revert** för att ta tillbaka ett anrop. Objekt anropet skapade tas bort och objekt det tog bort kommer tillbaka, men allt en person ändrat sedan lämnas som det är, och ett meddelande säger hur många som lämnades. Ett anrop kan återställas en gång, i 48 timmar; en mycket stor ändring, eller en äldre, säger varför den inte går att återställa.

## Daglig gräns och nya försök

I en arbetsyta med inloggning kan varje token (och varje OAuth-anslutning) göra 2 000 ändringar på tavlor per dag. Räkningen gäller objekt, inte anrop: att skapa 10 klisterlappar i ett anrop räknas som 10. Den nollställs vid midnatt UTC, och ett verktyg som når gränsen får veta att den dagliga gränsen är nådd och när den nollställs. Läsning begränsas inte på det sättet, och det gör inte ärenden heller. Den som driver din server kan ändra talet eller stänga av gränsen.

Ett AI-verktyg kan fråga vem det agerar som och se hur många ändringar det har använt i dag och när räkningen nollställs.

Om ett svar går förlorat kan ett verktyg göra om ett skapa- eller kommentarsanrop med samma begäran-id. Det första resultatet skickas då igen i 24 timmar, och inget skapas eller räknas två gånger.

## Kanbankort från ett AI-verktyg

Ett verktyg med en token kan arbeta med kort på en [kanbantavla](kanban.md) och med vanliga objekt. Verktygen är:

| Verktyg | Vad det gör | Kräver |
|---|---|---|
| `list_kanban_cards` | Listar kanbantavlans kort i ordning: rubrik, beskrivning, kolumn, fas, ansvarig, förfallodatum, länk och etikettnamn, samt synliga kolumner med fas, gräns för pågående arbete och antal kort | Endast läsning eller högre |
| `add_kanban_card` | Lägger till ett kort i en kolumn eller i den första kolumnen med en fas (att göra, pågår eller klart) | Läsa och redigera |
| `update_kanban_card` | Ändrar kortets rubrik, beskrivning, förfallodatum, etiketter, länk eller ansvarig | Läsa och redigera |
| `move_kanban_card` | Flyttar ett kort till en annan kolumn eller till den första kolumnen med en fas | Läsa och redigera |

Ett verktyg kan bara använda etiketter som finns på tavlan, högst 10 per kort (det kan skapa etiketter med etikettverktygen nedan). Det måste ange kolumnen eller fasen, inte båda.

Det här får ett verktyg lägga till på ett kort:

- En **rubrik** på högst 200 tecken och en **beskrivning** på högst 4 000 tecken.
- Ett **förfallodatum** som är ett giltigt kalenderdatum och skrivs till exempel `2026-11-05`.
- En **länk** som är en webbadress som börjar med `http://` eller `https://`, är högst 2 000 tecken och saknar blanksteg, användarnamn och lösenord. Andra typer av länkar, till exempel `javascript:`, avvisas och inget kort skapas.
- En **ansvarig**: ett personnamn eller verktyget självt som AI-verktyg. Ett verktyg kan inte tilldela ett kort till en persons konto. Kort som ägs av ett verktyg har en åttasidig bricka, och bara den tokenen kan ändra vem som äger kortet.

En kolumn som blockerar pågående arbete avvisar ett nytt eller flyttat kort om den är full, och ett låst kort kan inte ändras. Alla på tavlan ser korten direkt. De skapas utanför ångra-funktionen, precis som andra ändringar som verktyg gör, så ta bort ett misstag med **Delete** (Ta bort) på kortet eller be verktyget ta bort det (ett verktyg kan ta bort ett kort som en person har skapat, men inte ett kort som ägs av ett annat AI-verktyg). Kort som skapas på det här sättet får sin riktiga höjd när en redigerare har tavlan öppen. Om bara läsare har tavlan öppen får korten en standardhöjd, så en etikett eller ett datum kan se avklippt ut tills en redigerare öppnar tavlan.

### Kolumner och etiketter

Med åtkomstnivån **Read and edit** kan ett verktyg också ställa in kanbantavlans kolumner och etiketter.

| Verktyg | Vad det gör |
|---|---|
| `create_kanban_label` | Lägger till en etikett med ett namn (1 till 40 tecken, dubbletter räknas inte om de bara skiljer sig åt i versaler och gemener) och en färg: ett palettnamn eller en hexkod med `#`. Om ingen färg anges används den första oanvända palettfärgen. En tavla kan ha högst 30 etiketter |
| `update_kanban_label` | Byter namn på en etikett eller ändrar dess färg |
| `delete_kanban_label` | Tar bort en etikett, tar bort den från alla kort som har den och anger hur många kort som ändrades |
| `add_kanban_lane` | Lägger till en kolumn med ett namn (1 till 60 tecken), eventuellt en fas (att göra, pågår eller klart), en gräns för pågående arbete (1 till 99), om gränsen ska blockera och var kolumnen ska placeras i ordningen. En kanbantavla kan ha högst 20 kolumner, även dolda |
| `update_kanban_lane` | Byter namn på, ändrar fas på, ordnar om eller döljer en kolumn samt anger eller tar bort dess fas och gräns. Ett verktyg kan inte visa en dold kolumn igen eftersom den är osynlig för verktyget. Gör det i appen. |
| `delete_kanban_lane` | Tar bort en kolumn. Om kolumnen innehåller kort måste du ange en kolumn att flytta dem till. Korten läggs i ordning sist i den kolumnen, även kort som ägs av ett annat AI-verktyg |

Regler som gäller:

- En blockerande gräns måste ha ett värde. Det går att sänka gränsen under antalet kort som redan finns i kolumnen, och verktyget får då veta att gränsen har överskridits.
- En låst kolumn kan inte ändras, och kolumner i en låst kanbantavla kan inte ordnas om.
- Den sista synliga kolumnen kan inte döljas eller tas bort.
- En kolumn kan inte tas bort om den innehåller ett låst kort eller om kolumnen som skulle ta emot korten blockerar och skulle överskrida sin gräns.
- Dolda kolumner och privata kort ger samma svar som om de inte fanns.

### Skapa kanbantavlor och ordna kort

Ett verktyg kan skapa en kanbantavla med `create_kanban`: ett namn på högst 80 tecken och, om du vill, en lista med 1 till 20 kolumner som var och en har en fas, en gräns för pågående arbete och en inställning för om gränsen blockerar. Om du inte anger en lista skapas kolumnerna **Att göra**, **Pågår** och **Klart**. Verktyget kan ange en position eller placera kanbantavlan till höger om det som redan finns på tavlan. Det kan också lägga den i en ram eller grupp som inte är låst. En tavla kan ha högst 50 kanbantavlor.

Med `add_kanban_card` och `move_kanban_card` kan du ange var kortet ska hamna i kolumnen: först eller efter ett visst kort. `add_kanban_cards` och `move_kanban_cards` hanterar 1 till 25 kort i ett anrop, antingen alla eller inga. Gränserna för pågående arbete räknas kort för kort i ordning, och ett fel anger vilket kort som orsakade det (till exempel det fjärde kortets rubrik). Om du placerar om ett kort i en kolumn som redan är full räknas det inte mot gränsen.

## Logga in med OAuth

I dag ansluter ett verktyg med en token, som ovan. Det går snart att ansluta från verktygets egen vy för **Add connector** (Lägg till anslutning) med OAuth, men det är inte tillgängligt än. Tills vidare använder du kommandot eller inställningsfilen från tokendialogrutan.

## Hantera dina token

**AI tool access** listar dina token med namn, nivå, tavlor, giltighetstid och när varje token senast användes. Listan visar också tokenens fyra sista tecken så att du kan skilja dem åt.

- **Revoke** (Återkalla) stoppar en token. Klicka två gånger för att bekräfta.
- **Revoke all** (Återkalla alla) stoppar alla token du äger.
- Du kan ha högst 20 aktiva token.

Återkallandet börjar gälla vid verktygets nästa förfrågan. Om du loggar ut från Tabula återkallas inte token, så återkalla en token när du slutar använda ett verktyg.

Arbetsytans ägare och administratörer kan se och återkalla allas token i avsnittet **Access tokens** i [adminpanelen](admin.md). Om arbetsytan är skrivskyddad kan du inte skapa token, men du kan fortfarande återkalla dem.

## Relaterat

- [Dela, roller och team](sharing.md)
- [Adminpanelen](admin.md)
- [Kommentarer](comments.md)
- [Sessioner och fokusbegäranden](sessions.md)
