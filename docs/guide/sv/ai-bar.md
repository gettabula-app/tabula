# AI-verktygsfältet

I AI-verktygsfältet ber du AI att arbeta med tavlan: sammanfatta den, gruppera lappar eller skapa idéer. Fältet visas när AI är aktiverat för dig och du har en arbetsytenyckel, en tillåten personlig nyckel. En sparad personlig nyckel eller arbetsytenyckel används alltid först.

Om AI inte kan köras för dig visas inget AI-verktygsfält, ingen knapp, genväg eller menypost på tavlan. Arbetsytans ägare och administratörer konfigurerar AI under **Admin** (Administratör) → **AI** (Artificiell intelligens). Läsare och kommentatörer ser inte fältet, eftersom de inte kan lägga till det som AI föreslår. Se [Din AI-nyckel](ai-keys.md).

## Verktygsfältet

Fältet finns längst ned mitt på tavlan. Från vänster till höger innehåller det:

- Ett handtag som du kan flytta det med. Dra för att flytta det, eller dubbelklicka för att fästa det igen.
- **What the AI works on** (Vad AI arbetar med): markeringen (till exempel ”3 lappar”), **Visible area** (Synligt område), **Whole board** (Hela tavlan) eller **Prompt only** (Bara instruktionen), som inte skickar något innehåll från tavlan. Listan visar hur många lappar varje val omfattar.
- Instruktionsfältet, med en historikknapp för de senaste instruktionerna. Det är valfritt för **Summarise** (Sammanfatta) och **Cluster** (Gruppera). För **Generate** (Generera) är instruktionen själva begäran.
- Modellen och en uppskattning av kostnaden, till exempel ”Sammanfatta · ~1,3k token”. Välj det för att se vilken modell administratören valde, vem som kan se att du skickar en begäran och ”Ungefär 1 300 token skickas in. Svaret begränsas till 8 000. Det är en uppskattning, inte en faktura.”
- **Run** (Kör) och en knapp för att fälla ihop fältet.

Ovanför dem finns de tre åtgärderna som knappar: **Summarise**, **Cluster** och **Generate ideas** (Skapa idéer). När du väljer en aktiveras den, och fältet visar kostnaden. En rad längst ned beskriver vad som skickas och vem som betalar, till exempel ”Tre markerade lappar skickas till Anthropic. Arbetsytans nyckel används.” På en telefon tar fältet upp hela bredden, instruktionen får en egen rad, och modellen och kostnaden flyttas ned till raden längst ned.

Om du fäller ihop fältet visas en liten gnistknapp, **Ask AI** (Fråga AI). Välj den eller tryck på `Ctrl+K` (`Cmd+K` på Mac) för att öppna fältet igen.

## Be AI om hjälp

1. Öppna fältet med `Ctrl+K` (`Cmd+K` på Mac) eller `/`, eller välj **Summarise**, **Cluster** eller **Generate** i menyerna.
2. Välj vad AI ska arbeta med.
3. Välj en åtgärd eller skriv en begäran om att skapa idéer. Välj sedan **Run** eller tryck på `Enter`.

Medan AI arbetar visar fältet vad det gör, till exempel ”Sammanfattar 3 lappar …”, och knappen **Stop** (Stoppa). Du kan också stoppa genom att trycka på `Esc`. Inget ändras på tavlan förrän du lägger till resultatet.

Alla på tavlan ser att en körning pågår och sedan resultatet som en förhandsvisning på tavlan. Den är märkt ”Din AI-förhandsvisning” för dig och till exempel ”Anas AI-förhandsvisning” för andra. Redigerare kan lägga till eller kasta bort vilken förhandsvisning som helst. Den som agerar först vinner, och de andra får veta vem det var. En förhandsvisning kan hamna utanför den del av tavlan du tittar på. Välj **Show** (Visa) på förhandsvisningens etikett eller i fältet för att flytta vyn till din egen förhandsvisning. Vyn flyttas bara när du ber om det.

## Om något går fel

