# Hosted workspaces

Mira can run as one workspace of a hosted service: a separate control plane (billing, provisioning) starts the instance, tells it how many seats the customer paid for, and can lock it when the subscription lapses. This page is the instance side of that contract. It is generic: any control plane that speaks it will do, and **an instance without the variables below behaves exactly as described in `docs/accounts.md`**: none of the routes, tables, banners or checks here exist for it.

Not in it: creating or deleting the instance, Stripe, routing. Those belong to the control plane.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `MIRA_CLOUD_TOKEN` | Shared secret, at least 32 characters, no spaces. The control plane sends it as `Authorization: Bearer <token>`, and the instance sends it back on its own calls |
| `MIRA_CLOUD_URL` | Base URL of the control plane. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only (local development). No credentials, query or fragment; a path prefix is kept, trailing slashes are dropped |
| `MIRA_CLOUD_WORKSPACE_ID` | This workspace's id at the control plane (letters, digits, `.`, `-`, `_`, up to 128). Used in the path of the instance's calls |

Cloud mode is on only when `MIRA_AUTH=on` **and** all three are set.

- None set: nothing changes, the routes below answer `404`.
- Some but not all set: the relay refuses to start and names the missing variables. A token that is too short, a URL that is not allowed or an id that does not fit refuse startup too.
- All set with `MIRA_AUTH` off: cloud mode stays off and the relay logs that the variables are ignored. (The values are still validated.)

## Calls from the control plane

Both endpoints sit under `/api/internal/`. They need the bearer token and nothing else: no cookie, no `x-mira` header, and a session cookie that comes along is ignored. The token is compared in constant time (both sides are hashed first, so the length of a guess shows nothing). A missing or wrong token answers `401 {error: 'unauthenticated'}` with `WWW-Authenticate: Bearer`. The public edge must not forward `/api/internal/` to browsers.

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

## Read-only

While `readOnly` is true:

- **Relay**: every connection is read-only for the board room and the comments room, whatever the person's role. Sockets that are already open are re-evaluated the moment the limits change, in both directions. Document updates are dropped, state requests and awareness (cursors) still work.
- **API**: every mutating route answers `402 {error: 'read_only', message}`. Not blocked: all `GET`s, `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/logout`, `POST /api/auth/logout-all`, `PUT /api/internal/limits` and `POST /api/billing/portal` (the owner has to reach billing to put things right). Signed-out writers still get `401` first.
- **App**: boards open read-only (the same switch as for viewers) with a **Workspace is read-only** badge instead of **View only**; the banner shows as described below.

Known limitation: the app learns about a change from the next `/api/me` refresh (up to five minutes, or at once after a reload). Edits typed in that window are dropped by the relay, and until the socket reconnects the relay cannot apply later edits from that client either, because they build on the dropped ones. They are not lost: they stay in the browser, and a reconnect after the lock is lifted brings them to the server. Nothing here forces that reconnect.

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
- A refresh of `/api/me` every five minutes while the tab is open (skipped while the tab is hidden and run when it is seen again; nothing at all in open mode and on servers without cloud mode).

## Calls to the control plane

All with `Authorization: Bearer <MIRA_CLOUD_TOKEN>` and a 10 second timeout; redirects are not followed.

```
POST /api/billing/portal            (workspace owner only; 404 without cloud mode)
  -> { url }
```

The instance calls `POST <MIRA_CLOUD_URL>/v1/workspaces/<id>/portal` and returns its `url`. Anything but an `https://` URL, an error status, an unreadable answer or a timeout is `502 bad_gateway`. Other roles get `403`.

```
POST <MIRA_CLOUD_URL>/v1/workspaces/<id>/usage   { seats, guests }
```

Sent 30 seconds after the last change to the people in the workspace (an account created through an invite, a role change, disable or enable, a removal). A burst of changes is one report, with the counts read when it is sent, and a report that would repeat the last successful one is skipped. A failure is logged (without the token or the answer) and never reaches the request that caused the change; the control plane also pulls `GET /api/internal/usage` now and then. Reports that are still waiting when the process stops are not sent.

## Tests

`test/cloud.test.ts` covers configuration, validation, the seat rules, the portal and the usage reports in process, with a fake `fetch` and hand-driven timers (both are injectable in `createCloud`). `test/cloud-relay.test.ts` starts the relay next to a fake control plane and covers the endpoints, the 402 rule, sockets that are open when the lock changes, the seat limit through the real sign-in flow, the portal and persistence across a restart. `test/cloud-logic.test.ts` covers the client rules.
