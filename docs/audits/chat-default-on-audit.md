# Chat enabled defaults audit (CDX-31)

Repository: `/Volumes/External/tabula/tabula`  
Base: `0028c5b420525552967b8d905b6338f212d61f79`  
Audit worktree: `/Volumes/External/tabula/wt/codex-chat-audit`, branch `codex/chat-audit`  
Scope: report only; no source or configuration changes.

## Findings

### P1 — Join-code guests cannot use chat, despite the documented guest access

`docs/chat.md:95-97` says board chat includes guests given the board and team chat includes guests who are team members. The current join-code guest flow cannot reach that UI or API: `src/auth.ts:136-139` makes `chatAvailable()` true only for signed-in/offline `/api/me` state; `src/ui/board.ts:207` consequently omits the board Chat button; `src/main.ts:409-412` redirects `#/chat`; and `src/ui/topbar.ts:62` omits the Chat link. On the server, `server/chat-access.mjs:79` excludes guests from the workspace channel (as documented), while `server/api.mjs:1328-1351` limits a join-code guest cookie to the single board's assets/version endpoints and blocks all chat routes, including the documented board/team scope.

**Fix:** either extend guest identity, channel authorization, UI, and API consistently for the documented board/team scope, or change the spec to say join-code guests are excluded from chat.

### P2 — Mention email is opt-out for every person when chat is enabled

An unset `chat.emailMentions` preference is treated as enabled (`server/chat-notify.mjs:16-17`); the guide says it stays on until turned off (`docs/guide/chat.md:91-95`). If a workspace operator enables chat, a person who has never opened Chat can receive an email after 10 minutes away. It contains the sender, channel, first 140 characters of the message, and a link (`server/chat-notify.mjs:112-143`). Limits are one per person per channel every 10 minutes and 20 per person per day (`server/chat-notify.mjs:59-60`).

**Fix:** if individual consent is the intended policy, default the preference off and make mention email an explicit opt-in; otherwise keep the default but surface it before a person's first chat mention.

### P2 — The chat limits documentation contradicts the implementation

`docs/chat.md:218` describes the posting caps, then says “REST writes have no limiter today.” In fact, posts are limited to 20 per channel per minute, 60 per person per minute, and five per person in two seconds; edits/deletes are limited to 20 per minute; reactions and channel metadata/unread/read operations are limited to 60 per minute (`server/chat-limits.mjs:8-20`; route checks in `server/chat-routes.mjs`). This can leave operators and reviewers with the wrong security and capacity model.

**Fix:** remove the stale sentence and list the route-level write and read limits in the table.

### P3 — Paginated history reads have no per-user rate limit

`GET /api/chat/:kind/:ref/messages` authorizes access and reads a page from SQLite at `server/chat-routes.mjs:182-189`, but does not call a limiter. The neighboring metadata, unread, read-marker, and reaction operations are throttled. A member with access can therefore repeatedly request history pages without a per-user request cap.

**Fix:** add a per-user sliding-window limit to paginated message reads and document it.

### P2 — The test email-delay override can shorten the production delay

The documented 10-minute delay is the fallback (`server/chat-notify.mjs:13-14`), but `server/relay.mjs:274-276` accepts `TABULA_CHAT_MENTION_MAIL_AFTER_MS` from the environment without checking `NODE_ENV`. The code comment says relay tests use it, and `test/chat-slice4.test.ts:13` sets it to 400 ms. An accidental production setting can therefore send mention mail much sooner than users and operators expect.

**Fix:** gate the override on `NODE_ENV=test`, or inject it only through the test harness.

### P2 — The default mail mode logs mention content

`TABULA_MAIL` defaults to `log` (`server/config.mjs:239`; documented in `README.md:94`), and `server/mailer.mjs:15-18` prints the email body to stdout. With chat enabled and no mail transport configured, mention notices are logged rather than delivered; the body includes the first 140 characters of the message. This is disclosed as a general mail setting, but is easy to miss when enabling chat.

**Fix:** make the chat setup guide explicitly call out the log-mode behavior and require an intentional mail mode for deployments that expect delivery.

## Defaults and first-run behavior

