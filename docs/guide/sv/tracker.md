# Spårare på en tavla

Om din arbetsyta har spåraren kan du lägga den på en tavla som en levande lista över ärenden. Du panorerar och zoomar till den precis som till en ram, och du arbetar i den där den ligger: titta på ärenden, öppna ett, skapa ett eller dra ett ärende till en annan status. En tangent eller ett klick öppnar den i helskärm när du vill ha mer plats.

Spåraren visar samma lista med ärenden var du än ser den. En ändring i spåraren på tavlan syns i helskärm, och tvärtom.

## Lägg en spårare på en tavla

Välj **Tracker** (spårare) i det vänstra verktygsfältet. Spåraren visas mitt i det du ser och är markerad. Om verktygsfältet saknar knappen **Tracker** har arbetsytan inte spåraren, eller så kan du bara visa tavlan. Du kan lägga till fler än en spårare på en tavla. De visar alla samma ärenden.

## Levande och ögonblicksbild

En spårare är **levande** när du kan använda den på plats, och en **ögonblicksbild** när den bara är en bild av den.

| Den är | När |
|---|---|
| **Levande** | Tavlan är zoomad till 40 % eller mer, spåraren är minst 240 pixlar hög på din skärm, den är en av de tre levande spårarna på tavlan och du är inte på en telefon. Klick, skrivning och rullning fungerar i den. |
| **Ögonblicksbild** | Tavlan är zoomad till under 40 %, spåraren är liten eller utanför skärmen, det finns redan tre levande spårare, eller så är du på en telefon. Den beter sig som vilket objekt som helst: du kan dra den, och ett dubbelklick gör den levande när den ryms. |

Bara tre spårare på en tavla kan vara levande samtidigt. Den du har markerat kommer först, sedan den under pekaren och sedan den som syns mest på skärmen. De andra visas som ögonblicksbilder tills du markerar dem eller zoomar till dem.

En ögonblicksbild visar spårarens namn och hur många ärenden som är öppna. En spårare vars ärenden ännu inte har lästs in säger ”Zoom in or select this tracker to load its tickets.” (Zooma in eller markera spåraren för att läsa in ärendena.) En ögonblicksbild som inte är levande får en bricka med **Open** (Öppna) när du markerar den eller pekar på den, så att det alltid finns ett sätt in. På en telefon visas spåraren alltid som ett ögonblicksbildskort med en bricka **Open**, och när du trycker på den öppnas spåraren i helskärm.

## Arbeta i spåraren

Överst i en levande spårare finns:

- **All** (Alla), **My** (Mina) och **Board** (Tavla): **All** visar alla ärenden grupperade efter status, **My** visar ärenden som är tilldelade dig och **Board** visar statusarna som kolumner.
- **+ New ticket** (Nytt ärende), eller bara **+** i en smal spårare. Den finns inte om du inte kan skapa ärenden.
- Ikonen **expand** (expandera), **Open full screen** (Öppna i helskärm).
- Menyn **⋯**. Den innehåller **Copy link** (Kopiera länk) och, när din arbetsyta har sparade vyer, menyn **Views** (Vyer) för att byta mellan dem. I en smal spårare flyttas växlingen också in i den här menyn.

Klicka på ett ärende för att öppna det. I en bred spårare (ungefär 720 tavelenheter eller mer) öppnas ärendet som en panel bredvid listan, så att listan syns hela tiden. I en smalare spårare ersätter ärendet listan och du får en knapp **Back** (Tillbaka). Tryck på `Esc` för att stänga ärendet. Fokus går tillbaka till ärendets rad i listan. Tryck på `Esc` igen för att lämna spåraren och ge tangenterna tillbaka till tavlan. Spåraren förblir markerad.

Tangenter du trycker i spåraren hör till spåraren och påverkar inte tavlan: Backspace eller Delete på ett ärende tar inte bort spåraren, och en bokstav byter inte tavlans verktyg.

Varje rad i listan visar ärendets prioritet, etiketter, projekt, milstolpe och uppskattning. Listans genvägar (till exempel `S`, `A`, `P`, `X`, `J` och `K`) gäller raden du står på, även när `Tab` har lagt fokus på en knapp i raden. Bara `Enter` och `Blanksteg` stannar hos knappen, och fokus ligger kvar på den när listan ritas om.

### Vyn Board

**Board** visar statusarna som kolumner bredvid varandra, med antalet ärenden i varje. Dra ett ärende från en kolumn till en annan för att ändra dess status. Tryck på `Esc` innan du släpper för att avbryta draget. Varje kolumn har ett **+** för att skapa ett ärende i den statusen. Varje kort har en knapp **⋯** som öppnar en lista med statusar att flytta det till. Det är också sättet att ändra status med tangentbordet.

När du flyttar ett ärende visas meddelandet ”State changed” (Status ändrad) med **Undo** (Ångra). Välj **Undo** för att lägga tillbaka ärendet i dess gamla status.

### Öppna i helskärm

**Open full screen** ersätter tavlan med spåraren. Det är samma spårare, med samma flik och samma öppna ärende. Välj **Back to board** (Tillbaka till tavlan) eller använd webbläsarens bakåtknapp för att gå tillbaka. Tavlan är kvar där du lämnade den, med spåraren markerad.

## Vem kan göra vad

- Om du bara kan visa tavlan kan du läsa spåraren och öppna ärenden, men du kan inte skapa eller flytta ärenden.
- Om du inte har åtkomst till spåraren säger spåraren ”You do not have access to the tracker” (Du har inte åtkomst till spåraren) och visar inga knappar.
- En spårare utan ärenden säger ”No tickets yet” (Inga ärenden ännu) och erbjuder **+ New ticket**.
- Om ärendena inte kan läsas in säger spåraren ”Could not load tickets” (Det gick inte att läsa in ärendena) och visar en knapp **Retry** (Försök igen).

Din flik, ditt filter och ditt öppna ärende är dina: andra som tittar på samma spårare behåller sina egna.

## Relaterat

- [Tavlor och startsidan](boards.md)
- [Kanbantavlor](kanban.md): en kanban på en tavla kan kopplas till en spårare.
- [Tangentbord och skärmläsare](accessibility.md)
