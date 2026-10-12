# Adminpanelen

Administratörspanelen är till för arbetsytans ägare och administratörer. Här ser du vilka som finns i arbetsytan, vad de har åtkomst till, vilka som är inloggade, vad som har ändrats och hur AI-funktionerna är konfigurerade. Ägare kan också återställa förlorat arbete från säkerhetskopior. Panelen finns bara i arbetsytor med inloggning. Vissa avsnitt är bara till för ägare.

## Öppna panelen

Använd något av följande:

- **Admin** (Administratör) i hemskärmens övre fält.
- **Admin** under **Account** (Konto) i tavlans meny.
- Adressen `#/admin`.

Medlemmar och gäster ser inte de här länkarna. Om de öppnar adressen skickas de tillbaka till hemskärmen. Avsnittet **Backups** (Säkerhetskopior) är bara till för ägare. Administratörer ser det inte, och adressen visar dem **Overview** (Översikt). Använd pilen uppe till vänster för att gå tillbaka till **Boards** (Tavlor).

På vänster sida finns en lista med avsnitt. Adressen ändras med avsnittet, så om du läser in sidan igen eller går tillbaka kommer du till samma avsnitt.

## Åtgärder på rader kräver två klick

Åtgärder som tar bort åtkomst eller data (**Disable** (Inaktivera), **Remove** (Ta bort), **Sign out everywhere** (Logga ut överallt), **Archive** (Arkivera), **Delete** (Radera), **Revoke** (Återkalla)) bekräftas med två klick. Efter det första klicket ändras knappen till **Click again** (Klicka igen). Klicka igen för att utföra åtgärden. Om du flyttar pekaren från knappen återställs den, och inget händer.

Knappar som du inte får använda är inaktiverade. Håll pekaren över dem för att se varför. Bara en ägare kan utföra åtgärder för en annan ägare. Den sista ägaren kan inte ges en lägre roll, inaktiveras eller tas bort.

Efter varje åtgärd uppdateras raden direkt och ett kort meddelande bekräftar det.

## Översikt

Antal för hela arbetsytan:

- **Members** (Medlemmar), uppdelade efter roll, och **Disabled members** (Inaktiverade medlemmar).
- **Teams** (Team), med antal arkiverade team.
- **Boards** (Tavlor), med antal borttagna tavlor.
- **Active sessions** (Aktiva sessioner) och **Sign-ins, last 7 days** (Inloggningar, senaste 7 dagarna).
- **Live connections** (Aktiva anslutningar), med antal tavlor som är öppna just nu.

Under antalen visar **Instance** (Instans) serveradressen, hur e-post skickas, versionen och om konton är aktiverade.

I en hostad arbetsyta ser ägaren också **Manage billing** (Hantera fakturering). Den öppnar faktureringsportalen i samma flik. Där kan du ändra abonnemang och betalningsmetod. Medan arbetsytan har en kostnadsfri provperiod ser ägaren också ”Kostnadsfri provperiod till” och slutdatumet bredvid. Administratörer som inte är ägare ser det inte. En arbetsyta som tillhandahålls utan kostnad (en komparbetsyta) har inget att fakturera. Därför visas i stället ”Den här arbetsytan tillhandahålls utan kostnad. Det finns inget att fakturera.” här och på fliken Backups.

<!-- screenshot: avsnittet Översikt med statistikrutorna och instanslistan -->

## Inställningar

I en hostad arbetsyta visar fliken **Settings** (Inställningar) **Automatic updates** (Automatiska uppdateringar). De är aktiverade som standard. Ägaren kan stänga av andra uppdateringar. Administratörer kan se inställningen men inte ändra den. **Security updates are always installed** (Säkerhetsuppdateringar installeras alltid), även när andra automatiska uppdateringar är avstängda. När du har sparat står det på sidan om inställningen sparades och om Tabula Cloud kunde nås.

## Medlemmar

En sökbar lista över alla med ett konto: namn, e-postadress, roll, senaste aktivitet, aktiva sessioner, antal tavlor de äger och team.

