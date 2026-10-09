# Join a board with a code

Join codes let someone enter one board without creating a workspace account. They are for short, supervised collaboration and work only in accounts mode.

## Enable the feature

Set `TABULA_JOIN_CODES=on` on the relay. It defaults to `off`; when off, join-code API routes return `404` and the Share dialog does not show the feature. Open mode does not support join codes because it has no account based board roles.

## Create and manage codes

In a board's **Share** dialog, an **Owner** or **Editor** sees **Join code**. Choose the guest's role, expiry and use limit:

- Roles are **Commenter** or **Editor**.
- The default expiry is 3 hours. Choose up to 24 hours.
- The default use limit is 100; the maximum is 1,000.
- The server generates an 8-character code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, which omits easily confused characters. The code is shown once, in large type, with a copyable `/join?c=CODE` link.
- The code is stored as a SHA-256 hash. It is not included in the list endpoint, audit rows or server logs. Keep the one-time display private: anyone holding an active code can join until it expires, is revoked or runs out of uses.

The list shows each code's role, use count, expiry and revocation state. Select **Revoke** to end the code and all guest sessions created from it. A code that reaches its use limit cannot create more sessions, but sessions already created remain active until the code expires or is revoked.

## Guest access

The guest opens `/join?c=CODE`, enters a display name, and receives a host-only `HttpOnly` session cookie. The name is NFC-normalised, has control and invisible formatting characters removed, whitespace collapsed, and must be 1 to 40 characters after sanitising. The guest session ends at the exact expiry time of the code.

The relay checks the session's board scope and role before opening a sync room and rechecks it while the connection is open. The session can open only that board's board and comments rooms. An **Editor** can write the board, comment, read board images and upload images within the server's existing file, board and server limits. A **Commenter** can read the board and write comments; image uploads, including claims from another board, are refused.

Guest HTTP access is intentionally narrow. Guests may read images belonging to their board. Editors may also read that board's version history and upload an image to that board. The join page may submit a code, and the app may read public configuration. All other API requests, including boards lists, other board resources, sharing, admin, chat, AI, and MCP, are refused. `/api/health` is also refused while a valid guest cookie is present.

Wrong, expired, exhausted and revoked codes all receive the same `404` error and message. Join attempts are rate-limited in memory to 20 attempts per source address and 5 attempts per code per minute. The source address follows `TABULA_TRUST_PROXY` and `TABULA_CLIENT_IP_HEADER`; these headers must only be trusted behind the configured proxy. Rate counters reset when the relay restarts.

## API

All write requests need the normal `x-tabula: 1` CSRF header and matching `Origin` when supplied.

```text
POST   /api/boards/:id/join-codes
       { role: 'commenter' | 'editor', expiresInHours?: 1..24, maxUses?: 1..1000 }
       -> 201 { id, code, role, createdAt, expiresAt, maxUses, uses }

GET    /api/boards/:id/join-codes
       -> [{ id, role, createdAt, expiresAt, maxUses, uses, revokedAt }]

DELETE /api/boards/:id/join-codes/:codeId
       -> 204

POST   /api/join
       { code, name }
       -> 201 { boardId, role, name, guestId, expiresAt } + Set-Cookie
```

Creation, revocation and successful use write audit actions `join-code.created`, `join-code.revoked` and `join-code.used`. Each row records the board, code record id and relevant role or expiry data; none records the code itself.

## Later work

- TODO: QR code image for a join link.
- TODO: guest access to group areas.
- TODO: facilitator kick UI for ending one guest session before its code expires.
