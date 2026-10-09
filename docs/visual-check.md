# Visual check

`npm run visual` takes screenshots of the app in headless Chromium, with no browser window and no shared Chrome. It is for agents and people who want to look at a change at several widths and in every theme. Use the shared Chrome only for what headless cannot do: your own signed-in sessions, real devices, OS dialogs.

## One-time setup

```bash
npm ci
npx playwright install chromium
```

`playwright` is a pinned devDependency (no `@playwright/test`). The browser is not part of `npm ci` and the script never installs it: when it is missing the script prints the `npx playwright install chromium` line and stops. Chromium is about 190 MB, kept in Playwright's own cache folder, outside the repository.

## Run it

```bash
npm run visual -- --id TAB-123
npm run visual -- --id TAB-123 --states board,settings --themes default,matrix --widths 390,1440
npm run visual -- --id TAB-123 --mode accounts --states admin --themes default --widths 1024
```

`--id` is required and names the folder: the shots go to `tabula-review/<id>/<state>-<theme>-<width>.png`, next to an `index.html` contact sheet that shows every shot with its theme and width. Open it, or open single files. The last line says how many shots were taken, where and how long it took. The script exits with 1 when a shot failed (a `-FAILED.png` shows what the page looked like) and 2 for bad options. The contact sheet lists the shots of the last run only; files from earlier runs stay in the folder, so delete it for a clean one. `tabula-review/` is git-ignored.

| Option | Default | Meaning |
| --- | --- | --- |
| `--id <id>` | none, required | Folder name, for example `TAB-123` (letters, digits, `.`, `-`, `_`) |
| `--mode open\|accounts` | `open` | `accounts` runs the relay with `TABULA_AUTH=on` and signs the owner in |
| `--states a,b` | all for the mode | `home`, `board`, `board-selected`, `board-selected-folded`, `comments`, `templates`, `settings`, in open mode the `kanban` states below, and in accounts mode `admin`, the six `backups-` states below, `chat`, `chat-composer` and `chat-unread` |
| `--widths 360,1440` | `360,390,500,860,1024,1440` | Window widths; the height is 844 up to 500 wide and 800 above |
| `--themes default,ayu` | every theme in `src/themes.ts` | `default`, `ayu`, `kanagawa`, `matrix`, `evergreen` |
| `--dark`, `--light` | both | Only themes whose colour scheme is dark or light (the app has no `prefers-color-scheme` split; each theme carries its own scheme) |
| `--out <dir>` | `tabula-review` | Parent folder of `<id>` |
| `--no-build` | build first | Reuse `dist/` when it exists; otherwise `npm run build:app` runs. With `DIST_DIR` set, that folder is served and nothing is built |
| `--frameable` | off | Starts the throwaway relay with `TABULA_DEV_ALLOW_FRAMING=1` (see below) |
| `--help` | | Prints the options |

The full default matrix is 420 shots in open mode (6 states and the 8 kanban states, 5 themes, 6 widths) and about four minutes on a laptop, 450 shots in accounts mode (12 states and the three chat states; the kanban states are open mode only). Pass `--states` to take fewer.

## States

