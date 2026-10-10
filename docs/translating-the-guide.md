# Translating the user guide

The English pages in `docs/guide/*.md` are the source. A language is a folder next to them, named by its language code (`sv`, `de`, `pt-BR`), with the same file names. A page that has no translation yet is shown in English inside the language, with a notice, so nobody meets a 404. Adding a third language is adding a folder.

## A language folder

| File | What it is |
|---|---|
| `<code>/<page>.md` | A translated page, same name as the English one. |
| `<code>/_ui.json` | The strings of the page template (menu, search box, notices). Any missing key is English. The keys are in `DEFAULT_UI` in `scripts/vite-docs.mjs`. |
| `<code>/_glossary.md` | The terms of this language: what each product term is called, and what stays English. Translators follow it. |
| `<code>/_review.md` | Terms the translator was unsure about, one line each, for a native reader. |
| `<code>/.sources.json` | For each translated page, the hash of the English page it was translated from. |

Files that start with `_` are never shown as pages.

## Rules for a translation

- Keep the structure: the same headings (same levels and order), list items, tables, code blocks, images and links as the English page. The check below fails the page otherwise.
- Page links keep the English file name: `[Kanban](kanban.md)`. Links to a heading (`#...`) must use the translated heading's anchor, which is made from the translated heading text (lower case, letters and digits, hyphens). The check says which `#` link points at nothing.
- Names of buttons, menus and fields stay in the interface's English wording, because the app has no translated interface yet. The first time one appears on a page it gets a gloss in brackets: `Share (Dela)`. After that the English name alone. When the app gets a translated interface, this rule is revisited.
- Product and feature names (Tabula, Claude Code) are not translated. Keyboard keys are not translated.
- Screenshots show the English interface for now; they are shared by every language (`docs/images`).

## Keeping translations current

```
npm run docs:translations              # report: missing, stale, orphan and drifting pages for every language
npm run docs:translations -- --strict  # the same, and exit 1 when a page is stale, orphaned or drifting
npm run docs:translations -- --stamp kanban.md --locale sv   # after translating or reviewing a page
```

When an English page changes, its translation is *stale* until someone updates it and stamps it again. The documentation watcher reports stale pages with every English change. A stale page is still shown; the report is how it gets fixed.
