# Hosted workspaces

Tabula can run as one workspace of a hosted service: a separate control plane (billing, provisioning) starts the instance, tells it how many seats the customer paid for, and can lock it when the subscription lapses. This page is the instance side of that contract. It is generic: any control plane that speaks it will do, and **an instance without the variables below behaves exactly as described in `docs/accounts.md`**: none of the routes, tables, banners or checks here exist for it.

Not in it: creating or deleting the instance, Stripe, routing. Those belong to the control plane.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `TABULA_CLOUD_TOKEN` | Shared secret, at least 32 characters, no spaces. The control plane sends it as `Authorization: Bearer <token>`, and the instance sends it back on its own calls |
| `TABULA_CLOUD_URL` | Base URL of the control plane. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only (local development). No credentials, query or fragment; a path prefix is kept, trailing slashes are dropped |
| `TABULA_CLOUD_WORKSPACE_ID` | This workspace's id at the control plane (letters, digits, `.`, `-`, `_`, up to 128). Used in the path of the instance's calls |

Cloud mode is on only when `TABULA_AUTH=on` **and** all three are set.

- None set: nothing changes, the routes below answer `404`.
- Some but not all set: the relay refuses to start and names the missing variables. A token that is too short, a URL that is not allowed or an id that does not fit refuse startup too.
- All set with `TABULA_AUTH` off: cloud mode stays off and the relay logs that the variables are ignored. (The values are still validated.)

## Calls from the control plane

The endpoints below sit under `/api/internal/`. They need the bearer token and nothing else: no cookie, no `x-tabula` header, and a session cookie that comes along is ignored. The token is compared in constant time (both sides are hashed first, so the length of a guess shows nothing). A missing or wrong token answers `401 {error: 'unauthenticated'}` with `WWW-Authenticate: Bearer`. The public edge must not forward `/api/internal/` to browsers.

```
GET /api/internal/usage
  -> { seats, guests, members }
```

`seats` counts people with the role `owner`, `admin` or `member` who are not disabled. `guests` counts guests who are not disabled. `members` is everyone with an account, disabled people included.

```
PUT /api/internal/limits  { seatLimit?: number | null, readOnly?: boolean, banner?: string | null }
  -> { seatLimit, readOnly, banner }      (what is stored now)
```

- Fields that are left out stay as they are; `null` clears `seatLimit` and `banner`. An empty body is `400 Nothing to change`.
- `seatLimit` is a whole number from 1 to 100000. `banner` is at most 300 characters on a single line (no control characters), trimmed; an empty text means no banner. Unknown fields are refused with `400`, so a typo cannot silently do nothing.
- The limits are stored in the `settings` table (`cloud.limits`, one JSON value; migration 3) and survive restarts. Each change writes an audit row `cloud.limits` with no actor (the dashboard shows "System") and tells the relay, which applies it to open sockets at once.
- This endpoint stays reachable while the workspace is read-only (it is how the lock is lifted).

```
POST /api/internal/notify  { template: 'trial-ending', date: string }
  -> { sent }                          (owners mailed)
  -> { sent: 0, duplicate: true }      (this date was notified before; nothing is sent)
```

Asks the instance to mail the workspace owners: every account with the role `owner` that is not disabled, and nobody else. It is how the control plane warns of a trial that is about to turn into a paid subscription.

