# Lager

Lagerpanelen listar allt på tavlan på ett ställe, med det översta objektet först. Använd den för att hitta ett objekt, ändra ordningen mellan objekt, byta namn och dölja eller låsa objekt.

## Öppna panelen

- Välj **Layers** (Lager) i verktygsfältet eller tavlans meny.
- Tryck på `Alt+L`.

Panelens rubrik visar hur många objekt som är dolda. Om du bara kan visa tavlan är listan skrivskyddad.

![Lagerpanelen med tavlans objekt och en utfälld ram som visar sina lappar](images/layers-panel.png)

## Listan

- Det översta objektet står först. Objekt i en ram visas under den, liksom kolumner och kort i en [kanbantavla](kanban.md).
- Klicka på en rad för att markera objektet på tavlan.
- Raderna visar objektets namn, eller dess text eller typ om det saknar namn.

## Ändra ordningen i lagren

Dra en rad uppåt eller nedåt. Du kan också markera en rad och trycka på `Alt+Up` eller `Alt+Down`. Varje flytt är ett steg i ångra-historiken. Dra i handtaget i slutet av raden på en telefon.

Kommandon för att ändra ordningen direkt på tavlan finns i [Former, text och lappar](shapes-text-notes.md).

## Byta namn

Dubbelklicka på en rad eller markera den och tryck på `F2`. Tryck på `Enter` för att spara och `Esc` för att avbryta. En rams namn är också dess rubrik på tavlan.

## Dölja och låsa

Varje rad har en ögonikon och ett lås.

- **Hide** (Dölj) tar bort ett objekt från tavlan för alla. Ett dolt objekt visas inte, går inte att klicka på, markera, fästa mot eller koppla till. Det utelämnas också från PNG- och SVG-exporter, minikartan och sessionssammanfattningen. Kopplingslinjer till objektet och allt i en dold ram döljs också. Raden finns kvar i listan så att du kan visa objektet igen. På en kanbantavla tas en dold kolumn eller ett dolt kort bort från layouten, och kolumnen sluts.
- **Lock** (Lås) hindrar att ett objekt redigeras. Mer information finns i [Låsa objekt](shapes-text-notes.md).

Markera en rad och tryck på `H` för att dölja eller visa objektet, eller på `L` för att låsa eller låsa upp det.

Dolda objekt är inte privata. Alla som kan öppna tavlan kan visa ett dolt objekt igen från lagerpanelen, och tavelfiler behåller dolda objekt. Dolda objekt utelämnas när du sparar en mall.

## Tangentbord

Listan är ett träd som du kan använda utan mus.

| Tangent | Funktion |
|---|---|
| `Up`, `Down` | Flytta mellan raderna |
| `Enter` | Markera objektet på tavlan |
| `Alt+Up`, `Alt+Down` | Flytta objektet uppåt eller nedåt i lagren |
| `F2` | Byt namn |
| `H` | Dölj eller visa |
| `L` | Lås eller lås upp |

Ett dolt objekt kan inte markeras förrän du visar det. Ett låst objekt kan inte markeras förrän du låser upp det. Panelen talar om det när du försöker.

## Relaterat

- [Former, text och lappar](shapes-text-notes.md)
- [Kanbantavlor](kanban.md)
