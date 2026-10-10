# Smarta hjälplinjer

Smarta hjälplinjer visar hur objektet du flyttar eller ändrar storlek på ligger i förhållande till objekten runt omkring. De fäster också objektet på plats, så att kanter och mittpunkter linjerar och avstånden mellan objekt blir lika stora.

## Det här ser du

- **Justeringslinjer.** En tunn linje visas mellan objekt som linjerar, från det flyttade objektet till det objekt som ligger längst bort på samma linje. Den ritas bara mellan objekten, inte över hela vyn.
- **Jämna mellanrum.** När avståndet till ett närliggande objekt motsvarar ett avstånd någon annanstans i samma rad eller kolumn, eller när objektet ligger precis mitt emellan två grannar, visas en klammer över varje lika stort mellanrum med avståndet angivet.

## När de visas

Hjälplinjer visas medan du flyttar och ändrar storlek på ett objekt. En flermarkering flyttas som ett enda block. Om du bara markerar kopplingslinjer visas inga hjälplinjer.

När du ändrar storlek är det bara kanterna du drar i som fäster. Den motsatta kanten stannar där den är. Om du ändrar storlek på ett roterat objekt visas inga hjälplinjer. De visas inte heller när du ändrar storlek från ett hörn med låsta proportioner, håller ned `Shift` eller gör det på ikoner och UML-aktörer.

## Hur nära du behöver vara

Ett objekt fäster när en kant eller mittpunkt är inom ungefär 6 skärmpixlar från en linje eller ett avstånd som passar. Avståndet förblir detsamma när du zoomar in eller ut.

Justering och jämna mellanrum prioriteras framför rutnätet. Om en justering eller ett jämnt mellanrum ligger inom räckhåll fäster objektet där även om positionen hamnar utanför rutnätet. Jämna mellanrum får ett försprång: det valet gäller om inte en justering ligger mer än 2 skärmpixlar närmare.

## Stäng av hjälplinjer för ett enskilt drag

Håll ned `Alt` medan du drar. Då stängs hjälplinjer och fästning mot rutnätet av bara för det draget. På Mac håller du ned Option.

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