- The body is strict, like the limits: unknown fields are `400`, and so is any `template` but `trial-ending` (an allowlist, so more notices can be added later). `date` is written as `7 Nov 2026` (day, three letter month, year; nothing else, so it is safe in a subject line). An empty body is `400` too.
- Each owner gets one mail through the instance's own mailer (see `TABULA_MAIL` in the README) with `template: 'trial-ending'`, `params: { link, date }` (`link` is the workspace address, `<TABULA_BASE_URL>/`) and the subject `Your Tabula trial ends on <date>`. The `text` says that the free trial of the workspace ends on that date, that the subscription then starts automatically with the card on file, and that the owner can review or cancel it under Admin, Overview, Manage billing, followed by the link on a line of its own. With a mail relay in webhook mode the relay renders its own wording from `template` and `params`; the text is what the `log`, `file` and `smtp` modes send.
- The mails are sent together and awaited. `200 {sent}` counts the owners mailed, so one owner whose mail failed does not fail the call. When every mail failed the answer is `502 {error: 'bad_gateway'}` so the control plane retries; the log says how many failed, never to whom. No owner to mail is `200 {sent: 0}`.
- **A repeat is not mailed again.** After a call that mailed at least one owner, the instance keeps the date in the `settings` table (`cloud.trialEndingNotified`). The same date again answers `200 {sent: 0, duplicate: true}` and sends nothing, also when it arrives while the first call is still sending, so a retried job never mails twice. Only the last date is kept: another date mails again. Nothing is kept after `502` or when there was no owner, so those calls can be retried.
- A call that mailed someone writes an audit row `cloud.notify` with no actor (the dashboard shows "System") and `{template, count}`. Addresses are never stored there.
- Like the limits, this endpoint stays reachable while the workspace is read-only.

## Read-only

While `readOnly` is true:

- **Relay**: every connection is read-only for the board room and the comments room, whatever the person's role. Sockets that are already open are re-evaluated the moment the limits change, in both directions, and told about it (see below). Document updates are dropped, state requests and awareness (cursors) still work.
- **API**: every mutating route answers `402 {error: 'read_only', message}`. Not blocked: all `GET`s, `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/logout`, `POST /api/auth/logout-all`, `PUT /api/internal/limits`, `POST /api/internal/notify` and `POST /api/billing/portal` (the owner has to reach billing to put things right). Signed-out writers still get `401` first.
- **App**: boards open read-only (the same switch as for viewers) with a **Workspace is read-only** badge instead of **View only**; the banner shows as described below. An open board switches within a request round trip of the change, and reconnects when the workspace is writable again.

### Telling open boards at once

A workspace that turns read-only (or writable again) does not wait for the app's next `/api/me` refresh:

