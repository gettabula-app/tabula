# Test coverage gaps

## Method

The repository does not configure Vitest coverage: `package.json` exposes `vitest run`, and no coverage provider or coverage settings were found in the Vite configuration. I mapped relative imports from `test/` to `src/` and `server/` modules, then checked the relevant integration suites and source branches. A missing direct import is only a signal: several server modules are exercised through the relay harness. The findings below name a specific behavior that deserves a focused assertion; they do not claim that a module has no indirect coverage.

Ranks reflect potential impact to access, privacy, data integrity, and user recovery, weighted by how directly the behavior is asserted today.

## Ranked findings

1. **Chat retry after access loss — `server/chat-routes.mjs`**
   No direct test import was found. `test/chat-api.test.ts` tests idempotent `clientId` retries and inaccessible-channel 404s separately, but not a retry after access is revoked; the route checks current channel access before returning a stored retry. **Test:** post once, remove the caller’s board share, retry the same `clientId`, and assert a concealed 404 with no message disclosure.

2. **Join-code use race — `server/join-codes.mjs`**
   `test/join-codes-server.test.ts` covers expiry, exhaustion, revocation, and sequential one-use behavior; it does not exercise the service’s transactional re-read after its initial code lookup. **Test:** revoke or exhaust the code between the pre-read and locked re-read, then assert no guest session, use increment, or audit row is created.

3. **Share and audit atomicity — `server/api.mjs`**
   The module has direct imports in 11 test files, mostly for other route groups. Share integration coverage in `test/accounts-server.test.ts` checks normal grants and removals, but no test forces the share audit write to fail. **Test:** make the audit writer throw during a share request and assert the recipient gains no access.

4. **Authorization lost during an asset upload — `server/asset-routes.mjs`**
   No direct test import was found; `test/assets-api.test.ts` and `test/assets-open.test.ts` cover ordinary upload, permission, CSRF, and response paths. The handler intentionally authorizes both before and after reading the body, but that race is not asserted. **Test:** pause a streamed upload, revoke the editor’s access, finish the body, and assert refusal with no stored asset or audit entry.

5. **Chat cache persistence and sign-out clearing — `src/chat-cache.ts`**
   No direct test import was found. `test/chat-outbox.test.ts` covers the pure retry queue, not the IndexedDB stores or `clearChatCache`. **Test:** persist a queued message and channel, reopen the cache, sign out from another tab, and assert neither store can return the previous account’s data.

6. **Share dialog mutation failures — `src/ui/share.ts`**
   No direct UI test import was found; `test/share-logic.test.ts` covers candidate selection and role labels only. The DOM flows for adding, changing, and removing access have no focused assertions for server errors and rollback of the displayed role. **Test:** reject a role update and assert the old role remains selected with no success status.

7. **Chat conversation interactions — `src/ui/chat.ts`**
   `test/chat-objects.test.ts` directly imports the module but tests object chips and reference attachment; `test/chat-page.test.ts` stubs the conversation component. Scroll anchoring, read marking, composer keyboard behavior, and message-action failures lack focused UI assertions. **Test:** prepend an older page while scrolled up and assert the first visible message stays fixed, then scroll to the bottom and assert `markRead` runs.

8. **Unauthorized room creation — `server/relay.mjs`**
   No direct test import was found; relay integration suites exercise many paths, but no test was found that checks the room file after a denied account-mode WebSocket request. Authorization is required before room loading or creation. **Test:** connect without access to a previously unknown board and assert denial plus absence of its `.yjs` file.

9. **Ticket event validation and bounds — `server/tracker/events.mjs`**
   No direct test import was found; tracker API suites inspect successful event rows. Invalid event fields, oversized details, and invalid idempotency keys are not asserted as rejected without a row. **Test:** submit each invalid shape and assert the write fails and `ticket_events` remains unchanged.

10. **Populated tracker frame snapshots — `src/tracker/ui/frame-snapshot.ts`**
    No direct test import was found. `test/tracker-frame.test.ts` checks export of an empty/default snapshot, but not populated rows, XML escaping, row limits, or count clamping. **Test:** publish hostile text and more than 12 rows, render/export the frame, and assert escaped text, bounded rows, and a clamped count.

11. **Command palette async races — `src/tracker/ui/command-box.ts`**
    `test/tracker-command-box.test.ts` covers ranking, a normal debounced search, selection, and Escape, but not overlapping requests, rejection, or results arriving after close. **Test:** resolve two deferred searches in reverse order and assert only the latest results appear, then resolve another request after close and assert the palette stays closed.

12. **Disabled picker options — `src/tracker/ui/picker.ts`**
    `test/tracker-picker.test.ts` covers keyboard navigation and search without any disabled options, although the picker has explicit disabled-option navigation and selection branches. **Test:** put a disabled option between enabled choices and assert ArrowDown and Enter cannot select it.

13. **Join-code revoke retry state — `src/ui/join-codes.ts`**
    `test/join-codes-ui.test.ts` covers creation, copying, and successful revocation; no rejection path was found. The revoke handler disables its button before the request and appears not to re-enable it in the catch branch. **Test:** reject `revokeJoinCode` and assert the code remains active and its revoke button can be retried.

14. **Inbox request boundaries — `server/tracker/inbox-routes.mjs`**
    No direct test import was found; `test/tracker-inbox-routes.test.ts` covers session, row isolation, pagination, CSRF, the 100-ID cap, and preferences. The 8 KiB body cap and the conflicting `{ all: true, ids: [...] }` input are not asserted. **Test:** send an oversized read request and a conflicting all-plus-ids body; assert 413/400 and no read-state change.

15. **Notification subject line sanitization — `server/tracker/notice-mail.mjs`**
    `test/tracker-outbox.test.ts` covers known subjects and line flattening for title, actor, and preview, but not CR/LF in the ticket key used in the subject. **Test:** pass a newline-bearing key and assert the subject is one line and remains within the 64-character key bound.

## Reviewed areas with stronger focused coverage

Backup and restore engines have dedicated suites for consistency, tampering, failed swaps, access control, and recovery (`test/backup.test.ts`, `test/restore-api.test.ts`, `test/restore-guards.test.ts`). Export and import also have focused suites for selected-object snapshots, privacy, format output, Linear pagination, delta imports, rollback, and verification (`test/exporters.test.ts`, `test/export-selection-snapshot.test.ts`, `test/linear-source.test.ts`, `test/linear-import.test.ts`). They were reviewed but did not rank among the clearest next test targets.
