# Chat privacy re-review (CDX-49)

Reviewed the requested base `ca1a5e0f6142aaeca9ee7da8ab01bc2e006028dd` on branch `codex/chat-privacy-recheck`. The only file changed for this task is this review report.

## Findings

- **P1 — An old account’s in-flight edit can expose its message in the next account’s channel and cache.** `src/chat.ts:733-750` applies edit, delete, and reaction responses after `await` without checking the identity generation. `resetChat` clears messages and increments the generation but retains channel objects (`src/chat.ts:827-873`); a late response can therefore repopulate the retained channel, and `saveChannel` scopes the write to the then-current user (`src/chat.ts:335-339`). **Fix:** capture generation and user ID before each request and discard the response if either changed.

- **P1 — Definitive channel denial leaves private history renderable.** The `closed`/non-rate-limit `denied` handler only marks the channel lost (`src/chat.ts:305-307`); a channel 404 does the same (`src/chat.ts:414-416`), and a WebSocket 4401 only sets `signedOut` (`src/chat.ts:222-224`). The chat UI still renders `view.messages` (`src/ui/chat.ts:752`), including cached content. **Fix:** clear the in-memory history and scoped cache when the server definitively denies access or expires the chat session.

- **P1 — A delete frame can be undone by a slower cache read followed by a REST failure.** A delete received while the list is empty is remembered but cannot alter a message yet (`src/chat.ts:299-303`); the pending IndexedDB read can then restore its old text (`src/chat.ts:378-381`). Arrival reconciliation occurs only after a successful REST page (`src/chat.ts:391`), so the failure path leaves that text displayed (`src/chat.ts:404-417`). **Fix:** apply pending tombstones immediately after restoring cache and again on the offline/error path.

- **P2 — Reconnect catch-up can retain history that the server already purged.** Paging stops once fetched history overlaps the cached newest ID (`src/chat.ts:447`), then merges that partial page with all cached history (`src/chat.ts:450-456`). If retention removed an older cached item just outside the fetched page, it remains visible and is saved again. **Fix:** fetch through the cached history window before reconciliation, or replace it with a server-authoritative retained-history snapshot.

- **P2 — A channel reload can overlap reconnect catch-up and overwrite live frames.** `catchUp` only checks `ch.loading` when it starts and uses the shared `ch.arrived` map (`src/chat.ts:430-437`). Reopening a channel starts `load` and replaces that map (`src/chat.ts:680-687`, `src/chat.ts:371-372`); the competing completions can replace each other’s message list (`src/chat.ts:391`, `src/chat.ts:456-461`). **Fix:** serialize all history fetches per channel or give each fetch its own arrival set and reconcile both results.

- **P2 — A synchronous chat-reset exception can reject sign-in and leave the UI waiting.** `clearUserChat` calls `resetChatForAuth` before wrapping its result in `Promise.resolve` (`src/auth.ts:125-127`). `resetChat` emits synchronously before returning its cache promise (`src/chat.ts:872-873`), and `emit` calls listeners without isolation (`src/chat.ts:143-145`). A throwing listener therefore escapes the cleanup catch; the verify and invite flows await `setSignedIn` without recovery (`src/ui/signin.ts:110`, `src/ui/signin.ts:162`). **Fix:** invoke the reset callback inside a promise chain and catch synchronous as well as asynchronous failures.

- **P3 — Two tests do not await the now-async identity setter.** `test/guest-expiry.test.ts:232` reads auth state immediately after an unawaited `setSignedIn`, and `test/ai-live-camera.test.ts:364` proceeds into its signed-in scenario without awaiting it. **Fix:** make those tests async and await `setSignedIn` so assertions observe the committed state and rejection.

## Reviewed with no additional cross-user issue found