- **Hint.** When `PUT /api/internal/limits` changes `readOnly`, the relay sends one small message on every open sync socket, board and comments room alike, after it has re-evaluated that socket. It is binary type **4** (y-websocket uses 0 sync, 1 awareness, 2 auth and 3 query awareness) followed by a `varString` with the JSON `{"readOnly": <bool>}`. Only a change of `readOnly` sends it: not a banner or seat limit change, and not a `PUT` that repeats the value. Sockets that are refused or already closed get nothing, and sockets that connect later need nothing, because they are checked on connect and the app reads `/api/me` on load. The relay never acts on this type when a client sends it (like any unknown type, it is ignored).
- **The app does not trust it.** The payload is only a hint. The handler (`onWorkspaceHint` in `src/sync.ts`, registered on both providers of an open board through y-websocket's per-provider `messageHandlers`) asks `/api/me` and applies the answer exactly as the five minute refresh does: store and comments read-only switch, badge and banner. The board socket and the comments socket each get the hint, and hints within 150 ms become one request. An old client that does not know type 4 logs "Unable to compute message" once per hint and carries on; the five minute refresh still catches it up.
- **Back to writable.** When a refresh shows `readOnly` going from true to false, the board disconnects and reconnects both of its rooms. The fresh state exchange (sync step 1 and 2) sends everything that was typed while the relay was dropping updates, which also clears the stuck socket described below. It is a normal CRDT merge, so nothing is overwritten. This happens whichever refresh learns about the unlock: the one the hint brought forward, the five minute one, or the first one after a hidden tab is seen again. Turning read-only never reconnects, and neither does signing out or a board the relay has refused.

What remains: edits typed in the moments between the relay flipping the switch and the hint reaching the browser are dropped by the relay. They stay in the browser and are sent by the reconnect once the workspace is writable. Until that reconnect the relay cannot apply later edits from that client either, because they build on the dropped ones, so a client that is not told about the unlock (an old client, or a lock and unlock that both fall between two refreshes of a tab that missed the hint) stays stuck until it reconnects or reloads.

## Seats

A seat is an account with the role `owner`, `admin` or `member` that is not disabled. Guests are free. When `seatLimit` is set and the seats in use have reached it:

| Action | Answer |
| --- | --- |
| Create a team invite (`POST /api/teams/:id/invites`) | `409 seat_limit` |
| Finish a sign-in that would create a new member through an invite (`POST /api/auth/verify`) | `409 seat_limit`; nobody is created, and neither the invite nor the emailed link is used up, so the same link works once a seat is free |
| Enable a disabled owner, admin or member, or turn a guest into a member, admin or owner (`PATCH /api/members/:id`) | `409 seat_limit` |

Everything else keeps working: people who already have an account sign in, roles change between owner, admin and member, people are disabled or removed (which frees a seat), existing members accept invites to more teams. `POST /api/auth/request` does not look at the limit, so it answers every address the same way as before and reveals nothing about a full workspace; the link is mailed and the refusal comes when it is used. The messages say how many seats there are and what to do (free one, or ask the owner to add seats under billing). A limit below the number of seats in use blocks new seats but removes nobody.

## What the app shows

`GET /api/me` gains `workspace: { readOnly, banner, seatLimit, seatsUsed }` in cloud mode and only then. The app uses it for:

- A thin banner with the banner text above the home screen and the board (above the board it is a single line and the editing chrome moves down). A read-only workspace without a banner text gets "This workspace is read-only."
- Read-only boards and the badge described above. A viewer stays a viewer when the workspace becomes writable again.
- Toasts with the server's message when a seat limit or the read-only lock stops an invite, a role change, an enable or a sign-in link.
- **Manage billing** on the admin dashboard's Overview, for the workspace owner only. It asks the instance for the portal address and opens it in the same tab.
- A refresh of `/api/me` every five minutes while the tab is open (skipped while the tab is hidden and run when it is seen again; nothing at all in open mode and on servers without cloud mode), and at once when the relay sends the read-only hint. The five minute refresh is the fallback if the hint is missed.

## Calls to the control plane

All with `Authorization: Bearer <TABULA_CLOUD_TOKEN>` and a 10 second timeout; redirects are not followed.

```
POST /api/billing/portal            (workspace owner only; 404 without cloud mode)
  -> { url }
```

The instance calls `POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/portal` and returns its `url`. Anything but an `https://` URL, an error status, an unreadable answer or a timeout is `502 bad_gateway`. Other roles get `403`.

```
POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/usage   { seats, guests }
```

Sent 30 seconds after the last change to the people in the workspace (an account created through an invite, a role change, disable or enable, a removal). A burst of changes is one report, with the counts read when it is sent, and a report that would repeat the last successful one is skipped. A failure is logged (without the token or the answer) and never reaches the request that caused the change; the control plane also pulls `GET /api/internal/usage` now and then. Reports that are still waiting when the process stops are not sent.

## Tests

`test/cloud.test.ts` covers configuration, validation, the seat rules, the portal, the usage reports and the trial-ending notice (owners only, the duplicate guard, partial and total mail failure) in process, with a fake `fetch` and hand-driven timers (both are injectable in `createCloud`). `test/cloud-relay.test.ts` starts the relay next to a fake control plane and covers the endpoints (including the trial-ending notice through the real mail setting), the 402 rule, sockets that are open when the lock changes, the seat limit through the real sign-in flow, the portal and persistence across a restart. `test/cloud-logic.test.ts` covers the client rules, including the coalescing of hints and the unlock watcher, and `test/workspace-hint.test.ts` runs a board's chain from hint to refresh to reconnect with fake providers. The hint on the wire, who gets it, that clients cannot send it and that a reconnect sends what was typed during the lock are in `test/cloud-relay.test.ts`.
