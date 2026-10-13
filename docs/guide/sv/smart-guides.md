# Smarta hjälplinjer

Smarta hjälplinjer visar hur objektet du flyttar eller ändrar storlek på ligger i förhållande till objekten runt omkring. De fäster också objektet på plats, så att kanter och mittpunkter linjerar och avstånden mellan objekt blir lika stora.

## Det här ser du

- **Justeringslinjer.** En tunn linje visas mellan objekt som linjerar, från det flyttade objektet till det objekt som ligger längst bort på samma linje. Den ritas bara mellan objekten, inte över hela vyn.
- **Jämna mellanrum.** När avståndet till ett närliggande objekt motsvarar ett avstånd någon annanstans i samma rad eller kolumn, eller när objektet ligger precis mitt emellan två grannar, visas en klammer över varje lika stort mellanrum med avståndet angivet.
- **Samma storlek.** Medan du ändrar storlek kan bredden eller höjden fästa vid samma mått som på ett annat objekt. Klamrarna markerar objektet som ändras och upp till tre närmaste objekt med samma mått, med ett `=` före det avrundade måttet.

## När de visas

Hjälplinjer visas medan du flyttar och ändrar storlek på ett objekt. En flermarkering flyttas som ett enda block. Om du bara markerar kopplingslinjer visas inga hjälplinjer.

När du ändrar storlek genom att dra i en fri kant är det bara kanten du drar i som fäster; den motsatta kanten står kvar. Om du drar i ett hörn med låsta proportioner vinner den närmaste vågräta eller lodräta justeringen. Den andra kanten följer proportionerna, och det motsatta hörnet ligger kvar. Det gäller hörn som du ändrar med `Shift` och bilder, ikoner och UML-aktörer. Om du ändrar storlek på ett roterat objekt visas inga hjälplinjer. En liten etikett intill pekaren visar storleken medan du ändrar storlek eller ritar, till exempel "320 × 180". Hörnet du drar ut när du ritar en ny form, lapp eller ram fäster på samma sätt.

## Hur nära du behöver vara

Ett objekt fäster när en kant eller mittpunkt är inom ungefär 6 skärmpixlar från en linje eller ett avstånd som passar. Avståndet förblir detsamma när du zoomar in eller ut.

Justering och jämna mellanrum prioriteras framför rutnätet. Om en justering eller ett jämnt mellanrum ligger inom räckhåll fäster objektet där även om positionen hamnar utanför rutnätet. Jämna mellanrum får ett försprång: det valet gäller om inte en justering ligger mer än 2 skärmpixlar närmare.

## Stäng av hjälplinjer för ett enskilt drag

Håll ned `Alt` medan du drar. Då stängs hjälplinjer och fästning mot rutnätet av bara för det draget. På Mac håller du ned Option.

## Lås ett drag till en riktning

Håll ner `Cmd` (`Ctrl` på Windows och Linux) medan du drar för att flytta i bara en riktning. Tabula väljer den riktning du rör dig först, vågrät eller lodrät, efter ungefär 6 pixlar, och behåller den tills du släpper tangenten. En streckad linje visar riktningen och en liten etikett följer pekaren. Det fungerar för objekt, grupper, markeringar, ramar och den fria änden av en kopplingslinje eller linje. Släpp tangenten under draget för att flytta fritt igen. Hjälplinjer och fäst mot rutnät fungerar fortfarande längs den låsta riktningen, och `Alt` stänger dem av.

## Inställningen Snap to grid (Fäst mot rutnät)

Inställningen **Snap to grid** i **Board settings** (Inställningar för tavlan) styr bara fästning mot rutnätet. Hjälplinjerna fungerar oavsett om inställningen är på eller av, och även när rutnätet är inställt på inget.

## Dolda anteckningar

Anteckningar som är dolda under ett steg med privat skrivande är aldrig mål för hjälplinjer. En hjälplinje visar inte var en dold anteckning finns. Se [Sessioner och fokusbegäran](sessions.md).

## Färg

Hjälplinjer och klamrar för mellanrum använder hjälplinjefärgen i det aktuella temat, så att de syns tydligt i alla teman. Se [Teman](themes.md).

## Relaterat

- [Kom igång](getting-started.md): flytta, ändra storlek och rutnätet.
- [Former, text och klisterlappar](shapes-text-notes.md)
- [Teman](themes.md)
