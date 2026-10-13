# Print and save as PDF (TAB-146)

**Print or save as PDF…** in the board menu's Export section prints the board, the selection, or each top-level frame on its own page. v1 has no PDF library and no new dependency: the PDF is written by the browser's print dialog ("Save as PDF" as the destination).

## How it works

- `src/print-pages.ts` (pure, unit tested): `planPages` turns the scope into pages, `framesInOrder` orders frames with the canvas reading order (`readingOrder` in `src/canvas-nav.ts`), `sheetFor` and `pageRule` give the paper, orientation and the `@page` rule. A4 and Letter, margin 12 mm. Automatic orientation is landscape when at least half the pages are wider than tall.
- `src/ui/print.ts`: the dialog (`openPrint`) and `printBoard`. Each page is `exportSvg(app, ids)`, the same vector picture as the SVG export, drawn into `#print-root` (one `section.print-page` per page, with an optional `h2` title), plus a `<style id="print-page-rule">` holding the `@page` rule. Then `window.print()`. Both are removed on `afterprint`, and before the next print.
- `src/ui/print.css`: on screen `#print-root` is `display: none`. In print media everything else in `body` is hidden, pages break after each box, and the picture is fitted by letting the SVG fill a flex box (its `viewBox` keeps the aspect ratio).
- A page box is 0.6 mm shorter than the printable area so rounding never pushes it onto a second sheet.
- Blurred shadows (`#sticky-shadow`, `#sticky-curl-shadow`) are removed from the print (`withoutShadows`): the browser would turn each into a bitmap in the PDF, and the page would no longer be vector.

## Decisions and limits

- Fonts: the page's loaded fonts are used, so glyphs are embedded by the browser. Pictures use the same data-URL path as the exports.
- One orientation for the whole document: named `@page` sizes are not supported by every browser.
- Nested frames print inside their outer frame; only top-level frames get a page of their own.
- A frame larger than a page is scaled down to fit; nothing is split across pages.
- Hidden objects and comment pins are left out, as in other exports. The light theme colours are used whatever the theme.

## Follow-ups

- A generated .pdf (no print dialog), if wanted; needs a PDF library and font subsetting.
- Ties into presentation order (TAB-104) and pages (TAB-137) once those exist: print in presentation order.
- A keyboard shortcut for the dialog (the browser's own Ctrl+P still prints the app as it is on screen).

Tests: `test/print-pages.test.ts`, `test/print-browser.test.ts` (real Chromium, page counts from `page.pdf()`).