- **The feature is off by default.** `TABULA_CHAT` defaults to `off`; `on` works only in accounts mode (`server/config.mjs:77-86`). With it off, the Chat top-bar link and board button are absent.
- **A new chat-enabled workspace has a workspace channel by default.** `workspaceChannel` defaults on and retention defaults to 365 days (`server/chat.mjs:59-72`). The first retention run starts one minute after relay startup and repeats daily (`server/chat-retention.mjs:9-12,60-67`). The admin screen shows “1 year” selected and says backups retain erased messages until they expire; the default backup policy is also described in `docs/chat.md:208`.
- **An empty conversation is prompted.** The empty message pane says “No messages yet. Say hello.” (`src/ui/chat.ts:406-411`). On desktop, opening `#/chat` selects the first channel if there is no unread/mention-preferred channel (`src/ui/chat-page.ts:186-204`; `src/ui/chat-logic.ts:460-473`). On a phone, the page starts with the channel list and the person taps a row to open a conversation; this is consistent with the one-screen-per-phone design noted in `docs/chat.md`.
- **Unread state is visible in the shell.** The Chat top-bar badge sums unread channels, caps at `99+`, uses an outline when there is a mention, and updates its accessible label (`src/ui/topbar.ts:27-47`; `src/ui/home.css:41-46`). The board chat button also shows unread state.
- **Mention mail is person-level, not required to use chat.** The preference can be changed from the board menu or the Chat page notification control (`docs/guide/chat.md:91-95`). Default-on means people who never requested chat can still be emailed after an operator enables it.
- **Viewer behavior:** viewers can read board chat, but cannot post unless the workspace admin enables that option. Workspace/team membership controls the other channels; the workspace channel is not available to guests (`docs/chat.md:95-97`; `server/chat-access.mjs:77-81`).

## Visual review

Ran all existing chat visual-check states in accounts mode with `TABULA_CHAT=on`, Default and Ayu themes, and widths 390 and 1280: 16 states × 2 themes × 2 widths = 64 screenshots. The harness reported **0 cases with problems** and **64 screenshots** at:

`/Volumes/External/tabula/wt/codex-chat-audit/tabula-review/CDX-31/`

Index: `tabula-review/CDX-31/index.html`. The visual seed includes messages, so the empty first-run prompt was checked in source rather than claimed from a screenshot. The screenshots show the unread badge on the board shell and the Chat page, and the checked-on mention-email preference.

## `TABULA_CHAT` inventory

Literal `TABULA_CHAT` matches across tracked source, tests, scripts, documentation, and history:

- **Runtime/source:** `server/config.mjs:77,80-83` (switch comment, environment read, validation, open-mode warning); `server/relay.mjs:223` and `server/chat-routes.mjs:1` (comments); `server/relay.mjs:275` reads the separate `TABULA_CHAT_MENTION_MAIL_AFTER_MS` delay override. The parsed config gates chat setup at `server/relay.mjs:249` and API routes at `server/api.mjs:429`.
- **Scripts:** `scripts/a11y-flows.mjs:41`, `scripts/docs-images.mjs:73`, `scripts/qa-join-codes.mjs:102`, `scripts/qa-regression-sweep.mjs:16`, and `scripts/visual-check.mjs:42,394,3946`.
- **Tests and fixtures:** `test/chat-api.test.ts:7,457,464,467`; `test/chat-channels.test.ts:6`; `test/chat-config.test.ts:4,13,19-21,25,27,35`; `test/chat-slice4.test.ts:6,13`; `test/chat-socket.test.ts:8`; `test/drill/restore.drill.test.ts:88`; `test/internal-stats.test.ts:39`; `test/internal-version.test.ts:39`. The `chat-slice4.test.ts:13` match is the similarly named email-delay override, not the feature switch.
- **Docs/history:** `README.md:102`; `docs/chat.md:3,307`; `docs/visual-check.md:130`; `CHANGELOG.md:64,80`.

`docs/chat.md:3` calls `TABULA_CHAT_MENTION_MAIL_AFTER_MS` undocumented while naming it there; the implementation comment and test also show its use. The feature flag itself is documented in `README.md:102` and `docs/chat.md:3`.