- Ändra någons **Role** (Roll) med menyn.
- **Disable** hindrar personen från att logga in och avslutar personens sessioner. **Enable** (Aktivera) tillåter inloggning igen.
- **Sign out everywhere** avslutar alla personens sessioner utan att inaktivera kontot. Du kan använda den på dig själv.
- **Remove** tar bort kontot, loggar ut personen och tar bort personens åtkomst.

Rollerna förklaras i [Dela, roller och team](sharing.md). En gratisarbetsyta har en gräns för hur många medlemmar den rymmer. När den är full nekas du att aktivera en person eller befordra en gäst med meddelandet ”This workspace has reached its member limit. Remove or disable a member to make room, or ask the workspace owner to write to us for a larger workspace.” (Den här arbetsytan har nått sin medlemsgräns. Ta bort eller inaktivera en medlem för att få plats, eller be arbetsytans ägare att kontakta oss för en större arbetsyta.) Gäster räknas inte mot gränsen.

## Team

Alla team, även arkiverade, visas med antal medlemmar. **Archive** döljer ett team från hemskärmen. Tavlorna är fortfarande tillgängliga. **Unarchive** (Avarkivera) visar teamet igen och kräver ingen bekräftelse.

Om du vill byta namn på ett team eller hantera dess medlemmar använder du **Manage** (Hantera) på hemskärmen.

## Tavlor

Alla tavlor i arbetsytan visas med titel, team (eller **Personal** (Personlig)) och tidpunkt för senaste redigering. Använd sökrutan för att filtrera efter titel.

- **Open** (Öppna) öppnar tavlan.
- **Delete** tar bort tavlan för alla som har åtkomst till den.
- Aktivera **Show deleted** (Visa borttagna) för att visa borttagna tavlor, markerade med **Deleted** (Borttagen). Välj **Restore** (Återställ) för att få tillbaka en tavla. Återställning kräver ingen bekräftelse.

Som administratör kan du öppna en borttagen tavla och titta på den. Den öppnas skrivskyddad med märkningen **Deleted board** (Borttagen tavla) tills du återställer den.

## Sessioner

Varje rad är en inloggning. Den visar personen, när personen loggade in, när personen senast sågs och när sessionen går ut. **Revoke** avslutar en session och loggar ut den enheten. Din egen session är markerad **This session** (Den här sessionen), och knappen heter **Sign out** (Logga ut).

## Åtkomsttoken

Aktiva [personliga åtkomsttoken](ai-tools.md) för AI-verktyg i hela arbetsytan: vem token tillhör, dess namn och åtkomstnivå, vilka tavlor den gäller för, när den senast användes och när den går ut. **Create a token** (Skapa en token) högst upp skapar en åt dig (se [Åtkomsttoken och AI-verktyg](ai-tools.md)). **Revoke** återkallar en token direkt. Avsnittet visas bara när åtkomst till AI-verktyg har aktiverats för servern.

## AI

Fliken **AI** (Artificiell intelligens) aktiverar AI-funktioner för arbetsytan och ställer in vad de använder: funktionerna, modellen, om personer får använda egna nycklar, om gäster ingår, timgränserna och arbetsytans nyckel. Till skillnad från **Access tokens** (Åtkomsttoken) visas fliken **AI** alltid i en arbetsyta med inloggning, även om servern ännu inte kan lagra nycklar.

När du aktiverar AI och väljer funktioner blir de tillgängliga för personer som kan redigera en tavla, så länge det finns en användbar nyckel (arbetsytans nyckel eller en personlig nyckel där du tillåter sådana). Utan nyckel visas inte AI-knappen. Se [AI-fältet](ai-bar.md) för vad personer ser.

Fliken har följande inställningar. Som standard är allt avstängt, alla funktioner är valda, personliga nycklar är avstängda, gäster tillåts och gränserna är 20 körningar per person och 200 per arbetsyta varje timme.

