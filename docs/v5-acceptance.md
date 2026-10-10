# v5 acceptance checklist (kanban MCP)

For the upgrade of the hosted workspaces to v5, the release with kanban cards that carry a link and an owner, and the MCP card tools. Run it on **tabulahq** when tech lead says it is upgraded, then on **acme** after its upgrade. On acme only read what is already there: no card, board or token is created on acme.

How to use it: tick each line, write what you saw next to any line that is not a plain pass, and keep the screenshot names. Every UI check is done at **360, 390 and 1280** pixels wide unless it says otherwise (a real phone for 360 and 390 if one is at hand; otherwise the browser's device emulation). A line that fails is a stop for that workspace; say so to tech lead and the manager.

Owner column: Q&A (QA) runs everything below; "TL" is tech lead for the version and token facts.

## 0. Before you start

- [ ] TL says the workspace is on v5. **tabulahq** is `v5` (TL gives the main SHA); **acme** waits for the card-height fix and is `v5.0.1`: write acme's label only after TL confirms it. Write them here: tabulahq `________`, acme `________`.
- [ ] Confirm the label: TL pastes the control plane's `imageVersion` and `imageRef` (the exact image digest) for the workspace; compare the digest with the one in the release row. On the instance, ask developer which field carries the release label in v5 (v4's Admin showed `0.1.0`, so do not rely on that line).
- [ ] **The MCP round trip (section 3) starts only after TL's message that the upgrade is verified.** Sections 1, 2, 4 and 5 may start once TL says the workspace is upgraded.
- [ ] You have the workspace address and a sign-in e-mail that is an owner or admin of it.
- [ ] A scratch board name for this run, for example `v5-accept-YYYY-MM-DD`. Never run the MCP part on the HQ board or any real board.

## 1. Sign-in and the boards list (tabulahq and acme)

- [ ] Sign in by e-mailed link. The link works once; opening it a second time says "expired or already used" and you stay signed in.
- [ ] The boards list shows the boards you expect (compare with what TL expects), with the right titles and no blank cards.
- [ ] Open three existing boards, including HQ on tabulahq: they load, show "Live", and people appear in the top bar. Nothing is edited.
- [ ] The browser console has no red errors on the boards list and on a board (the 401 from `/api/me` before sign-in is expected).
- [ ] Sign out and sign in again.

## 2. Kanban in the app (tabulahq; acme: look only)

On tabulahq, create the scratch board, then:

- [ ] **Add a kanban**: Shapes, then Kanban. It has the lanes To do, Doing and Done.
- [ ] **Add cards**: `+ Add card` in To do, type a title, Enter adds the next. Add four cards.
- [ ] **Move cards** (all three widths): drag a card to another lane at 1280; at 360 and 390 open the card list sheet and use **Move to**; with the keyboard, select a card and press Alt with an arrow key. A move is one step in Undo, and Redo puts it back.
- [ ] **Card dialog**: open a card (double-click, or Enter on a selected card). It shows Title, Description, **Owner**, **Link**, **Due date** and Labels. On a phone it is a sheet at the bottom and nothing is cut off at 360.
- [ ] **Link**: type `https://example.com/page`, leave the field: the card shows the link and **Open link** opens it in a new tab. Try `javascript:alert(1)`: it is refused and nothing is saved. A link with a space or a username and password in it is refused too.
- [ ] **Owner**: pick yourself, then another person on the board, then type a name that has no account. Each shows on the card. Clear it.
- [ ] **Overdue**: set a due date in the past on a card in **To do**: the chip says it is overdue (colour plus a word, not colour alone). Move the same card to **Done**: it is no longer overdue. Set a date of today and tomorrow: "Today", "Tomorrow".
- [ ] **Labels**: create a label, put it on a card, rename it, delete it.
- [ ] Reload the page: everything above is still there. Open the board in a second browser tab or window: a change in one shows in the other within a few seconds.
- [ ] **Phone list sheet** (360 and 390): lane tabs, the card list, link, owner badge and due chip are readable, and every button is at least 44 pixels high.
- [ ] A **viewer** on the scratch board (share it with a viewer, or open it in a private window as a guest if join codes are on) sees the cards but cannot drag them or open the edit fields.
- [ ] acme: open an existing kanban board if there is one. The old cards still show their title, lane and labels, with no link or owner (they never had any), and nothing changed. Do not drag anything.

## 3. MCP round trip (tabulahq only, on the scratch board)

- [ ] In the app, open the board menu, **AI tool access**, and make two tokens: `v5-write` (scope **Read and edit**, **Only these boards**: the scratch board) and `v5-read` (scope **Read only**, the scratch board). Copy each once; do not put them in a chat, a file in the repository or a screenshot.
- [ ] Run the script, with the tokens in the environment for that one command: `TABULA_TOKEN_WRITE=… TABULA_TOKEN_READ=… node scripts/qa-v5-acceptance.mjs --url https://tabulahq.thetabula.cloud --board <scratch board id> --pause-for-watch`. Everything must say PASS. It checks the tool list for each scope, a read token being refused the write tools, `javascript:` and other bad links being refused with no card created, bad due dates and unknown labels refused, add, update, move and the agent owner, and it deletes what it made.
- [ ] While the script pauses (it says "watch the scratch board now"), have the board open in the browser: the cards **appear live**, change lane when moved and disappear at the end, without a reload. At 1280, and once at 390.
- [ ] A card made by the agent shows an **agent owner badge** (octagonal) on the card, in the card dialog and in the phone list sheet.
- [ ] **Scope**: with the write token, `list_boards` shows only the scratch board; asking for the HQ board answers not found.
- [ ] **Revoke**: revoke `v5-write` in the app, run `whoami` or any call with it: it is refused at once (401).
- [ ] Revoke `v5-read` as well, then delete the scratch board. No token with workspace-wide scope is ever made for this, and nothing is made on HQ.

## 4. The AI button rule

- [ ] On the scratch board of a workspace with **no AI key and no credits**: the board shows no AI button, no AI bar and no AI item in the menus or the rail. Admin, **AI** tab, is where setup lives and it says so.
- [ ] With **a key added** (only if TL or Johan says to, never with a real key pasted into a test): the AI button appears on the board; remove the key: it goes away on the next page load.
- [ ] A **guest**, or a member when "members only" is on, never sees the button.

## 5. Nothing else broke (tabulahq and acme)

- [ ] Comments: add one, reply, resolve.
- [ ] Chat (if on): send a message with åäö and an emoji.
- [ ] Share dialog opens; the people list is right. Join codes stay off unless TL turned them on.
- [ ] Admin: Members, Teams, Access tokens, AI, Backups and Audit open; **Backups** shows the last backup time; the Audit list shows the sign-in you just made.
- [ ] Export a board as PNG and as a board file.
- [ ] The workspace address answers `/api/health` with ok.

## Result

| Workspace | Date | Release label | Result (go / no-go) | Failed lines |
|---|---|---|---|---|
| tabulahq | | | | |
| acme | | | | |

If a line fails: stop on that workspace, keep the screenshot and the console text, and tell TL and the manager. The rollback is TL's (see `docs/releasing.md` and `docs/cloud.md`).
