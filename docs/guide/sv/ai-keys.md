# Din AI-nyckel

**Your AI key** (Din AI-nyckel) låter dig spara en egen API-nyckel i Tabula: en Anthropic-nyckel eller en nyckel för valfri tjänst som använder OpenAI API (NVIDIA:s katalog, OpenAI, OpenRouter eller en egen modellserver). När personliga nycklar är tillåtna använder AI din nyckel i första hand, framför arbetsytans nyckel.

> AI kan använda en nyckel för arbetsytan eller din nyckel om en admin tillåter personliga nycklar. AI måste också vara aktiverat för dig. Tavlan visar AI-kontroller bara när en nyckel eller planens krediter är tillgängliga. Med en hostad plan med AI-krediter används krediterna för körningar utan nyckel; **Admin → AI** (Administration → AI) visar det innan en nyckel för arbetsytan läggs till, och en nyckel som du eller arbetsytan har sparat används alltid först.

## När du ser den

**Your AI key** visas i **Menu** (Meny) under **Account** (Konto), och bara när:

- din arbetsyta kräver inloggning, och
- en ägare av arbetsytan eller administratör har aktiverat **Personal keys** (Personliga nycklar) på [AI-fliken i adminpanelen](admin.md).

Om inställningen **Guests** (Gäster) är på visas den inte för gäster.

## Lägg till en nyckel

1. Öppna **Menu** och välj **Your AI key**.
2. Välj **Provider** (Leverantör): **Anthropic** eller **OpenAI-compatible**.
3. För OpenAI-compatible fyller du i **Base URL** (Bas-URL) (adressen till leverantörens API, till exempel `https://integrate.api.nvidia.com/v1`) och **Model** (Modell) (modellens id hos leverantören, till exempel `moonshotai/kimi-k3`).
4. Klistra in din nyckel i **API key** (API-nyckel).
5. Välj **Save key** (Spara nyckel).

**Save key** är inaktiv tills allt ser giltigt ut: nyckeln får inte innehålla blanksteg, en Base URL måste börja med `https://` och vara en offentlig adress (inget användarnamn eller lösenord, inget `?` eller `#`, inte `localhost` eller en privat adress), och ett Model-id måste finnas. Leverantören kontrollerar nyckeln innan något sparas, och knappen visar **Checking…** (Kontrollerar …) under tiden. För en OpenAI-compatible-leverantör ber kontrollen också modellen om ett ord, så det kan ta upp till en halv minut med en långsam modell. Om kontrollen misslyckas förklarar meddelandet varför (nyckeln avvisades, modellen eller adressen känns inte igen eller modellen tog för lång tid), och inget sparas. När det lyckas visas **Key saved** (Nyckel sparad).

## Det här visas sedan

Dialogrutan visar leverantören, nyckelns fyra sista tecken samt när den lades till och senast användes. Till exempel:

**Anthropic-nyckel som slutar på …a1b2**

För en OpenAI-compatible-nyckel visas också leverantörens värdnamn och modellen, till exempel **OpenAI-compatible-nyckel som slutar på …a1b2 · integrate.api.nvidia.com · moonshotai/kimi-k3**. Raden nedanför visar när nyckeln lades till och senast användes.

Hela nyckeln visas aldrig igen, och servern skickar den aldrig tillbaka. Raden **Körningar använder din nyckel.** talar om att det är din nyckel som används. Om det inte finns någon nyckel alls står det i dialogrutan att AI-funktionerna inte kan köras ännu.

## Testa en nyckel

När nyckeln är sparad väljer du **Test key** (Testa nyckel) bredvid **Remove** (Ta bort). Tabula frågar leverantören om den sparade nyckeln fortfarande fungerar (och, för en OpenAI-compatible-nyckel, om modellen fortfarande svarar). Testet visar eller ersätter inte nyckeln och ändrar inte datumet för senaste användning. När testet lyckas visas meddelandet **Nyckeln fungerar.**; annars förklarar det vad som gick fel.

## Ersätt en nyckel

Öppna **Your AI key**, klistra in en ny nyckel i **Replace with a new key** (Ersätt med en ny nyckel) och välj **Save key**. Den nya nyckeln kontrolleras på samma sätt och ersätter den gamla när den har sparats.

## Ta bort en nyckel

1. Öppna **Your AI key**.
2. Välj **Remove**. Knappen ändras till **Click again to remove** (Klicka igen för att ta bort).
3. Välj den igen.

När nyckeln tas bort visas **Nyckel borttagen**. Om du klickar någon annanstans innan det andra klicket återställs knappen och inget tas bort.

## Modeller och leverantör

Tabula har stöd för leverantörerna **Anthropic** och **OpenAI-compatible**.

Med en Anthropic-nyckel väljer arbetsytans administratör modell för arbetsytan bland följande:

- Claude Opus 5.5 (standardmodellen)
- Claude Sonnet 5.5
- Claude Haiku 5.5

Du väljer inte modell själv.

Med en OpenAI-compatible-nyckel väljer du modell. Den sparas med nyckeln och visas i AI-raden. Välj en modell som följer instruktioner väl, eftersom Tabula ber om ett JSON-svar och använder det bara om det är giltigt. Om en modell inte klarar det visas till exempel **Den här modellen svarade inte i det JSON-format som krävs. Prova en modell som följer instruktioner bättre.** i AI-raden, och inget på tavlan ändras. En modell kan också vara långsam (då står det i AI-raden att svaret tog för lång tid) eller saknas i leverantörens lista (**Leverantören känner inte igen den här modellen eller adressen**). AI-raden visar en uppskattning av antalet token, men inget pris för de här modellerna: Tabula känner inte till priset och din leverantör debiterar din nyckel.

> Tavlans innehåll skickas till den valda leverantören och behandlas enligt dess API-villkor. Dialogrutan visar det här meddelandet.

Det är i [AI-raden](ai-bar.md) du använder funktionerna.