- **Allow AI features in this workspace** (Tillåt AI-funktioner i den här arbetsytan): aktiverar eller inaktiverar AI.
- **Features** (Funktioner): **Generate stickies** (Skapa lappar), **Summarise** (Sammanfatta) och **Cluster stickies** (Gruppera lappar). Välj vilka personer som får använda dem.
- **Model** (Modell): **Claude Opus 5.5** (standard), **Claude Sonnet 5.5** eller **Claude Haiku 5.5**, för en Anthropic-nyckel. Med en OpenAI-kompatibel nyckel ingår modellen i nyckeln (nedan). Då ersätts den här inställningen med en skrivskyddad rad med namnet **Model**, som säger att modellen kommer från nyckeln.
- **Personal keys** (Personliga nycklar): **People can add a key of their own, which they use instead of the workspace key** (Personer kan lägga till en egen nyckel som de använder i stället för arbetsytans nyckel). När det här är avstängt används bara arbetsytans nyckel.
- **Guests** (Gäster): **Members only: guests cannot use AI features or add a key** (Endast medlemmar: gäster kan inte använda AI-funktioner eller lägga till en nyckel). Aktivera detta för att neka gäster åtkomst.
- **Runs per person per hour** (Körningar per person och timme) och **Runs per workspace per hour** (Körningar per arbetsyta och timme): heltal från 1 till 1 000 respektive från 1 till 10 000.

Välj **Save settings** (Spara inställningar) för att spara. Knappen är aktiverad bara när något har ändrats och båda gränserna är giltiga. Om en gräns inte är ett heltal inom intervallet beskriver sidan problemet. Efter varje sparning visas **AI settings saved** (AI-inställningarna har sparats).

### Arbetsytans nyckel

Arbetsytans nyckel används av alla som inte har en egen nyckel. Utan en sådan kan bara personer med en personlig nyckel köra AI-funktioner.

1. Välj **Provider** (Leverantör): **Anthropic** eller **OpenAI-compatible** (OpenAI-kompatibel; NVIDIAs katalog, OpenAI, OpenRouter eller en egen modellserver). För OpenAI-kompatibelt väljer du också **Base URL** (Bas-URL) (`https://…`, en offentlig adress) och **Model**. Klistra sedan in API-nyckeln. Om en nyckel redan har sparats står det **Replace with a new key** (Ersätt med en ny nyckel) i fältet.
2. Välj **Save key** (Spara nyckel), eller **Replace key** (Ersätt nyckel) om en nyckel redan har sparats.

Leverantören kontrollerar nyckeln innan något sparas. Medan den kontrolleras står det **Checking…** (Kontrollerar …) på knappen. Om kontrollen misslyckas sparas inget, meddelandet förklarar varför och nyckeln ligger kvar i fältet så att du kan rätta ett skrivfel. När nyckeln har sparats visas **Workspace key saved** (Arbetsytans nyckel har sparats).

Efter att du har sparat visas bara nyckelns fyra sista tecken, till exempel **Anthropic key ending …a1b2** (Anthropic-nyckel som slutar på …a1b2), samt när nyckeln lades till och senast användes. Hela nyckeln visas aldrig igen. Om du vill ändra den klistrar du in en ny och väljer **Replace key**. Om du vill ta bort den väljer du **Remove**, sedan **Click again to remove** (Klicka igen för att ta bort).

Välj **Test key** (Testa nyckel) bredvid **Remove** för att kontrollera om den sparade nyckeln fortfarande fungerar. Kontrollen ändrar inte nyckeln eller datumet för ”senast använd”. Den visar ett kort resultat under nyckeln. Tester räknas in i samma timgräns som när du sparar en nyckel och registreras i granskningsloggen utan själva nyckeln.

Om servern inte längre kan läsa den sparade nyckeln visas en varning på fliken. Ange nyckeln igen för att lösa problemet.

Om det står på fliken att servern inte kan lagra nycklar kan du fortfarande ändra inställningarna ovan, men ingen nyckel kan sparas förrän den som sköter Tabula-servern har åtgärdat problemet. Be personen att göra det.

Information om egna nycklar finns i [Din AI-nyckel](ai-keys.md).

<!-- screenshot: AI-fliken med inställningarna och raden för arbetsytans nyckel som visar de fyra sista tecknen -->

## Chatt

Fliken **Chat** (Chatt) visas när chatten är på. Den är på som standard i arbetsytor med inloggning, om inte den som driver servern har stängt av den. Varje inställning sparas direkt när du ändrar den.

