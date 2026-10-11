# Team chat security review

Task CDX-35 reviewed the chat implementation at base `3dc5dc8e323d0a5bf8eb70d3c38ab8f9a14cc836` and compared the chat changes at `1e403faa5080840e8db744101e95a03b7df4ac11` (`devops/chat-default-on`). This is a static code review. No source changes were made.

## Findings

### P2 — Chat history reads are unthrottled on the base revision

**Location:** `server/chat-routes.mjs:182-189` on the base revision.

An authenticated channel reader can request an unlimited number of pages, each containing up to 100 messages. Every request performs synchronous SQLite reads and serializes a response, and the base chat limiters do not cover this endpoint.

**Exploit sketch:** A channel reader repeatedly paginates `/api/chat/<kind>/<ref>/messages?limit=100` to consume relay capacity.

**Fix:** Apply a per-user sliding-window limit to history reads.

**Comparison:** The reviewed DevOps commit fixes this on its branch by adding a 120-requests-per-minute `history` limiter and an API test.

### P2 — Switching accounts can leave the previous user's chat socket active

**Location:** `src/auth.ts:229-233`, `src/chat.ts:154-167`, `server/auth.mjs:168-169`, and `server/chat-hub.mjs:141-153,187-203` on both reviewed revisions.

`setSignedIn` changes the active app identity without resetting chat. Login verification creates a new session without revoking the prior one; `connect()` reuses an already-open socket, and the server binds that socket to the user authenticated at its handshake. The chat auth listener resets only on sign-out. The browser's cookie can therefore change to a second account while the first account's still-valid socket continues to subscribe and receive messages.

**Exploit sketch:** A signs in and opens chat, then B uses a valid sign-in link in the same tab and navigates to a known A-only channel. B's REST request is denied, but the reused socket subscribes as A and delivers channel messages to the tab now used by B.

**Fix:** On an authenticated user-ID change, close the old socket and reset in-memory chat state; scope persisted chat cache records to the signed-in user or clear them during the transition.

### P2 — An empty history response can preserve messages past the retention period

**Location:** `src/chat.ts:320-324,334-347` and `src/ui/chat-logic.ts:65` on both reviewed revisions.

When retention removes every message from an inactive channel, the successful history response is empty and `newestId([])` is `0`. The client then retains every cached message because each ID is greater than zero and writes the retained history back to IndexedDB. The configured retention period therefore does not remove those messages from a browser cache when the channel is reopened online.

**Exploit sketch:** After all messages in a channel expire, a person who previously opened it revisits it online and still sees the cached history, which is saved again.

**Fix:** Reconcile cache entries against successful server history responses, including empty pages. Preserve only messages known to have arrived while that request was in flight.

## Coverage notes

- **HTTP authorization:** Chat REST routes require an authenticated session. Channel and message routes check live read/write/moderation access; hidden or missing channels return 404. Admin export and erasure require workspace-admin access, with the additional owner restriction for erasing an owner's messages. No direct server-side channel-object authorization bypass was found.
- **Channels and guests:** Implemented channel kinds are board, team, and workspace; DMs are not implemented. The guest HTTP surface excludes chat routes, and the WebSocket upgrade rejects guest sessions. In the base docs, `docs/chat.md:17,95-96` still says guests can read board/team chat; the runtime denies that access. The DevOps table updates this wording, although its overview at line 17 remains stale.
- **Message and attachment bounds:** Chat JSON message bodies are capped at 16 KiB, normalized text at 2,000 code points, and mentions at 10. Chat has no binary attachment route; `objectId` is a board-object reference. Board asset uploads use separate size, pixel, quota, and rate limits.
- **Rate limits:** Posting, edits/deletes, reactions, channel metadata, unread summaries, and read markers have per-user limits. The missing history-read limit is Finding 1. The DevOps branch adds it.
- **Rendering and mentions:** Message and notice text is rendered with text nodes/`textContent`; links are restricted to HTTP(S) and use `noopener noreferrer`. Mention IDs are resolved against current channel read access. Email delivery rechecks recipient access, preference, unread state, mention presence, and per-channel/per-day limits. No reachable XSS or mention-email injection issue was found.
- **WebSocket:** The relay requires an exact configured Origin in accounts mode, authenticates the session cookie, rejects guests, caps client frames and subscriptions, and rechecks channel access on subscribe and access-change events. Finding 2 concerns a client reusing a socket authenticated as a prior account.
- **Retention and deletion:** The server retention job deletes expired message, mention, and reaction rows; user deletion and administrative erasure use tombstones as documented. Backup copies may retain prior content for the configured backup-retention window, documented as 48 hours of hourly and 30 days of daily copies by default. Finding 3 concerns the separate browser cache.
- **SQL injection:** Queries use bound parameters. Dynamic placeholder lists are sized from internal message-ID batches; no user-controlled SQL construction was found.

## Comparison summary

The DevOps revision adds the chat history rate limit, defaults chat on in accounts mode with an explicit opt-out, and restricts the mention-mail delay override to test mode. The account-switch socket and retention-cache findings remain in that revision. No other medium-or-higher findings were confirmed in the requested review areas.
