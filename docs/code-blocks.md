# Code blocks

A **code block** is a board object that holds code and draws it as coloured, fixed-width text on a card: an optional title, a language, optional line numbers and optional wrapping. It sits on the board like any object (move, resize the width, lock, group, comment) and appears in exports and print. This page is how it behaves; the guide page for people is [docs/guide/code-block.md](guide/code-block.md).

## What is stored

A code block is `type: 'code'` with `text` (the code), `lang` (one id of `shared/code-langs.mjs`), `title` (optional, up to 100 characters), `lines` (line numbers, default off), `wrap` (default off, on when the block is made with a coarse pointer such as a phone or tablet) and the usual box. **The code text is stored in the board like every other text**: it is synced, kept in history, written to `.drift` and JSON files, and read by agents (`create_objects`, `update_objects`, the Markdown summary) and by Tabula's built-in AI like the text of a note. Nothing about it is sent anywhere else; the highlighter runs in your browser.

An unknown `lang` is read as Plain text and refused on write. The theme (the colours of the code) is not stored and is not a setting: it follows the board's theme.

## Limits

- Up to **20,000 characters** per block. The typing box stops there, a longer paste is cut and says so, and a longer text written by an agent or an import is stored but drawn as plain text with a quiet note ("Highlighting off for long code").
- A title is plain text, up to 100 characters.
- The width is at least 160 and the height follows the rows: you can resize the sides, never the top and bottom.

## Languages

Plain text and 25 languages: TypeScript, TSX, JavaScript, JSX, JSON, HTML, CSS, SCSS, Python, Rust, Go, Java, C, C++, C#, Shell, SQL, YAML, TOML, Markdown, Diff, PHP, Ruby, Swift, Kotlin. The language list in the properties panel shows Plain text first, then TypeScript, JavaScript, JSON, HTML, CSS, Python, Shell, SQL, YAML, Go, Rust and Java, then the rest by name. A block made on a board starts in the language last used on that board in this session, otherwise Plain text.

## Making and editing

- **Make:** the Text and content group of the tool rail has **Code block** as its fifth choice (no key). A click makes a block 520 wide; a drag sets the width. It opens for typing at once.
- **Edit:** double-click, or select the block and press `Enter` (also on the focused code area). The code is typed in a plain text box that sits exactly on the drawn code, in the same face, size and line height, so nothing jumps. Highlighting is off while typing; the header and the line numbers stay and follow the text.
- `Tab` types two spaces, `Shift+Tab` takes up to two leading spaces off the selected lines, `Enter` keeps the indentation of the line you are on. `Esc`, `Ctrl/Cmd+Enter` or clicking away finishes. A block left empty with no title is removed.
- One editing session is **one undo step**, however long the pauses.

## Controls on the block

Over the top right of the card (the header when there is a title, the corner of the code otherwise) are two buttons: **Wrap lines** (a toggle) and **Copy code**. They show when the pointer is over the block, when the block is selected or when a button has the keyboard focus, and always on touch screens. They are 28 px (44 px to touch on a coarse pointer), and they are page controls: never in a PNG, SVG or print.

**Copy code** puts the plain source on the clipboard: never the coloured markup, never the line numbers. The icon becomes a check mark for 1.5 seconds and a screen reader hears "Copied". On a read-only board Copy works and Wrap is off.

## Long lines

With wrapping off the card clips and the code scrolls sideways: a sideways wheel or trackpad swipe, `Shift` + wheel, or `Left`, `Right`, `Home` and `End` when the code area has the focus. At either end the wheel moves the board again. How far a block is scrolled is a view setting: it is not stored, not shared and not exported (a file shows the block from its start). With wrapping on, a line continues on the next row, indented by two columns, and has one line number.

## Properties

**Code block** panel: Language (a button that opens a searchable list, 280 px wide, on a phone a full-height sheet), Title (placeholder "Untitled code"), the switches **Line numbers** and **Wrap lines**, Width, and the usual arrange buttons plus **Copy code**.

## Keyboard and screen readers

Each block in view has a labelled region ("Code, TypeScript" or "Code, <title>, TypeScript") whose code area takes the focus with `Tab` and scrolls with the arrow keys. The canvas outline describes a block with its code like any text. Forced colours (Windows high contrast): a 1 px `CanvasText` edge, the code in `CanvasText` on `Canvas`, no colours from the highlighter. Reduced motion is respected: the check mark and the buttons appear without animation.

## Export and print

PNG, SVG and print draw the block as SVG text (`<text>` and `<tspan fill>` per row, no `foreignObject`), the same as the board. A board file and a JSON snapshot keep the fields above. The Markdown export of a board writes the code as a fenced block with the language.

## Highlighting

The highlighter is a separate piece (`src/code-highlight*`, Shiki on a worker): the drawing asks for the colours of a block through a token source (`setCodeTokenSource` in `src/code-markup.ts`) and a repaint (`setCodeRepaint`). Until a block has tokens, or when it cannot get them, it is drawn in plain ink with the same geometry, and tokens for a text that has since changed are never shown. `src/code-highlight-glue.ts` is where the highlighter is connected: it keeps tokens per block (keyed by language, app theme and a hash of the text, at most 200 blocks), asks for them only for blocks within one viewport of the view, one request at a time when the browser is idle, 250 ms after the text last changed and never while the block is being typed in, drops an answer for a text that has changed since, and asks again when the theme changes. Plain text, empty blocks and blocks over 20,000 characters never ask; a block that gets no answer (no Worker, as in the demo build, or the 1.5 s watchdog) stays plain and is not asked for again with the same text and theme.