- **Workspace channel** (Arbetsytans kanal): om alla utom gäster ska ha en gemensam chatt för hela arbetsytan. Stäng av den så försvinner kanalen från chattsidan tills du aktiverar den igen. Inget tas bort.
- **Viewers** (Läsare): om personer med skrivskyddad åtkomst till en tavla får skriva i dess chatt. De kan alltid läsa den.
- **Keep messages** (Spara meddelanden): **1 year** (1 år; standard), **90 days** (90 dagar), **30 days** (30 dagar) eller **Forever** (För alltid). En gång om dagen tas äldre meddelanden bort, tillsammans med omnämnanden och reaktioner. Säkerhetskopior behåller borttagna meddelanden tills säkerhetskopiorna går ut.

Granskningsloggen har filtret **Chat** (Chatt). Det visar ändringar i de här inställningarna, meddelanden som en ägare eller moderator har tagit bort och den dagliga rensningen som en rad med antal. Den visar aldrig vad ett meddelande innehöll.

<!-- screenshot: Chattfliken med de tre inställningarna -->

## Säkerhetskopior

Avsnittet **Backups** är till för arbetsytans ägare. Säkerhetskopior är kopior av allt i arbetsytan. De lagras separat från servern och krypteras innan de skickas iväg. Här kan du se hur det går och återställa en tavla eller hela arbetsytan.

Bara ägare ser fliken **Backups** (Säkerhetskopior). Den ligger mellan **Chat** (Chatt) och **Settings** (Inställningar). Administratörer som inte är ägare ser den inte, och dess adress visar dem **Overview** (Översikt). När säkerhetskopior är avstängda står det **Not set up** (Inte konfigurerat). På en server du själv kör länkar sidan hit: aktivera säkerhetskopior med inställningarna nedan och starta sedan om servern.

### Aktivera säkerhetskopior

Gäller bara en server du själv kör. Säkerhetskopior är aktiverade när alla de här fem inställningarna har angetts:

- `TABULA_BACKUP_S3_ENDPOINT`: lagringens adress, till exempel en Tigris-, Cloudflare R2-, Backblaze B2-, MinIO- eller AWS S3-slutpunkt.
- `TABULA_BACKUP_BUCKET`: lagringsbehållaren.
- `TABULA_BACKUP_ACCESS_KEY` och `TABULA_BACKUP_SECRET_KEY`: inloggningsuppgifterna till lagringsbehållaren.
- `TABULA_BACKUP_KEY`: krypteringsnyckeln, 32 slumpmässiga byte som 64 hexadecimala tecken. Skapa en med `openssl rand -hex 32`.

**Om du tappar bort nyckeln kan ingen läsa säkerhetskopiorna.** Spara en kopia någon annanstans än på servern. De andra inställningarna (hur ofta säkerhetskopior tas, hur länge de sparas och hur nyckeln byts) beskrivs i serverdokumentationen, `docs/backups.md` i Tabula-repot.

### När säkerhetskopior tas

Säkerhetskopior tas enligt ett schema (statusen visar hur ofta). De tas också en kort stund efter att personer har slutat redigera: ungefär två minuter efter den senaste ändringen och senast tio minuter efter den första ändring som ännu inte finns i en säkerhetskopia. När servern får en begäran om att stängas av, till exempel när en inaktiv hostad arbetsyta stängs ned, tas en sista snabb säkerhetskopia av det som har ändrats. Därför går ett kort besök inte längre förlorat mellan två schemalagda säkerhetskopior.

En krasch eller en avstängning utan förvarning kan fortfarande göra att de senaste minuterna av ändringar saknas i säkerhetskopiorna. Serverns data påverkas inte.

### Status och lista

Längst upp i avsnittet visas den senaste säkerhetskopian och om den lyckades, hur många säkerhetskopior i följd som har misslyckats, när nästa tas, hur ofta de tas, nyckelns korta id och hur mycket lagring som används. En mening under det beskriver hur den senaste återställningen avslutades och när.

Nedanför finns listan, med de nyaste först. Varje rad visar tidpunkten (UTC och hur länge sedan), antal filer, storlek, nyckel och en anteckning:

- **Protected until** (Skyddad till) ett visst datum: säkerhetskopian kan inte tas bort vid den vanliga rensningen före det datumet. En säkerhetskopia som du återställer och säkerhetskopian som tas före en helåterställning skyddas i sju dagar.
- **Unreadable** (Kan inte läsas) och orsaken: säkerhetskopian är grå och kan inte öppnas, till exempel om den krypterades med en nyckel som servern saknar eller om integritetskontrollen misslyckades.

Listan visar högst 200 säkerhetskopior. Välj **Details** (Detaljer) på en rad för att öppna säkerhetskopian. Använd **Back to the backup** (Tillbaka till säkerhetskopian) för att gå tillbaka från skärmarna nedan.

### En säkerhetskopia

Säkerhetskopian öppnas på samma plats. Här ser du när den skapades, Tabulas version, hur många filer och tavlor den innehåller, dess storlek och nyckel, om det finns utrymme på servern för att återställa allt och hur länge aktuella data skulle sparas efteråt. Det finns två åtgärder:

- **Restore a board as a copy** (Återställ en tavla som kopia) lägger till en tavla från säkerhetskopian i arbetsytan som en ny tavla. Inget annat ändras.
- **Restore the whole workspace** (Återställ hela arbetsytan) ersätter allt med innehållet i säkerhetskopian.

### Återställ en tavla som kopia

Sök bland säkerhetskopians tavlor efter titel eller team (bara de 500 senast redigerade tavlorna listas), välj en och välj **Make a copy** (Skapa en kopia). Den nya tavlan får namnet **Restored:** (Återställd:) följt av den gamla titeln och datumet. Du äger den, och den saknar versionshistorik. Tavlan du har nu påverkas inte. En länk till den nya tavlan visas när kopian är klar.

Kopian placeras i tavlans ursprungliga team om teamet fortfarande finns och du tillhör det. Annars placeras den i ditt personliga utrymme, och sidan talar om det. En tavla utan sparat innehåll i säkerhetskopian kan inte kopieras. Du kan skapa fler kopior från samma säkerhetskopia. Om en hostad arbetsyta är skrivskyddad är knappen inaktiverad och förklarar varför.

### Återställ hela arbetsytan

Det här ersätter personer, team, tavlor, kommentarer, versionshistorik och inställningar med innehållet i säkerhetskopian. Innan du kan fortsätta visar sidan vad som kommer att hända:

- Alla loggas ut och måste logga in igen. Åtkomsttoken och inbjudningslänkar återkallas.
- Arbetsytan är otillgänglig i ungefär en minut medan servern startar om.
- Först skapas en säkerhetskopia av de aktuella uppgifterna. Om det misslyckas ändras inget.
- Aktuella data flyttas åt sidan, inte tas bort, och sparas i sju dagar. Om disken nästan är full sparas de till nästa lyckade säkerhetskopiering och i minst 24 timmar. Sidan talar om vilket som gäller och varför.
- Ändringar som gjordes efter att säkerhetskopian skapades finns inte i den. De finns bara i de gamla data som sparas vid sidan.

Skriv `RESTORE` med versaler och utan mellanslag och välj **Restore this backup** (Återställ den här säkerhetskopian). Knappen är inaktiverad tills ordet är exakt rätt och medan det inte finns tillräckligt med ledigt diskutrymme på servern. Sidan talar om hur mycket utrymme som saknas. Bara en helåterställning kan startas under en period på tio minuter.

När servern godkänner åtgärden visar hela fönstret **Restoring…** (Återställer …). Sidan kontrollerar servern med några sekunders mellanrum och läses in igen när servern är igång. Sedan loggar alla in igen. Om servern inte är igång efter tre minuter säger sidan att det tar längre tid än väntat. Välj **Check again** (Kontrollera igen) för att börja om eller läs in sidan igen. En tavla som är öppen när en återställning startar visar också **Restoring…** och läses in igen på samma sätt. När du har loggat in igen kommer du tillbaka till tavlan.

Om något misslyckas före bytet ändras inget, och sidan förklarar det med tydliga ord, till exempel att diskutrymmet inte räcker eller att säkerhetskopian av de aktuella uppgifterna misslyckades. Om hela arbetsytan inte kan återställas startar servern igen med de data som fanns före återställningen.

> Gör en provåterställning innan du behöver en. En säkerhetskopia som du aldrig har återställt har inte bevisats fungera.

