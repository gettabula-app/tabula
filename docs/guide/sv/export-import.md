# Exportera och importera

Du kan spara en tavla som en bild, en fil som du kan öppna igen eller text. Du kan också lägga till en sparad tavla eller ett Mermaid-diagram i Tabula.

## Exportera

Öppna tavlans meny (knappen **Menu** (Meny) med tre punkter längst upp till höger). Avsnittet **Export** (Exportera) visar alla format. Om du har markerat objekt heter rubriken **Export selection** (Exportera markering), och PNG, SVG och JSON innehåller bara de objekten (samt allt inuti markerade ramar och kopplingslinjer mellan exporterade objekt).

| Objekt | Resultat |
|---|---|
| **PNG image** (PNG-bild) | En rasterbild i 2× storlek med vit bakgrund. |
| **SVG vector** (SVG-vektor) | En skalbar bild med vit bakgrund. |
| **Board file (.drift)** (Tavelfil (.drift)) | Hela tavlan med historiken, för säkerhetskopiering eller flytt. |
| **JSON snapshot** (JSON-ögonblicksbild) | En läsbar kopia av tavlan. |
| **Markdown summary** (Markdown-sammanfattning) | Textanteckningar grupperade efter ram, med röster och omröstningsresultat. |
| **Copy as Mermaid** (Kopiera som Mermaid) | Mermaid-text kopieras till urklipp. |
| **Cards as CSV** (Kort som CSV) | En rad per kanbankort, för kalkylblad. Visas när tavlan innehåller en kanban. Se [Kanbantavlor](kanban.md#exportera-kort-som-csv). |

Filerna får tavlans namn.

### PNG och SVG

Bilderna använder de ljusa standardfärgerna på vit bakgrund, oavsett vilket tema du använder. Kommentarsnålar tas inte med. När du exporterar en PNG- eller SVG-fil hämtas de teckensnitt som används på tavlan, och tillgängliga WOFF2-filer bäddas in. När en exporterad SVG-fil öppnas görs ingen begäran till Fontshare. Om ett teckensnitt inte kan hämtas eller den sammanlagda rådata som teckensnitten innehåller blir större än 1,5 MB används ett systemteckensnitt i stället. Mycket stora PNG-tavlor skalas ned så att de ryms inom en maximal bildstorlek.

### Tavelfil (.drift)

En `.drift`-fil innehåller hela tavlan, inklusive kommentarer, omröstningar och röster, tavlans redigeringshistorik och dess [bilder](images.md). Det här är den mest fullständiga kopian. Använd den för att säkerhetskopiera en tavla eller lämna över den till någon annan.

### JSON-ögonblicksbild

En textfil med tavlans inställningar, objekt, sessionssteg, kommentarer och omröstningar. Den innehåller inte redigeringshistoriken. Om du har markerat objekt innehåller filen bara de objekten.

### Markdown-sammanfattning

Varje ram listas som en rubrik med sina anteckningar som punktlista, sorterade efter antal röster (visas som ”3 röster”), följt av visade omröstningsresultat. Bara objekt med text inuti ramar tas med.

Sammanfattningen återger texten ordagrant: en titel som `# heading` eller `![x](link)` förblir vanlig text och blir aldrig en rubrik, bild eller länk. För att bevara texten kan den råa `.md`-filen visa ett omvänt snedstreck före tecken som `#`, `[` eller `*`. En Markdown-visare döljer snedstrecken.

Kanbaner listas också: en rubrik för varje kanban, dess kolumner under rubriken och korten som punktlista. Se [Kanbantavlor](kanban.md#i-markdown-sammanfattningen).

Sammanfattningen utelämnar det på tavlan som fortfarande är dolt för dig. Under ett steg med [privat skrivande](sessions.md) listas inte andras anteckningar förrän de visas. Under en röstning visas inga röstetal förrän resultatet visas. Röstetal från en avslutad röstning tas med. Se [Omröstningar](polls.md).

### Kopiera som Mermaid

Kopierar en diagrambeskrivning till urklipp: ett klassdiagram om tavlan har UML-klasser, annars ett flödesschema. Bara kopplingslinjer mellan två former tas med. Du kan också använda **Copy as Mermaid** i egenskapspanelen för ett urval av former eller klasser.

## Importera

### Öppna en fil som en ny tavla

Klicka på **Import file** (Importera fil) på startsidan och välj en `.drift`- eller `.json`-fil. Filen öppnas som en ny tavla, inzoomad så att allt får plats, med meddelandet ”Tavlan öppnades från fil”. En `.drift`-fil återställer kommentarer, omröstningar och historik. En JSON-fil återställer objekt, inställningar, sessionssteg och omröstningar samt eventuella kommentarer.

### Lägga till en fil på den aktuella tavlan

Välj **Import a board file into this board** (Importera en tavelfil till den här tavlan) i tavlans meny, eller dra en `.drift`- eller `.json`-fil till tavlan. Objekten läggs till till höger om det som redan finns, och vyn flyttas dit. Kommentarer, omröstningar och inställningar från filen läggs inte till. Importerade objekt får nya identiteter, så om du importerar samma fil två gånger får du två kopior.

Du behöver redigeringsåtkomst. Om filen inte är en Tabula-tavla eller skapades med en nyare version av Tabula visas ett meddelande och inget ändras.

### Importera Mermaid

Välj **Import Mermaid** (Importera Mermaid) i tavlans meny, i panelen **UML** (UML) under **Text to diagram** (Text till diagram) eller på en tom tavla.

1. Klistra in Mermaid-text. Flödesscheman och `classDiagram`, `stateDiagram-v2` eller `sequenceDiagram` stöds.
2. Klicka på **Add to board** (Lägg till på tavlan).

Diagrammet blir redigerbara former och kopplingslinjer till höger om befintligt innehåll. Om texten inte går att läsa visas ett fel i dialogrutan, så att du kan rätta till den.

### Klistra in text och objekt

Om du klistrar in vanlig text på tavlan skapas ett textobjekt där radbrytningarna bevaras. Lång text radbryts vid en bestämd bredd. Om du klistrar in objekt som kopierats från en annan Tabula-tavla (`Ctrl+C`, `Ctrl+V`) placeras de vid pekaren.

## Relaterat

- [Tavlor och startsidan](boards.md)
- [Versionshistorik](version-history.md)
- [Omröstningar](polls.md)
- [Kommentarer](comments.md)
