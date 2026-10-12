# Dela, roller och team

Vem som kan öppna en tavla beror på hur Tabula-servern är konfigurerad. I öppet läge kan alla med en länk till tavlan ansluta. I en arbetsyta med inloggning har personer konton, och rollerna avgör vem som kan öppna, kommentera på eller redigera varje tavla.

## Öppet läge och arbetsytor

I **öppet läge** finns inga konton. Du delar en tavla genom att skicka länken till den. Alla som öppnar länken medan de är anslutna till samma server kan redigera tavlan tillsammans med dig i realtid. Varje webbläsare har sin egen lista med tavlor.

En **arbetsyta med inloggning** är en delad yta med medlemmar, team och behörigheter. Du loggar in med din e-postadress, och bara personer med åtkomst till en tavla kan öppna dess länk. Om du är osäker på vilken typ du använder tittar du i tavlans meny: om den har avsnittet **Account** (Konto) med ditt namn använder arbetsytan inloggning.

## Delningsdialogrutan

Välj **Share** (Dela) högst upp till höger på en tavla (eller synkroniseringsstatusen bredvid tavlans namn). Dialogrutan **Share this board** (Dela den här tavlan) visar tavlans länk med knappen **Copy link** (Kopiera länk).

- I öppet läge står det i dialogrutan om tavlan synkroniseras. Om servern inte går att nå eller synkronisering är avstängd finns tavlan bara på din enhet tills synkroniseringen fungerar igen.
- Med inloggning står det i dialogrutan att bara personer med åtkomst kan öppna länken. Skicka länken till personer som redan har åtkomst.
- Om du äger tavlan (arbetsytans ägare och administratörer räknas som ägare till alla tavlor) har dialogrutan också en lista över **People with access** (Personer med åtkomst). Läs [Ge en person eller ett team en roll](#ge-en-person-eller-ett-team-en-roll).

### Anslut till en tavla med en kod

Anslutningskoder är till för arbetsytor med inloggning: servern måste köras med konton och ha anslutningskoder påslagna (de är avstängda som standard; fråga serveransvarig). Då ser en **Owner** (Ägare) eller **Editor** (Redigerare) **Join code** (Anslutningskod) i dialogrutan **Share**. Välj gästens roll (**Commenter** (Kommentatör) eller **Editor**), hur länge koden ska gälla (3 timmar som standard, högst 24 timmar) och hur många personer som kan använda den (100 som standard, högst 1 000), och skapa sedan koden. Koden visas en gång tillsammans med en länk att kopiera. Håll den privat, eftersom alla som har den kan ansluta tills den upphör att gälla eller återkallas.

En gäst öppnar länken, anger ett visningsnamn och ansluter till just den tavlan utan konto. Gästen kommer inte åt något annat i arbetsytan. Gäster märks som **Guest** (Gäst) bredvid sina namn i närvaron och i kommentarer. Välj **Revoke** (Återkalla) för en kod om du vill avsluta den och alla gästsessioner som skapats med den. Om servern stänger av anslutningskoder loggas gästerna ut.

### Ge en person eller ett team en roll

1. Öppna **Share** på tavlan.
2. Under **People with access** väljer du en person eller ett team från **Add a person or team** (Lägg till en person eller ett team). Du kan välja personer från dina team (arbetsytans ägare och administratörer kan välja vem som helst) och alla dina team.
3. Välj **Editor**, **Commenter** eller **Viewer** (Läsare). **Viewer** är standardvalet. En kort rad under listan beskriver vad varje roll kan göra.
4. Välj **Add** (Lägg till).

Varje rad har en rollmeny som sparar ändringen direkt och en knapp **Remove** (Ta bort) (välj den två gånger för att bekräfta). Ändringarna når genast personer som redan har tavlan öppen. Den som förlorar sin åtkomst ser en banderoll och behåller sin kopia på sin egen enhet.

När du lägger till ett team får alla medlemmar i det teamet rollen, såvida de inte redan har en högre roll. Om du vill bjuda in någon som ännu inte finns i arbetsytan skickar du i stället en teaminbjudan (se nedan).

### Låt en gäst ansluta med en kod

Arbetsytor kan aktivera **Join code** i dialogrutan Share för tavlans redigerare och ägare. Serveransvarig aktiverar funktionen med `TABULA_JOIN_CODES=on`, och den fungerar bara på en server som körs med konton (inloggning); den är avstängd som standard. Skapa en kod för en **Commenter** eller **Editor** och välj sedan när den upphör att gälla (högst 24 timmar) och hur många gånger den kan användas. Koden visas en gång tillsammans med en länk som du kan kopiera. Skicka den bara till personer som du vill ska få tillgång till tavlan.

Gästen öppnar **Join with a code** (Anslut med en kod), anger ett visningsnamn och ansluter utan konto. Gästens session upphör att gälla samtidigt som koden, och åtkomsten gäller bara den tavlan. En kommentatör kan läsa och kommentera. En redigerare kan redigera och lägga till bilder inom tavlans vanliga bildbegränsningar. De kan inte öppna andra tavlor eller använda arbetsytans, administratörens, chattens, AI-verktygens eller MCP:s API:er. Om anslutningskoder stängs av på servern, om arbetsytan återställs från en säkerhetskopia eller flyttas till en annan volym upphör gästsessionerna också och alla koder återkallas. När en gästs kod har upphört att gälla eller återkallats förblir tavlan öppen för att titta på men tar inte längre emot ändringar, och bannern erbjuder **Sign in** (Logga in), som avslutar gästsessionen. Visningsnamnet ska vara 1 till 40 tecken; ett tomt eller för långt namn nekas med ett meddelande.

![Dialogrutan Dela den här tavlan med teamet Design som redigerare och Ana som kommentatör, med raden Lägg till en person eller ett team nedanför](images/share-roles.png)

Skärmbilderna visar gränssnittet på engelska.

## Logga in

![Tabulas inloggningssida med ett e-postfält och knappen Mejla mig en länk](images/signin.png)

1. Öppna arbetsytans adress. På inloggningssidan ombeds du ange din e-postadress.
2. Ange den och välj **Email me a link** (Mejla mig en länk).
3. Öppna mejlet och följ länken. Den fungerar en gång och upphör att gälla efter 15 minuter.

Om länken har upphört att gälla begär du en ny. Den första personen som loggar in med ägaradressen blir arbetsytans ägare. Alla andra behöver en inbjudan eller ett konto som en administratör redan har skapat.

Om du vill logga ut öppnar du tavlans meny och väljer **Sign out** (Logga ut) under **Account**, eller öppnar ditt namn i startskärmens övre fält och väljer **Sign out**. **Sign out everywhere** (Logga ut överallt) avslutar alla dina sessioner på alla enheter.

Under **Your name and colour** (Ditt namn och din färg) i tavlans meny kan du ändra namnet som visas bredvid pekaren. Om du har ett konto sparas namnet på kontot. Färgen sparas på den här enheten. Om du ansluter med en gästlänk kommer ditt namn från anslutningsformuläret; tavlans meny döljer **Your name and colour** och **Save board as template**. Gästnamn har märket **Guest** (Gäst) bredvid sig i pekaretiketter och kommentarer.

## Roller

Det finns tre sorters roller.

### Arbetsytans roller

| Roll | Vad den innebär |
|---|---|
| **Owner** | Leder arbetsytan. Har full åtkomst till alla tavlor och [adminpanelen](admin.md). |
| **Admin** (Administratör) | Har samma åtkomst som ägaren till tavlor och medlemmar. Bara en ägare kan ändra en annan ägare. |
| **Member** (Medlem) | Kan skapa tavlor och team samt öppna tavlor som personen har åtkomst till. |
| **Guest** (Gäst) | Ser bara tavlor som har delats med personen. Kan inte skapa team. |

Arbetsytans ägare och administratörer kan öppna alla tavlor i arbetsytan. Dessa tavlor visas under **Other boards** (Andra tavlor) på startskärmen.

### Teamroller

Ett team samlar personer och tavlor. Inom ett team är du antingen **Member** eller **Admin**.

- Teammedlemmar kan redigera teamets tavlor.
- Teamadmins kan också bjuda in och ta bort personer, byta namn på teamet och arkivera det.

### Tavlans roller

Varje person har en roll per tavla, och den högsta roll som gäller avgör åtkomsten.

| Roll | Kan göra |
|---|---|
| **Owner** | Allt på tavlan, även ta bort den. |
| **Editor** | Redigera tavlan och kommentera. Kan lösa alla kommentarstrådar, men bara ta bort sina egna kommentarer. |
| **Commenter** | Läsa tavlan och lägga till [kommentarer](comments.md). Kan lösa och ta bort sina egna kommentarer. Kan inte ändra tavlan. |
| **Viewer** | Bara läsa. Pekare visas ändå. |

Du äger tavlor som du skapar. Medlemmar i ett team kan redigera dess tavlor. Arbetsytans ägare och administratörer äger alla tavlor.

På startskärmen markerar kolumnen **Access** (Åtkomst) tavlor där din åtkomst är begränsad: **Can comment** (Kan kommentera) eller **View only** (Endast visning). Tavlor som du kan redigera har ingen bricka. Bredvid tavlans namn ser kommentatörer brickan **Can comment** och läsare brickan **View only**. Ritverktygen är inaktiverade och textredigering startar inte. Kommentatörer kan fortfarande kommentera.

## Team

Med inloggning grupperas tavlorna i avsnitt på startskärmen.

- Ett avsnitt för varje team du tillhör.
- **Personal** (Personligt): tavlor som du äger och som inte tillhör något team.
- **Shared with you** (Delat med dig): andra tavlor som du kan öppna (**Other boards** för arbetsytans ägare och administratörer).
- **On this device** (På den här enheten): tavlor som bara finns i din webbläsare. Välj **Add to workspace** (Lägg till i arbetsyta) och välj **Personal** eller ett team för att flytta en tavla till servern.

### Skapa ett team

1. Välj **New team** (Nytt team) på startskärmen. Gäster ser inte den här knappen.
2. Ange ett teamnamn och välj **Create team** (Skapa team). Du blir teamets administratör.

Om du vill starta en tavla i ett team väljer du **New board** (Ny tavla) i teamets avsnitt.

### Hantera ett team

Välj **Manage** (Hantera) i teamets avsnitt. Teamadministratörer och arbetsytans administratörer kan:

- Byta namn på teamet (**Save** (Spara)).
- Ändra en persons roll i rollmenyn eller ta bort personen med papperskorgsikonen.
- Skapa en inbjudningslänk och återkalla aktiva länkar.
- Arkivera teamet under **Danger zone** (Riskzon). Dess tavlor är fortfarande tillgängliga för personer som hade åtkomst, men teamet försvinner från startskärmen.

Alla medlemmar kan välja **Leave team** (Lämna teamet). Då förlorar du åtkomsten till teamets tavlor. Tavlor som har delats direkt med dig fortsätter att vara delade. Den sista administratören kan inte lämna teamet. Gör först någon annan till administratör.

### Bjud in personer

1. Under **Manage** väljer du **Member** eller **Admin** under **Invite link** (Inbjudningslänk).
2. Välj **Expires after** (Upphör efter): 1, 7, 14 eller 30 dagar.
3. Välj **Create invite link** (Skapa inbjudningslänk) och sedan **Copy** (Kopiera).

Alla med länken som bekräftar sin e-postadress kan ansluta till teamet. På inbjudningssidan visas teamnamnet och knappen **Join team** (Gå med i teamet). Om arbetsytan har en gräns för hur många medlemmar den rymmer och den är full, avvisas inbjudan tills någon har tagits bort eller inaktiverats. Gäster räknas inte mot gränsen.

### Arbetsytans medlemmar

Ägare och administratörer väljer **Members** (Medlemmar) på startskärmen för att ändra roller i arbetsytan, **Disable** (Inaktivera) eller **Enable** (Aktivera) en person eller ta bort personen. En medlem som tas bort loggas ut överallt och förlorar åtkomsten direkt. Personens lokala kopior finns kvar på dess enheter. En mer utförlig lista finns på [adminpanelen](admin.md).

## När din åtkomst ändras

![Banderollen som säger att din åtkomst till tavlan har tagits bort, med Ta bort från den här enheten](images/access-removed.png)

Servern kontrollerar åtkomsten medan du arbetar, så en ändring gäller även en tavla som redan är öppen.

- **Nedgraderad till läsare eller kommentatör**: servern slutar genast godta dina ändringar på tavlan. Läs in tavlan igen för att se den i skrivskyddat läge.
- **Åtkomst borttagen**: en banderoll visar ”Din åtkomst till den här tavlan har tagits bort. Din kopia finns kvar på den här enheten.” Välj **Remove from this device** (Ta bort från den här enheten) (klicka två gånger för att bekräfta) eller stäng banderollen.
- **Utloggad**: meddelandet ”Din session har avslutats. Logga in igen för att fortsätta synkronisera den här tavlan.” visas. Välj **Sign in** (Logga in).
- **Ingen åtkomst eller tavlan hittades inte**: banderollen visar alternativet **Back to boards** (Tillbaka till tavlorna).

I samtliga fall raderas inget från din enhet. Synkroniseringsstatusen visar **Inloggning krävs** eller **Ingen åtkomst**, och dina ändringar fortsätter att sparas lokalt.

## Skrivskyddade arbetsytor

Arbetsytor som driftas av någon annan kan låsas, till exempel om en prenumeration löper ut. När en arbetsyta är skrivskyddad:

- Visas en smal banderoll ovanför startskärmen och tavlan. Om serveransvarig inte har angett något meddelande står det ”Den här arbetsytan är skrivskyddad.”
- Öppnas alla tavlor i skrivskyddat läge med brickan **Arbetsytan är skrivskyddad** i stället för **Endast visning**.
- Kan du inte skapa tavlor, bjuda in personer eller ändra roller. Du kan fortfarande läsa, logga in och logga ut.

Arbetsytans ägare kan återställa redigering från faktureringssidan (se [Adminpanelen](admin.md)). När arbetsytan går att redigera igen växlar öppna tavlor tillbaka automatiskt, och eventuella ändringar du har gjort under tiden skickas. Roller ändras inte: en läsare förblir läsare.

## Relaterat

- [Adminpanelen](admin.md)
- [Kommentarer](comments.md)
- [Tavlor och startskärmen](boards.md)
- [Åtkomsttoken och AI-verktyg](ai-tools.md)
