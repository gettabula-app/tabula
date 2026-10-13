# Länkförhandsvisningar

Den här sidan är till för dig som driver en webbplats eller en Tabula-server och vill veta vad en begäran om länkförhandsvisning innebär.

## Vad begäran är

När någon lägger till ett länkkort på en Tabula-tavla (eller trycker på **Refresh preview** (Uppdatera förhandsvisningen) på ett sådant) frågar Tabula-servern som håller tavlan den länkade sidan efter dess titel, beskrivning och bild, så att kortet kan visa dem. Se [Länkkort](link-cards.md) för vad människor ser.

- Begäran kommer från **Tabula-servern**. Den kommer aldrig från webbläsaren hos personen som lade till länken, eller från någon som tittar på tavlan.
- Den görs **en gång** när en länk läggs till eller uppdateras, och svaret sparas med tavlan. Att titta på en tavla gör ingen begäran till din webbplats.
- Det är en vanlig `GET`, utan cookies, inloggningsuppgifter och `Referer`. Andra förfrågningar kan följa för sidans förhandsvisningsbild och ikon.
- Den följer högst tre omdirigeringar, ger upp efter fem sekunder och läser högst de första 1 MB av sidan (den slutar när den har läst sidans `<head>`).
- Den skickar denna `User-Agent`, med adressen till Tabula-servern som gjorde begäran:

```
TabulaLinkPreview/1.0 (+https://<the Tabula server>/docs/link-previews)
```

På en hostad arbetsyta är adressen arbetsytans egen. `https://your-team.thetabula.cloud` är bara ett exempel på hur den kan se ut.

## Håll Tabula borta

En sida som svarar med ett fel, eller inte svarar alls, får helt enkelt ingen förhandsvisning: kortet visar sin adress och fungerar fortfarande som en länk. För att hindra Tabula från att läsa dina sidor kan du neka begäran vars `User-Agent` innehåller `TabulaLinkPreview` (till exempel med en regel i din webbserver eller brandvägg). Tabula läser inte `robots.txt` för de här begärandena.

## För dig som driver en Tabula-server

Länkförhandsvisningar gör att din server begär webbsidor å användarnas vägnar, så de är avstängda som standard på en server som du kör själv.

- **Slå på eller av** dem i **Admin > Privacy** (Administratör > Integritet), med reglaget **Link previews** (Länkförhandsvisningar).
- **`TABULA_LINK_PREVIEWS`** är driftansvarigs inställning. `off` stänger av förhandsvisningar för gott, och ingen kan slå på dem från Admin. `on` slår på dem där de annars är avstängda, även på en server utan konton (där det inte finns någon Admin-sida). Lämna den tom för att låta administratörerna avgöra.
- **Håll den borta från ditt eget nätverk.** Tabulas server avvisar adresser som inte finns på det publika internet (privata och lokala intervall, link-local, molnets metadata, multicast och liknande), kontrollerar varje omdirigering på samma sätt och ansluter bara till den adress den kontrollerade. Om din server körs bredvid interna tjänster på adresser som ser publika ut, lägg upp dem i **`TABULA_LINK_PREVIEW_DENY`**: en kommaseparerad lista med nätverk (till exempel `203.0.113.0/24`) och värdnamn.
- **Gränser.** En person kan begära ungefär 30 förhandsvisningar per minut och 300 per timme, och en arbetsyta 2 000 per timme. En server kör högst fyra åt gången. När en sida har lästs sparas den i en dag på servern, så andra kort för samma adress läser den inte igen förrän dess. En omstart av servern tömmer minnet. **Refresh preview** läser alltid sidan igen.
- **Gäster** på en tavla kan inte skapa förhandsvisningar.

På en hostad arbetsyta är förhandsvisningar påslagna som standard, och en admin kan stänga av dem i **Admin > Privacy**.

## Relaterat

- [Länkkort](link-cards.md)
- [Adminpanelen](admin.md)