![Fliken Säkerhetskopior med statusrutan och listan över säkerhetskopior, en skyddad och två som inte kan läsas](images/admin-backups.png)

## Privacy

Fliken **Privacy** (Integritet) visar vad Tabula samlar in om hur arbetsytan används, och låter ägaren ändra det. Administratörer kan läsa den; bara ägaren kan ändra inställningen.

- På en hostad arbetsyta är **Product analytics** (Produktanalys) på som standard, och ägaren kan stänga av det. Det skickar antal och varaktigheter för användning av funktioner till Tabula så att vi kan se vad som används och förbättra det, till exempel öppnade tavlor, genomförda omröstningar, timers, AI-körningar och antal chattmeddelanden, samt grova klasser av enhet, webbläsare och operativsystem. Driftdata finns kvar oavsett. Vi behöver den för att köra, säkerhetskopiera och laga din arbetsyta: antal och varaktigheter för förfrågningar, antal anslutningar, resursanvändning, arbetsytans storlek samt resultat av säkerhetskopieringar och återställningar.
- På en server du kör själv är den avstängd som standard. Reglaget heter **Send telemetry to Tabula** (Skicka telemetri till Tabula). När det är på förbereder din server rapporten en gång i timmen åt Tabula och åt ingen annan. När du slår på det får du först bekräfta.
- Allt du skriver eller laddar upp skickas aldrig: rubriker, text, kommentarer, chatt, filnamn, söktext och AI-prompter. Det gäller även allt som identifierar en person (namn, e-postadresser, id:n, IP-adresser, webbläsarsträngar), adresserna till ditt innehåll, felmeddelandetexter och uppgifter om ditt eget nätverk.
- **Show what would be sent** (Visa vad som skulle skickas) öppnar den exakta rapport som din arbetsyta skulle bygga, med en knapp **Copy** (Kopiera). Fliken visar också när en rapport senast förbereddes och vem som senast ändrade inställningen.
- Den här versionen förbereder bara rapporten. Inget har skickats än, och skickandet börjar i en senare version. Om du stänger av reglaget upphör insamlingen direkt.
- Om den som driver din server har ställt in miljövariabeln `TABULA_TELEMETRY` är reglaget låst, och fliken säger det.

Ändringar av inställningen registreras i [granskningsloggen](#granskningslogg) under **Privacy**.

## Granskningslogg

En lista över ändringar, med de nyaste först. Varje post är formulerad som en mening, till exempel vem som ändrade någons roll. Åtgärder som systemet utför självt, som meddelandet till arbetsytans ägare om att provperioden snart tar slut, visas med **System** (Systemet) som avsändare. Säkerhetskopior och återställningar beskrivs också i meningar, med säkerhetskopians datum. Håll pekaren över en post för att se det underliggande åtgärdsnamnet.

- Filtrera efter **All** (Alla), **Members** (Medlemmar), **Teams**, **Boards**, **Templates** (Mallar), **Invites** (Inbjudningar), **Sign-ins** (Inloggningar), **Sessions**, **AI**, **AI tool access** (Åtkomst till AI-verktyg), **Images** (Bilder), **Chat**, **Privacy**, **Backups** eller **Restores** (Återställningar). Filtret **AI** visar ändringar av AI-inställningarna och när nycklar läggs till, testas eller tas bort. **AI tool access** visar när åtkomsttoken skapas och återkallas (med deras namn, aldrig deras hemligheter). **Backups** visar automatiska säkerhetskopieringar (och misslyckanden, samt hur många skadade eller saknade filer som återställdes vid en körning) och när en ägare tittade på dem. **Restores** visar helåterställningar, kopior av tavlor och när de gamla data från en återställning togs bort, med datumet för säkerhetskopian de kom från.
- Välj **Load more** (Läs in fler) för att gå längre tillbaka.

Poster utan en person visas som utförda av systemet, till exempel när en hostad arbetsyta låses eller låses upp.

## Relaterat

- [Exportera och importera](export-import.md) för att spara en tavla själv
- [Dela, roller och team](sharing.md)
- [Åtkomsttoken och AI-verktyg](ai-tools.md)
- [Din AI-nyckel](ai-keys.md)
