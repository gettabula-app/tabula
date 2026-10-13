# Notifications

Per-person notifications are stored in `user_notifications` in `directory.sqlite` (migration 18). Card reminders keep their index in `card_due` (migration 19, see Card reminders below). The table keeps the recipient, kind, actor, board or team, source id, and timestamps. It never stores comment or chat text. The API reads snippets and current names at list time, after checking that the recipient can still open the source.

The API merges these rows with the tracker's existing `notifications` table. Tracker events are not copied, and their `read_at` remains the tracker read state. Rows with a lost or missing source are omitted from pages and counts. The unread summary counts up to the newest 200 accessible unread rows; `unreadMentions` includes chat mentions and tracker mentions.

## API

All routes require a signed-in account and return `Cache-Control: no-store`.

- `GET /api/notifications?limit&before&unread=1` returns `{items, nextCursor, unread, unreadMentions}`. The default page size is 30 and the maximum is 50. `before` is an opaque keyset cursor. `unread=1` limits the page to unread items.
- `GET /api/notifications/unread` returns `{unread, unreadMentions}`.
- `POST /api/notifications/read` accepts `{ids: [...]}` with at most 100 unified item ids, or `{all: true}`. It returns `{updated, unread, unreadMentions}`. Tracker rows are marked through the tracker's own `read_at` field.

Each item is `{id, kind, at, read, actor, board, team, snippet, target}`. `actor` is `{id,name}` or `null`; `board` is `{id,title}` or `null`; `team` is `{id,name}` or `null`; `snippet` is text or `null`. Unified ids use `n_` for `user_notifications` and `t_` for tracker rows. Kinds are `chat_mention`, `comment_reply`, `board_shared`, `team_joined`, `card_assigned`, `card_due_soon`, `card_overdue`, or `ticket_<tracker-kind>`.

Targets use the current app routes: chat channel hashes, board hashes, the home hash for team joins, and `/t/<ticket-key>` for tracker items. Chat targets open the channel; comment and card targets open the board (the app has no card deep link yet).

## Writers and read state

- Chat mentions create one row for each mentioned person other than the author. When that person's `chat_reads` cursor passes the message id, the row becomes read.
- A reply to an existing comment thread creates a row for the thread author when another account writes it. The relay's comment guard observes accepted Yjs replies; the MCP comment writer reports its reply through the same room write path. 
- A new comment or reply that names someone with `@{userId}` (the picker writes this token) creates a `comment_mention` row for each named person, up to 10, other than the author, who can open the board. A reply that names the thread author creates the mention row instead of a `comment_reply` row. Edits, imported comments and comments from before accounts do not notify. Rows hold ids only; the snippet is read when the list is built.
- A direct user share creates a row for the shared person. Team shares and link shares do not.
- A newly accepted team invite creates a row for the inviter. The joining person is the actor.
- A card whose person owner changes to someone else, by a connected editor, creates `card_assigned` for the new owner. It is never sent for self-assignment and at most once per person and card in 10 minutes.

## Card reminders

A card with a person owner (not an agent), a `due` date and a lane that is not `done` has a row in `card_due`: the board, card id, owner, due date and the reminder flags. The table never holds card text. The board room's update hook keeps it current for every board write, including MCP and tracker writes. Only a connected editor's write names an actor for `card_assigned`.

A 15-minute sweep (in SQL, in UTC dates) records `card_due_soon` for a due date of today or tomorrow, and `card_overdue` for a due date before today. Each kind is recorded once per due date, tracked by `soon_for` and `overdue_for`; changing the due date or the owner re-arms them. A person who has lost the board role gets no row, and the row is kept for when they regain it. Rows whose due date is more than 30 days old are deleted.

A one-time boot pass indexes every non-deleted board and sets the settings key `card_due.indexed`. Quiet hours and per-kind settings are not built yet; `shouldNotify` in `server/card-due.mjs` returns true for now.
- Tracker rows remain in the tracker's notification table and are merged at read time.

No new email is sent. When a row is created or marked read, connected `/chat` sockets for its recipient receive `{t:'notify', unread, unreadMentions}`. The frame contains counts only.

## Retention and schema

An hourly relay sweep deletes personal and tracker notification rows older than 90 days and caps each user's combined inbox at 500 rows. Unread rows are kept ahead of read rows when enforcing the cap. Migrations 18 and 19 are additive and declare `minReader: 11`, so the existing rollback floor is unchanged. `test/tracker-rewind.ts` removes both tables when tests rewind the schema. `TABULA_TEST_CARD_DUE_SWEEP_MS` shortens the card sweep for tests.