- **Ordinary sign-out and same-tab account changes:** cache preparation runs before the new identity is committed (`src/auth.ts:241-250`, `src/auth.ts:355-375`); chat reset bumps the generation and closes the socket (`src/chat.ts:827-873`). Replaced-socket callbacks check socket identity (`src/chat.ts:200-201`, `src/chat.ts:207-208`, `src/chat.ts:217-219`).
- **Offline start and expired `/api/me` session:** network/config failures may restore the cached identity as offline (`src/auth.ts:253-305`), while `/api/me` 401 signs out. Chat cache reads remain scoped to that identity. The WebSocket 4401 display behavior is covered by the denial finding above.
- **IndexedDB scoping and legacy rows:** v1 unscoped stores are dropped on upgrade (`src/chat-cache.ts:33-42`); channel keys and row-owner checks are user-scoped, and outbox reads filter by owner (`src/chat-cache.ts:75-84`). A failed best-effort purge can leave old rows at rest but does not make them readable under another user ID.
- **Stale outbox completion:** outbox reads and flushes capture generation/user ID and discard stale completions (`src/chat.ts:503-514`, `src/chat.ts:526-549`).
- **Forged BroadcastChannel/storage identity values:** a supplied user ID is only an invalidation hint; the client clears identity metadata and confirms through `/api/me` before committing an account (`src/auth.ts:146-172`, `src/auth.ts:276-285`). A forged sign-out marker can force local sign-out/cache deletion, which is a same-origin availability action, but it does not authenticate as another user or transfer their data.
- **Successful tombstone/load and wide catch-up paths:** successful REST loads reconcile arrivals and deletes (`src/chat.ts:388-403`), and successful wide catch-up reapplies live frames (`src/chat.ts:437-466`). Existing tests cover these paths in `test/chat-client-privacy.test.ts:318-400`.
- **Runtime `setSignedIn` callers:** the auth refresh, verify, invite, and profile-update call sites await the promise (`src/auth.ts:328`, `src/ui/signin.ts:110`, `src/ui/signin.ts:162`, `src/ui/board.ts:886`); the refresh runner catches errors (`src/cloud-logic.ts:122-150`). The synchronous reset finding above is the remaining rejected-switch path.

## CDX-50 second review

**Verdict: issues remain; not ready to merge.** The CDX-49 fixes are present: edit/delete/reaction replies are fenced by identity and access revision, denial clears channel history/cache/outbox, cache and REST reconciliation reapplies pending tombstones, catch-up uses the fetched server page set, history reads serialize, and reset/listener exceptions no longer reject sign-in. The two previously unawaited `setSignedIn` tests now await it.

- **P2 — A stale read-marker error can invalidate the next account's channel.** `putRead` sends `api.chatRead` and passes any rejection to `handleChatFailure` without capturing a request identity (`src/chat.ts:753-762`). If account A's in-flight read returns 404 after the retained channel is reset for B, it calls `denyChannel` on B's channel and removes B's cached copy. The server returns 404 when `channelFor` no longer grants read access (`server/chat-routes.mjs:47-52,274-286`). A stale 401 can reset chat state and clear the whole chat cache. Capture a `HistoryRequest` before the call and ignore errors after it becomes stale.
- **P2 — A deleted message can briefly reappear from a late live frame.** During a history request, a delete is saved in `ch.arrived`, but a later message frame is merged and emitted without reconciling that tombstone (`src/chat.ts:307-314,322-328`). The current test explicitly expects the stale text to render until REST fails (`test/chat-client-privacy.test.ts:587-606`). Reconcile the pending tombstone before emitting the live merge and change the assertion to keep deleted text hidden throughout.
- **P2 — A late send success can repopulate a denied channel view.** `flush` fences account changes but not the channel's access revision or `lost` state after `chatSend` resolves (`src/chat.ts:647-654`). If a denial frame clears the channel while a send is pending, the late response merges the sent message back into `ch.messages` (cache writing is skipped because `lost` is true). Check the channel revision/state before applying the response.

The focused privacy file passes all 19 tests under Node 24.10 with `--maxWorkers=2`; full gates also pass: `npm run lint`, `npm run typecheck`, and `npm test -- --maxWorkers=2` (398 files, 8,741 tests). Temporary negative controls each failed as expected when reverting the identity guard, denial clear, authoritative catch-up replacement, or async reset wrapper; I restored source files after each check. No ordinary queue deadlock was found: fetch calls use the 8-second `AbortSignal.timeout` where available and the queue continues after settled errors. Without that API, a never-settling fetch (or IndexedDB operation) has no fallback watchdog. Listener exceptions are isolated so one view cannot block auth commit or later listeners; they are swallowed without diagnostics, but I found no required core operation depending on propagation.

Successful catch-up also replaces previously loaded older pages with the fetched window; those messages can be fetched again through the returned `next` cursor. This is a possible usability regression, not a privacy leak.

## Verification

Ran the repository gates under Node `v24.10.0` from this worktree (using the existing checkout's `node_modules` through a local symlink):

- `npx tsc --noEmit` — passed.
- `npm run lint` — passed.
- `npm run changelog:check` — passed (186 fragments).
- `npm test -- --maxWorkers=2` — passed (393 files, 8,672 tests).
