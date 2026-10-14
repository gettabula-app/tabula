# Kommentarer

Kommentarer är trådade anteckningar som fästs på en plats på tavlan eller på ett objekt. Använd dem för frågor och återkoppling som inte ska fylla själva tavlan.

## Lägga till en kommentar

1. Tryck på `C` eller klicka på **Comment** (Kommentar) i verktygsfältet.
2. Klicka på en plats på tavlan eller på ett objekt. En ruta öppnas.
3. Skriv i **Add a comment** (Lägg till en kommentar) och tryck på `Enter`. Använd `Shift+Enter` för en ny rad.

Tråden skapas när du skickar det första meddelandet. Om du trycker på `Esc` eller klickar på **Cancel** (Avbryt) sparas inget. När du har placerat en nål växlar verktyget tillbaka till **Select** (Markera), så du trycker på `C` igen för att placera nästa.

![En kommentarsnål på en lapp med tråden öppen: en kommentar, ett svar, ett svarsfält och knappen Resolve](images/comment-thread.png)

En nål som placeras på ett objekt sitter kvar på det när du flyttar, ändrar storlek på eller roterar objektet. En nål som placeras på tom arbetsyta stannar där du satte den. Om objektet tas bort stannar nålen på sin senaste plats.

Att skriva i en kommentarsruta aktiverar aldrig kortkommandon för tavlan, så du kan använda vilka bokstäver som helst.

## Läsa och svara

- Klicka på en nål för att öppna tråden. Du kan göra det på alla tavlor du kan öppna, även skrivskyddade tavlor.
- Skriv i **Reply** (Svara) och tryck på `Enter`, eller klicka på **Reply**.
- Klicka på **Resolve** när frågan är löst. Lösta nålar tonas ned. Klicka på **Reopen** (Öppna igen) för att ta upp tråden igen.
- Klicka utanför tråden eller tryck på `Esc` för att stänga den.

### Nämn någon

Skriv `@` i en ny kommentar eller ett svar för att se de som är här nu och alla som tidigare har kommenterat på tavlan. Välj en med piltangenterna och `Enter`, eller klicka på ett namn, så visas det som personens namn i kommentaren. Om personen kan öppna tavlan hittar hen din kommentar under klockan. Personer som inte är inloggade (gäster) visas inte i listan, eftersom de inte får några aviseringar. Att redigera en kommentar aviserar ingen igen. En kommentar kan nämna upp till 10 personer.

## Redigera och ta bort

- **Edit** (Redigera) ändrar texten i din egen kommentar. Ingen kan redigera någon annans kommentar, inte ens tavlans ägare. Redigerade kommentarer märks med ”redigerat” bredvid tiden.
- **Delete** (Ta bort) tar bort din egen kommentar. Klicka på den och sedan på **Click again to delete** (Klicka igen för att ta bort) för att bekräfta.
- Du kan inte ta bort din första kommentar i en tråd medan andra har svarat på den, eftersom deras svar också skulle tas bort.
- Moderatorer kan ta bort allas kommentarer. Om arbetsytan använder inloggning är moderatorerna tavlans ägare, arbetsytans administratörer och administratörerna för tavlans team. Utan inloggning finns det inga moderatorer, så du kan bara ta bort dina egna kommentarer.

### Importerade och äldre kommentarer

En kommentar som hämtats från en `.drift`- eller JSON-fil behåller sin ursprungliga författare och får brickan **imported** (importerad). Ingen kan redigera den. Den som importerade den eller en moderator kan ta bort den.

Om arbetsytan aktiverade inloggning efter att en kommentar skrevs får kommentaren brickan **legacy** (äldre). Ingen kan redigera den, och bara en moderator kan ta bort den.

### Lösa och öppna trådar igen

Du kan lösa en tråd eller öppna den igen om du skrev den eller kan redigera tavlan. Knappen **Resolve** är dold på andra personers trådar för alla andra, till exempel kommentatörer.

### När en ändring ångras

Om arbetsytan använder inloggning kontrollerar servern varje kommentarändring mot de här reglerna. När den ångrar en av dina ändringar visas ett meddelande och kommentaren återställs:

- ”Bara författaren kan redigera en kommentar, så den ändringen ångrades.”
- ”Bara författaren eller en moderator (tavlans ägare eller en administratör) kan ta bort en kommentar, så borttagningen ångrades.”
- ”Bara författaren eller tavlans redigerare kan lösa en kommentar, så ändringen ångrades.”
- ”Kommentarer skrivs under ditt eget kontonamn, så det korrigerades.”

Du ser de här meddelandena bara om ändringen gjordes på något annat sätt än med de vanliga knapparna, till exempel när din roll ändrades medan en tråd var öppen. Kommentarer publiceras alltid under ditt kontonamn.

## Kommentarspanelen

Klicka på pratbubblan i det övre fältet för att öppna panelen **Comments** (Kommentarer). En liten siffra på knappen visar antalet öppna trådar.

- Använd filtren **Open** (Öppna) och **Resolved** (Lösta) för att växla mellan listorna. Antalet visas för varje lista.
- Varje rad visar trådens första rad, antalet svar och hur länge sedan den skrevs.
- Klicka på en rad för att flytta vyn till nålen och öppna tråden.

## Visa eller dölja nålar

Öppna tavlans meny och välj **Show comments** (Visa kommentarer) för att visa eller dölja nålar. En bock betyder att de visas. Valet sparas bara på den här enheten och tar inte bort något.

Nålar ingår aldrig i PNG- eller SVG-exporter. Kommentarer sparas i `.drift`-filer och JSON-exporter och återställs när du importerar dem, märkta som **imported**. Se [Exportera och importera](export-import.md).

## Vem kan kommentera

| Roll | Läsa kommentarer | Lägga till och svara | Lösa | Ta bort |
|---|---|---|---|---|
| Ägare | Ja | Ja | Alla trådar | Alla kommentarer |
| Redigerare | Ja | Ja | Alla trådar | Dina egna |
| Kommentatör | Ja | Ja | Dina egna trådar | Dina egna |
| Läsare | Ja | Nej | Nej | Nej |

En **kommentatör** kan kommentera men inte ändra tavlan. Det passar till exempel en intressent som granskar ditt arbete. Läsare ser nålarna och trådarna, men verktyget **Comment** är inaktiverat för dem. En öppen tråd visar meddelandet ”Du kan läsa kommentarer på den här tavlan, men inte lägga till några.”

Om arbetsytan inte använder inloggning kan alla kommentera. Se [Delning, roller och team](sharing.md) om du vill veta hur du ger någon en roll.

## Privat skrivande och kommentarer

Under en sessions steg för privat skrivande förblir andras dolda anteckningar dolda. En nål på en dold anteckning är också dold och dess tråd går inte att öppna. Om du placerar en nål på en dold anteckning stannar nålen på arbetsytan i stället för att fästas på anteckningen. Se [Sessioner och fokusbegäranden](sessions.md).

## Kommentarer och ångra

Kommentarer har en separat ångrahistorik från tavlan. `Ctrl+Z` (`Cmd+Z` på Mac) tar aldrig bort en kommentar, och [att återställa en version](version-history.md) ändrar inte kommentarerna.

## Relaterat

- [Chatt](chat.md)
- [Delning, roller och team](sharing.md)
- [Versionshistorik](version-history.md)
- [Exportera och importera](export-import.md)
