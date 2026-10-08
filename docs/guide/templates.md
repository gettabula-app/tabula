# Templates

Templates are ready-made boards for team exercises such as retrospectives, brainstorming and prioritisation. Tabula includes built-in templates, and you can save your own from any board.

## Browse templates

Choose **Templates** in the top bar of the Boards page, or open the `#/templates` address of your Tabula server.

- **My templates** comes first and lists the templates you saved. Until you save one it says **Templates you save from a board appear here.**
- **Built-in templates** follows. Every card has a thumbnail, its category, name, a one-line description and a **Use template** button. Thumbnails are drawn from the template's contents in your current [theme](themes.md).
- The category buttons filter both lists: **All**, **Retrospective**, **Ideation**, **Discussion**, **Prioritisation**, **Planning**, **Discovery**, **Strategy** and **Risk**. **Custom** appears once you have saved a template in that category.
- **Search templates** matches name, category and description. The line above the cards shows how many match, or **No templates match.**

<!-- screenshot: the Templates page with a My templates section above the built-in cards, thumbnails visible -->

## Start a board from a template

1. Open the Templates page.
2. Choose **Use template** on a card.

Tabula creates a new board named after the template, with its frames, fonts and session steps, and opens it. Rename the board from the name field at the top left.

The **Start from a template** row on the Boards page shows four tiles: your saved templates first, then built-in ones. Click a tile to open a new board from it, or choose **All templates**.

If your workspace uses sign-in, starting a board from a template needs the server. When you are offline, the buttons are disabled and a note says why.

## Add a template to the board you are on

1. Open the board and choose **Templates and team exercises** in the left toolbar. On an empty board, **Start from a template** opens the same drawer.
2. Pick a template. Your own are listed under **My templates**, the built-in ones under their categories.

The frames are placed next to your existing content and the view moves to show them. Undo (`Ctrl+Z`, `Cmd+Z` on Mac) removes the added objects in one step. If the template has session steps, they replace the board's current steps, and a message tells you to start the session from the bar at the bottom. See [Sessions and focus requests](sessions.md). You need edit access.

## Save a board or a selection as a template

1. To save part of a board, select the items. To save everything, select nothing.
2. For a selection, choose **Save as template** in the quick-action bar. For the whole board, choose **Menu**, then **Save board as template**.
3. Fill in the form: **Name** (up to 80 characters; prefilled from the frame name or the board name), **Category** (the built-in categories or **Custom**) and **Description** (optional).
4. Tick **Include session steps** to keep the board's session plan. The checkbox only appears when the board has steps.
5. Check the preview, which shows the thumbnail and how many objects and steps will be saved, then choose **Save template**.

Frames bring everything inside them, and connectors are kept when both of their ends are saved. A template that is too large cannot be saved, and the form says why. An empty board shows **Add something to the board first.**

## Where templates are stored

Saved templates are stored in your browser, on this device. They work offline and appear in all tabs of the same browser. They are not shared with your team or workspace, they do not follow you to another browser, and clearing site data deletes them. To move one, export it as a file. A browser that blocks local storage cannot save templates.

## Edit a template

1. On the Templates page, open the **More actions** menu (three dots) on a card in **My templates** and choose **Edit**.
2. The template opens on a scratch board. It is a separate working board that is not synced, not shared and not listed on the Boards page. The banner reads **Editing template** and the template's name. Sharing, comments, version history and the sync status are not available here.
3. Change the objects as on any board. Use **Details** to change the name, category, description and whether session steps are included, and then choose **Done**. The session bar edits the steps.
4. Choose **Save template** to store your changes and return to the Templates page, or **Cancel** to leave without saving. The home button at the top left (**Back to templates**) does the same as **Cancel**.

If you leave with unsaved edits, whether with **Cancel**, the home button, a link or by changing the address, **Discard changes?** asks you to confirm. Choose **Keep editing** to stay or **Discard changes** to leave. Closing the tab shows the browser's own warning.

## Rename, duplicate, export and delete

The **More actions** menu on a card in **My templates** offers:

- **Edit**, described above.
- **Rename**. Type a new name and choose **Rename**.
- **Duplicate**. Adds a copy called "name (copy)" to **My templates**.
- **Export file**. Downloads the template as a `.tabula-template.json` file.
- **Delete**. Choose **Delete template** to confirm. Boards you made from it are not affected, and the template is removed from this browser.

## Duplicate a built-in template to edit it

Built-in templates cannot be changed. To adapt one, open the **More actions** menu on its card and choose **Duplicate to edit**. Tabula makes a personal copy in the same category and opens it for editing. After you choose **Save template**, the copy is under **My templates**.

## Export and import template files

Use a file to move a template to another browser or to give it to a colleague.

1. **Export:** choose **Export file** on the template's card. The file is named after the template and ends in `.tabula-template.json`.
2. **Import:** choose **Import template** at the top of the Templates page and pick the file. The template is added to **My templates** as a new template, so importing the same file twice gives two copies. A category Tabula does not know becomes **Custom**.

Files that are not valid templates, or that were made by a newer version of Tabula, are rejected with a message that says why. These files are for templates only. Boards use `.drift` and `.json` files. See [Export and import](export-import.md).

## Built-in templates

| Category | Templates |
|---|---|
| Retrospective | Start / Stop / Continue, 4Ls, Mad / Sad / Glad, Sailboat |
| Ideation | Crazy 8s, Brainstorm + affinity map |
| Discussion | Lean Coffee |
| Prioritisation | Impact / Effort matrix, MoSCoW |
| Planning | User story map |
| Discovery | Customer journey map, Empathy map |
| Strategy | SWOT |
| Risk | Pre-mortem |

Each built-in template comes with a session plan, shown in the session bar as **Session ready**. You can edit the steps or hide the bar before you start. Nothing runs until you start the session.

## Related

- [Boards and the home screen](boards.md)
- [Sessions and focus requests](sessions.md)
- [Themes](themes.md)
- [Export and import](export-import.md)