| State | What it shows |
| --- | --- |
| `home` | The boards list with three boards (Sprint retro, Roadmap 2026, Meeting notes) and the template strip |
| `board` | The seeded board fitted to the window, a comment thread pinned to a note |
| `board-selected` | The same board with the Backlog rectangle selected: quick-action bar and the properties panel open |
| `board-selected-folded` | As `board-selected`, with the properties panel folded to its title row at phone widths (860 px and below); wider windows look like `board-selected` |
| `drawer-stickers` | The seeded board with the Stickers drawer open (the icon sets are only there after a full `npm run build`; `build:app` shows the drawer's "could not be loaded" state) |
| `history` | Version history open from the board menu |
| `comments` | The side tray open on Comments (with chat on, its Comments and Chat tabs) |
| `empty-templates`, `empty-share`, `empty-menu` | An empty board (the "An empty board" hint) under the Templates drawer, the Share dialog and the board menu |
| `empty-focus` | The empty board with a focus request card from a second person (Ana, in a second browser context that sets the request on its awareness) |
| `templates` | `#/templates` |
| `settings` | The Board settings dialog over the board |
| `kanban` | (open mode only, as are the other `kanban` states) A second seeded board (`visual-kanban`) with a kanban like the design mock's (four lanes, a WIP limit, a blocking lane, a done lane, labels, due dates, owners, a comment) beside a frame of notes; fitted to the window, on a phone to the kanban alone |
| `kanban-card` | The same with a card selected |
| `kanban-drag` | A card held down and dragged into another lane: placeholder, ghost and drop line (the mouse stays down, so the shot is not parked) |
| `kanban-drag-empty` | A card dragged over an empty lane: "Drop here" and the drop line at the top of its body |
| `kanban-keyboard` | A card moved with Alt+arrows: the ring, the "Moving" tag and the live region |
| `kanban-adding` | The inline "+ Add card" input with a title typed (not parked, so it keeps focus) |
| `kanban-wip` | A fourth card in the lane with a limit of three: the danger count and rule |
| `kanban-lowdetail` | The kanban at zoom 0.3: titles as bars, chips as colour, lane headers as names |
| `admin` | `#/admin`, the Overview tab, signed in as the owner (accounts mode only) |
| `backups-list` | `#/admin/backups`: the status and the list of seven backups (two protected, two unreadable). Accounts mode; the backup routes are answered with fixed data and the shot is the whole page |
| `backups-detail` | The first backup opened in place: facts, free space, how long the old data is kept, the two actions (whole page) |
| `backups-board-copy` | **Restore a board as a copy**: the boards of the backup with one picked (whole page) |
| `backups-confirm` | **Restore the whole workspace**: what will happen and the word to type, the button still off (whole page) |
| `backups-restoring` | The **Restoring…** screen after the restore was accepted (the fixed data keeps `/api/health` saying `restoring`) |
| `backups-off` | The Backups tab on a server without backups (the throwaway relay itself answers `backups_off`) |
| `chat` | The board with the side tray open on Chat (accounts mode only): a conversation of three people over two days with an edited message, a deleted one, a reply, mentions, a long link and the **New messages** line |
| `chat-composer` | The same, with `Thanks @b` typed and the people list open |
| `chat-unread` | The board with Chat closed: the Chat button's unread badge, outlined for a mention |

A state is one small function in `scripts/visual-check.mjs`; add one there and it becomes a `--states` value. It should wait for something it can name (a role, an `aria-label`, a class), not for a pause. A state whose page is longer than the window and whose point is the whole page goes in `FULL_PAGE`, which makes its shots full-page; a state that needs answers the throwaway relay cannot give routes them with Playwright (`mockBackups`). After a state the script parks the mouse in a corner and blurs the focused control; a state that must keep the mouse down or an input focused returns `{ noPark: true }`. The kanban seed stores card heights with the board's fonts loaded (`window.__kanban.cardContentHeight`), as the app does.

## What the script does

- Starts `node server/relay.mjs` as a child with a fresh temporary `DATA_DIR`, `HOST=127.0.0.1`, a free port and `QUIET=1`, serving the built app. Nothing from your shell reaches it (`TABULA_*`, `MIRA_*`, `PORT`, `DATA_DIR` and the like are dropped), and it starts in the empty data folder, so no `.env` file is read.
- Accounts mode: `TABULA_AUTH=on`, `TABULA_MAIL=file`, `TABULA_OWNER_EMAIL=owner@example.test`, and `TABULA_CHAT=on` when a chat state is asked for. The chat states sign two more people in through a team invite (Ana Lima and Ben Okafor), share the board with the team and post the conversation through `POST /api/chat/...` with each person's own session; the server stamps the real time, so the script then moves the times next to the browser's fixed clock in `chat.sqlite`, and puts the owner's read marker back before each shot. The script asks for a sign-in link with `POST /api/auth/request`, reads the token from `<DATA_DIR>/outbox.jsonl`, verifies it with `POST /api/auth/verify` and gives the browser the session cookie. It then creates the home boards through `POST /api/boards`.
- Seeds the board through the `?debug` handle (`window.__board`): a frame pair with six sticky notes, a rectangle, a diamond, an ellipse and a rounded rectangle, text, five connectors (two leave the same side of the rectangle) and one comment thread with a reply. Ids, positions and text are fixed, the first page writes it and the relay keeps it for the rest of the run.
- Takes every shot in a fresh browser context, so one state never leaves anything behind for the next.
- At the end, in a `finally` block and on Ctrl+C: closes the browser, stops the relay by the process id it started, and deletes the temporary folder.

## What is fixed, and what is not

Fixed: the browser clock (15 January 2026, 10:00 UTC, so "5 min ago" reads the same every time), locale and time zone, the user (Visual QA), reduced motion (the fit and fly animations land at once), the seed and the order of the boards. The service worker is blocked. Fontshare fonts are fetched once per run and replayed from memory; every other outside host is refused. Without a network the app falls back to its system fonts, and the shots then differ from a run with network.

Not fixed:

- A few anti-aliasing pixels (differences of a few steps in 5 to 80 pixels) can change between runs of board shots. Look at the shots; do not compare checksums.
- Accounts mode times come from the server's clock: boards show "just now", and the admin Overview shows the relay's address with its random port.

Each shot also checks that the page is not wider than the window and that no script error was thrown; either is marked in the contact sheet and printed after the run.

## Docs images

`npm run docs:images` re-creates the screenshots of the README and the user guide in `docs/images` (the user guide serves its screenshots from the same folder, so there is one copy) from the built app. It starts two throwaway relays, an open-mode one and an accounts-mode one (on port 8787 when that is free, so the Share dialog shows an ordinary address), seeds fixed demo data (the board objects, a Design team with Maya and Ana, Sam in a second team, the boards and shares the shots need) and takes each image in a fresh headless context at 2x with the clock, locale, zone and theme fixed.

```bash
npm run docs:images                                  # all eleven, into docs/images
npm run docs:images -- --only share-roles,signin     # some of them
npm run docs:images -- --out /tmp/shots --no-build   # elsewhere, reusing dist/
```

The images are: `shapes-panel`, `quick-actions`, `text-options`, `locked-badge`, `themes-menu-matrix`, `theme-ayu`, `business-model-canvas` (written as `template-business-model-canvas.png`), `signin`, `teams-home`, `access-removed` and `share-roles`. Change the code in `scripts/docs-images.mjs` when the UI moves; look at every image after a run, because a crop that was right can pick up a new bar or badge. Fontshare fonts are fetched once per run; offline, the shots use the system fonts.

## Letting a page frame the app

The relay answers with `Content-Security-Policy: ... frame-ancestors 'none'`, so a page cannot embed the app in an iframe. `TABULA_DEV_ALLOW_FRAMING=1` leaves that one directive out (the rest of the policy stays) and makes the relay print a warning on stderr. It exists for width checks in a browser that cannot be resized: embed the app in an iframe of the width you want. **Never set it on a server people use**, it removes the protection against clickjacking.

- `npm run build`, then `TABULA_DEV_ALLOW_FRAMING=1 npm start` serves the built app on port 8787 so it can be framed. `TABULA_DEV_ALLOW_FRAMING=1 npm run dev` does the same for the relay behind the dev server.
- The Vite dev server (`npm run dev`, port 5173) sends neither `X-Frame-Options` nor a `frame-ancestors` policy, so it can be framed as it is.
- `npm run visual -- --frameable` starts the throwaway relay with the flag. The screenshots do not depend on it, because the window width is set directly; it only matters if something else embeds that relay's pages during the run.