Ett meddelande visas i fältet i stället för instruktionen, och inget på tavlan ändras:

- **AI is unavailable** (AI är inte tillgängligt): fältet och dess ingångar från tavlan visas inte. Arbetsytans ägare och administratörer kan konfigurera AI under **Admin → AI**.
- **The key was rejected** (Nyckeln avvisades): ”AI-nyckeln avvisades. Be en administratör för arbetsytan att kontrollera den.”
- **Too many requests** (För många begäranden): ”För många begäranden. Försök igen om 30 sekunder.” **Retry** (Försök igen) är nedtonad tills nedräkningen är klar.
- **The provider is down or busy** (Leverantören är nere eller upptagen): ”Anthropic svarar inte. Försök igen om en liten stund.”
- **The answer could not be used** (Svaret kunde inte användas): ”AI:s svar gick inte att använda. Inget ändrades.”

Varje meddelande har knappen **Retry** där det är lämpligt och en knapp för att stänga det.

## Förhandsvisningen

När AI är klar visar fältet vad den skulle lägga till, till exempel ”3 lappar i en ny ram med namnet Sammanfattning”. Det visar också **Discard** (Kasta), **Retry**, **Review** (Granska), **Show** och **Add to board** (Lägg till på tavlan). ”Inget läggs till på tavlan förrän du gör det. Tryck på Enter för att lägga till och Esc för att kasta bort.”

## Granska innan du lägger till

Välj **Review** när en förhandsvisning är klar. En panel öppnas på tavlans högra sida och visar alla föreslagna objekt, vart och ett med en ruta för att behålla det.

- **Generated or summarised stickies** (Skapade eller sammanfattade lappar): redigera texten eller färgen på varje lapp, eller avmarkera den. En lapp med borttagen text tas inte med. En ram har en titel och en ruta för att utelämna den, och den måste innehålla minst en lapp.
- **Clusters** (Grupper): varje grupp har en titel och en ruta. Varje lapp som skulle flyttas har också en ruta. En grupp måste ha en titel och minst en lapp kvar.
- **Changed since** (Ändrad sedan): om en lapp har ändrats eller försvunnit sedan AI tittade på den markeras den som **Changed since**, avmarkeras och kan inte markeras. Den stannar där den är.

Det här gäller även om du väljer **Add to board** utan att öppna Granska: en lapp som har ändrats sedan AI tittade på den, eller har tagits bort eller låsts, flyttas inte. Ett meddelande talar om hur många lappar som lämnades kvar, till exempel ”En lapp som ändrats sedan AI tittade på den lämnades kvar.” Om alla lappar har ändrats finns inget att lägga till, och fältet talar om det.

Huvudknappen heter **Add all** (Lägg till alla) när allt är valt och **Add selected** (Lägg till markerade) (eller **Move selected** (Flytta markerade) för grupper) när du har valt bort något. **Discard** kastar bort förhandsvisningen. Om du väljer **Add** (Lägg till) utan att något är valt visas ett meddelande och inget ändras.

Dina redigeringar är bara synliga för dig. Andra ser fortfarande förhandsvisningen så som AI föreslog den. Förhandsvisningen på din skärm visar exakt vad du kommer att lägga till. Tillägget är ett enda steg i ångra-historiken, så `Ctrl+Z` tar tillbaka allt du lade till.

## Vem föreslog det

Markera något AI har skapat så visar egenskapspanelen till exempel ”Föreslaget av AI (Sammanfatta) åt Ana”: vilken funktion som skapade det och vem som bad om det. Kopior som du sparar som mall behåller inte den här raden.

## Inte än

Förslag som väntar på tavlan i flera dagar, att godkänna ett förslag offline, förslag från externa AI-verktyg och att flera personer redigerar samma förslag tillsammans är funktioner som kommer senare.

## Relaterat

- [Din AI-nyckel](ai-keys.md)
- [Åtkomsttoken och AI-verktyg](ai-tools.md)
- [Exportera och importera](export-import.md)
