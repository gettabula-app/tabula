# OAuth 2.1 for the MCP endpoint

Status: **slices 1 to 3 are implemented and in v5.4** (server core, consent screen with the board picker, grants in AI tool access); off unless `TABULA_MCP_OAUTH=on`. Slice 5 (end-to-end test) gates the default; section 14.2 records what a real connector did. Extends [docs/mcp.md](mcp.md). Read that first: the permission model, fencing, rate limits and the `tbl_` personal tokens described there are reused, not redefined, here.

## 1. Problem and decision

Adding Tabula as a custom connector in claude.ai or Claude Desktop fails with "Couldn't register with Board's sign-in service". Those clients start the MCP authorization flow: they read the 401 from `POST /mcp`, look for protected-resource metadata, discover an authorization server, register themselves (RFC 7591) and run the authorization-code flow with PKCE. Today `/mcp` answers `401` with a bare `WWW-Authenticate: Bearer`, there is no metadata and no registration endpoint, so the flow dies at step one. `tbl_` tokens cannot be typed into those connector dialogs.

**Decision (Johan): both.** Personal `tbl_` tokens stay exactly as they are (CLI, scripts, Claude Code with `--header`). OAuth is added for the connector UIs. Nothing about `tbl_` changes except that its 401 gains a `resource_metadata` pointer.

Goals: a person adds `https://HOST/mcp` as a connector, signs in to the workspace in the browser, picks what the AI may do, and it works. Access is the same permission model as `tbl_`, revocable in the same places, and bounded by the same role caps.

Non-goals: OpenID Connect (no ID tokens, no `/userinfo`, no `/.well-known/openid-configuration`), confidential clients and client secrets, client credentials grant, device flow, token exchange, JWT access tokens, using Tabula as a sign-in provider for anything but `/mcp`, OAuth tokens on `/api/*` or `/sync` (still never accepted there), open mode.

## 2. Assumptions and deployment notes

Marked **[A]** wherever they matter. Collected here so they can be checked against a real connector before slice 1 is released.

| # | Assumption |
| --- | --- |
| A1 | Claude connectors (claude.ai web, Desktop, mobile) call metadata, register, token and revoke **server to server from Anthropic's infrastructure**, not from the user's browser; only the authorize step runs in the user's browser. So CORS is needed on the metadata documents only (for browser tools such as MCP Inspector). |
| A2 | The registered redirect URI is `https://claude.ai/api/mcp/auth_callback` (and possibly `https://claude.com/api/mcp/auth_callback`); Desktop uses the same hosted callback or a loopback URI. Custom schemes (`claude://`) are **not** assumed. |
| A3 | Claude sends `resource` (RFC 8707) on both the authorize and token requests, as the 2025-06-18 specification requires, and registers with `token_endpoint_auth_method: "none"`. |
| A4 | Claude falls back gracefully on scopes: it requests `scope` from `scopes_supported` or sends none; it accepts a token response whose `scope` is narrower than requested. |
| A5 | Claude retries discovery after a `401` on a stale token by refreshing (using `refresh_token`) and, failing that, re-runs authorization; it does not hammer the token endpoint. |
| A6 | **Verified.** Claude Code (CLI) uses `http://localhost:PORT/callback`; Gemini CLI and Goose use the other built-in localhost callback paths (see 4.2). `127.0.0.1` and `[::1]` remain accepted for any path. |
| A7 | `WWW-Authenticate` is read on `401` for the `resource_metadata` parameter (RFC 9728 section 5.1); clients that ignore it fall back to `/.well-known/oauth-protected-resource` at the origin, which we also serve. |
| A8 | **Verified.** The hosted-workspace edge routes by `Host` and uses `307 fly-replay` for all paths except `/api/internal`. Unknown or suspended workspaces return `503` HTML, which a connector reports as failed discovery. |
| A9 | Provider callback URIs can change. The exact built-in list is versioned with the server; the hosted control plane may add exact callback hosts, while self-hosted operators can also opt into any HTTPS host (see 4.2). |

## 3. Endpoints and metadata

All paths are served by the relay process (`server/relay.mjs` routes them explicitly, before the single-page-app fallback, exactly as it does for `/mcp`; without a branch they would answer `200 index.html`). Unknown methods answer `405` with `Allow`.

| Path | Method | Purpose | Auth |
| --- | --- | --- | --- |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | GET | RFC 9728 metadata for the resource `…/mcp` | none |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata | none |
| `/oauth/register` | POST | RFC 7591 dynamic client registration | none, rate limited |
| `/oauth/authorize` | GET | Validates the request, creates an HMAC-signed consent request, redirects the browser to the consent screen | none (the browser's cookie is not read; no request row is created) |
| `/oauth/token` | POST | `authorization_code` and `refresh_token` grants | public client, PKCE |
| `/oauth/revoke` | POST | RFC 7009 revocation | public client + the token itself |
| `/api/oauth/requests` (GET) and `/api/oauth/requests/decision` (POST) | | Validates the signed consent request and returns consent data or records a decision | session cookie + CSRF header, the normal API rules |
| `/api/me/grants`, `/api/admin/grants` | | List / revoke grants (section 9) | session cookie, normal API rules |

The hosted edge behavior in A8 applies to these paths. An unknown or suspended workspace answers discovery with `503` HTML, which the connector displays as failed discovery rather than an OAuth error.

### 3.1 Issuer and URLs

| Deployment | Issuer | Resource |
| --- | --- | --- |
| Hosted workspace | `TABULA_BASE_URL` (set by the control plane, always `https://`), e.g. `https://acme.example.com` | `https://acme.example.com/mcp` |
| Self-hosted | `TABULA_BASE_URL`, e.g. `https://board.example.org` | `https://board.example.org/mcp` |

The issuer is `config.baseUrl` without a trailing slash and **must be an origin only**. Reject OAuth when `TABULA_BASE_URL` has a non-root path, userinfo, a query or a fragment; log one line and keep MCP working with `tbl_`. RFC 8414 path insertion is not worth supporting. Every URL in the documents is built from `config.baseUrl`, **never from the `Host` header**, so a forged `Host` cannot poison the metadata. One instance is one workspace, so one issuer is one workspace.

### 3.2 Protected resource metadata (RFC 9728)

`GET /.well-known/oauth-protected-resource/mcp` (the same body at `/.well-known/oauth-protected-resource`):

```json
{
  "resource": "https://HOST/mcp",
  "authorization_servers": ["https://HOST"],
  "scopes_supported": ["read", "comment", "write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Tabula boards",
  "resource_documentation": "https://HOST/docs/ai-tools/"
}
```

`resource_documentation` is included only if the guide is served at that path (to confirm in slice 4); otherwise omitted. Any other path under `/.well-known/oauth-protected-resource/` answers `404`.

### 3.3 Authorization server metadata (RFC 8414)

`GET /.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://HOST",
  "authorization_endpoint": "https://HOST/oauth/authorize",
  "token_endpoint": "https://HOST/oauth/token",
  "registration_endpoint": "https://HOST/oauth/register",
  "revocation_endpoint": "https://HOST/oauth/revoke",
  "scopes_supported": ["read", "comment", "write"],
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "revocation_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "authorization_response_iss_parameter_supported": true,
  "service_documentation": "https://HOST/docs/ai-tools/"
}
```

Both documents: `200`, `content-type: application/json`, `cache-control: public, max-age=300`, `access-control-allow-origin: *` (GET and `OPTIONS` preflight only; A1), `x-content-type-options: nosniff`. They contain no secrets and no per-user data, so they are fine to cache. `authorization_response_iss_parameter_supported` means every authorization response (success and error) carries `iss=<issuer>` (RFC 9207), which defends against mix-up attacks.

There is **no** `/.well-known/openid-configuration` (`404`) and no legacy `/authorize`, `/token`, `/register` root aliases (open question Q7).

## 4. Dynamic client registration (RFC 7591)

`POST /oauth/register`, `content-type: application/json`, body at most 8 KiB (`413`), response `201`, `cache-control: no-store`. Only **public clients** exist.

### 4.1 Request validation

Anonymous endpoint, so everything is validated strictly and nothing from the request is fetched or rendered as markup.

| Field | Rule |
| --- | --- |
| `redirect_uris` | required, array of 1 to 5 strings, each at most 512 characters, no duplicates, each passing 4.2 |
| `client_name` | optional string; NFC-normalised, then control characters (`\p{C}`) and bidi overrides/isolates (U+202A to U+202E, U+2066 to U+2069) removed, whitespace collapsed, trimmed, cut to 80 characters. Empty after cleaning, or absent: `Unnamed app`. |
| `token_endpoint_auth_method` | absent or `none`. Anything else: `invalid_client_metadata` |
| `grant_types` | absent, or a non-empty subset of `["authorization_code","refresh_token"]` (must contain `authorization_code`) |
| `response_types` | absent or `["code"]` |
| `scope` | absent, or a space-separated subset of `read comment write` (it is only the maximum the client intends to ask for; consent decides) |
| `client_uri`, `logo_uri`, `tos_uri`, `policy_uri`, `contacts`, `jwks`, `jwks_uri`, `software_id`, `software_version`, `software_statement`, unknown keys | **ignored: not stored, not echoed, never fetched** |

Errors are RFC 7591: `400 {"error":"invalid_redirect_uri"|"invalid_client_metadata","error_description":"…"}`.

### 4.2 Redirect URI rules

Parsed with the WHATWG `URL` class, then **the string must equal `new URL(s).href`** (canonical form: lowercase scheme and host, explicit path, no default-port noise). A URI that is not already canonical is refused rather than normalised, so what is registered is byte-for-byte what is compared later.

| Kind | Accepted | Match at authorize time |
| --- | --- | --- |
| Web | `https:` with a host; any port; no userinfo (`user:pass@`), no fragment, no wildcard (`*`), no IP-literal host that is private/link-local, query allowed | **exact string equality** (so a trailing slash, different case, extra query or different port is a mismatch) |
| Native loopback | `http:` with host `127.0.0.1` or `[::1]`; path and query as registered; **port may be absent or any value** at registration | scheme, host, path and query exact; the **port is ignored** (RFC 8252 7.3) |
| Known localhost loopback | `http:` with host `localhost`, only when `TABULA_OAUTH_REDIRECTS=known` and the path is `/callback`, `/oauth/callback` or `/oauth_callback`; query as registered; port may be absent or any value | scheme, host, path and query exact; the port is ignored |
| Private-use scheme | refused except for the exact tolerated Cursor URI below when built-ins are enabled. `TABULA_OAUTH_REDIRECT_SCHEMES` (comma list of reverse-domain schemes, default empty) can allow other reverse-domain schemes for self-hosters | exact string equality |
| Anything else | `http:` for a non-loopback host, `javascript:`, `data:`, `file:`, `blob:`, `ws(s):`, relative or scheme-relative URIs | never |

The built-in provider table is an exact URI allowlist. It does not use host wildcards, path prefixes or URI normalization:

| Provider | Exact redirect URI | Source |
| --- | --- | --- |
| Claude | `https://claude.ai/api/mcp/auth_callback` | [Claude connector authentication](https://claude.com/docs/connectors/building/authentication) |
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` | [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth) |
| Cursor | `https://www.cursor.com/agents/mcp/oauth/callback` | [Cursor MCP docs](https://cursor.com/docs/context/mcp) |
| VS Code | `https://vscode.dev/redirect` | [VS Code authentication source](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/microsoft-authentication/src/common/env.ts) |
| VS Code (Insiders) | `https://insiders.vscode.dev/redirect` | [VS Code issue report](https://github.com/microsoft/vscode/issues/278512) (reporter-confirmed) |

`TABULA_OAUTH_REDIRECTS` is `known` by default (unset or empty also means `known`), or `none`. Any other value refuses startup. `none` disables these exact provider URIs, the three localhost paths above and the tolerated Cursor private URI; configured host and scheme policies continue to work. `TABULA_OAUTH_REDIRECT_HOSTS` remains the additional web redirect-host policy. A URI on one of its exact hosts is accepted with an exact URI comparison at authorize time. Self-hosted operators may also set `*` to opt into any HTTPS host; wildcard registrations are never verified. On hosted workspaces, registration is allowed when the built-in list is enabled or the exact host list is non-empty; a wildcard is always refused.

With the built-in list enabled, `localhost` accepts only `/callback` (Claude Code and Cursor desktop), `/oauth/callback` (Gemini CLI), and `/oauth_callback` (Goose). Cursor desktop may send `http://localhost:8787/callback`; the port may vary or be absent, and only the port is ignored at authorize time. These loopback redirects remain unverified and show the warning in section 7.2. The exact URI `cursor://anysphere.cursor-mcp/oauth/callback` is also tolerated in a DCR payload because Cursor may send it alongside its compliant callbacks. It is non-compliant with the MCP spec, is never verified, and no other private URI is tolerated by the built-in rule.

**Adding a provider:** add its exact URI to `KNOWN_REDIRECTS`, include its source URL and a registration/verification test. Do not add a wildcard, prefix or inferred URI pattern.

### 4.3 Response

```json
{
  "client_id": "Zt3Qm0uVbX2s8nB1rK9wYA",
  "client_id_issued_at": 1760000000,
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "read comment write"
}
```

No `client_secret`, no `registration_access_token`, no `registration_client_uri` (clients are not self-manageable; admins and the clients' grants are managed in the app). `client_id` is 16 random bytes, base64url. It is public and not a secret.

**Idempotent**: registering the same normalised `client_name` and the same set of `redirect_uris` again returns the existing `client_id` (`201`, same body) and refreshes its expiry. Connectors register on every connect attempt; without this the table grows with every retry.

### 4.4 Limits and lifetime

| Limit | Value |
| --- | --- |
| New registrations per client IP | 10 per hour (`429` + `Retry-After`; same `clientIp` and `TABULA_TRUST_PROXY` rules as every limit, `server/client-ip.mjs`); idempotent re-registrations do not count |
| New registrations per instance | 100 per hour, whichever IP; idempotent re-registrations do not count |
| Registered clients per instance | 500; at the cap the sweep (below) runs once, then a new registration answers `429 temporarily_unavailable` |
| Unused client (no grant ever created) | deleted 7 days after registration or last re-registration |
| Used client | deleted 90 days after its last grant activity and when it has no active grant |
| Deleting a client | deletes its request markers, codes and, through the grant, its tokens (cascade) |

Operators have a maintenance purge for registered clients. Purging clients also removes their grants, tokens and codes; it is available for cleanup or incident response. Idempotent re-registrations are identified by the existing registration fingerprint and never consume new-registration quota.

## 5. Authorization request, code and PKCE

### 5.1 `GET /oauth/authorize`

Required query parameters: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`. Optional: `state`, `scope`, `resource`. Duplicated parameters (`?a=1&a=2`) are an error. The endpoint **never reads the cookie**; it validates the request and signs a stateless consent envelope.

Validation order (the order decides whether an error may be redirected):

1. `client_id` unknown or expired, or `redirect_uri` missing / not matching a registered URI under 4.2: **do not redirect.** Answer a minimal server-rendered error page (`400`, plain HTML, the same page for both cases, no details, no echo of the input) with `frame-ancestors 'none'`. This is what makes an open redirect impossible: nothing is ever sent to a URI that was not validated against a registered client.
2. From here on the redirect URI is validated and errors are returned **by redirect** to it with `error`, `error_description`, `state` (if given) and `iss` query parameters. Build every response URL with the `URL` class and `URLSearchParams`; never concatenate parameter strings:
   `unsupported_response_type` (not `code`), `invalid_request` (missing, duplicated or malformed parameter; `code_challenge_method` absent or `plain` or anything but `S256`; `code_challenge` not 43 characters of `[A-Za-z0-9-._~]`), `invalid_scope` (an unknown token in `scope`), `invalid_target` (`resource` present and not exactly `<issuer>/mcp`; a trailing slash or other path is a mismatch), `temporarily_unavailable` (OAuth gated off, read-only workspace is **not** an error here: it is shown at consent).
3. `state` is opaque, at most 512 characters, returned unmodified, never interpreted. Not required by us but passed through; clients should send it. `URLSearchParams` performs the encoding for state and every other redirect parameter.
4. `resource` absent: treated as `<issuer>/mcp` (A3, Q4). Present: must equal it.
5. `scope` absent: the client's registered `scope`, else all three (the **maximum** to offer; the default selection is always `read`).

On success: create a 128-bit random request id and an HMAC-signed blob containing the validated client, redirect URI, state, PKCE challenge, scope ceiling, resource, issue time and 10-minute expiry. Sign it with a key derived from `APP_SECRET`. No database row is created until the person chooses Allow. Redirect to the consent route with the blob in its query, built with `URL` and `URLSearchParams`. The API verifies the signature and expiry; the Allow transaction creates a one-time request marker along with the grant and code. Stateless authorization avoids filling a persistent pending-request pool.

### 5.2 The authorization code

Issued only when the person clicks Allow (7.4). 32 random bytes, base64url, prefix `tbc_`, **stored as SHA-256 only**, lifetime **60 seconds**, **single use**. Bound to: client, user, the exact `redirect_uri` string of the request, `code_challenge`, scope granted, resource, and the grant row created at Allow. Deliver it by applying `code`, `state` and `iss` with `URLSearchParams` to the validated redirect URL (`302` from the consent screen's JavaScript navigation, 7.4).

### 5.3 `POST /oauth/token`, authorization code grant

`content-type: application/x-www-form-urlencoded` (JSON is also accepted, as some clients send it; the same validators), body at most 8 KiB.

| Parameter | Rule |
| --- | --- |
| `grant_type` | `authorization_code` |
| `code` | must exist, unexpired, unused |
| `client_id` | required; must equal the code's client (`invalid_client` `401` if unknown) |
| `redirect_uri` | required; must equal, byte for byte, the one stored with the code (RFC 6749 4.1.3; the loopback port-ignoring applies only at authorize time, the token request repeats the actual URI that was used) |
| `code_verifier` | required; 43 to 128 characters of `[A-Za-z0-9-._~]`; `base64url(SHA-256(verifier))` compared with the stored challenge using `crypto.timingSafeEqual` |
| `resource` | optional; if present must equal `<issuer>/mcp` and the code's resource (`invalid_target`) |
| `scope` | optional; if present must be **a subset of the granted scope**; it can narrow, never widen. Absent: the granted scope |

Order of checks and what each failure does:

1. Client unknown: `401 invalid_client`.
2. Code unknown or expired: `400 invalid_grant` (identical answer for both).
3. **Code already used: `400 invalid_grant`, and the grant created for that code is revoked with every token issued from it** (RFC 6749 4.1.2, OAuth 2.1). Audit `mcp.oauth.reuse_detected` `{kind: 'code'}`.
4. Client or redirect URI mismatch, PKCE verifier wrong: `400 invalid_grant`. A wrong verifier **burns the code** (it is marked used) so a guesser gets one try, not many.
5. Grant revoked, user disabled or removed: `400 invalid_grant`.

Success `200`:

```json
{
  "access_token": "tbo_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "tbr_…",
  "scope": "read"
}
```

All token-endpoint responses carry `cache-control: no-store` and `pragma: no-cache`. The code and the verifier are never logged. Errors are `{"error":"…","error_description":"…"}` with RFC 6749 codes; `error_description` never echoes input.

### 5.4 Refresh token grant

`grant_type=refresh_token`, `refresh_token`, `client_id` (must match the grant's client), optional `scope` (subset of the grant's current scope; absent means the current grant scope; narrowing is allowed and permanently reduces the grant's ceiling and all later token scopes), optional `resource` (same rule).

- Each refresh **rotates**: the presented refresh token is marked used, and a new access token and a new refresh token are issued. The new refresh token's lifetime is 30 days from now (sliding). If `scope` narrows the grant, the lower ceiling is persisted in the same transaction.
- **Concurrent retry window**: for 20 seconds after rotation, one repeat presentation of that just-rotated refresh token returns the exact same replacement access/refresh pair. The replacement pair is held encrypted with `APP_SECRET` only for this window, then erased. This lets a connector recover from a lost response or simultaneous refreshes without minting multiple families. A second replay, or any presentation after 20 seconds, is reuse: answer `400 invalid_grant`, revoke the whole grant family, and audit `mcp.oauth.reuse_detected` `{kind: 'refresh'}`. (Q5.)
- The sliding window has an **absolute cap of 180 days from the grant's creation** (Q6): after that the grant ends and the person consents again. There is no grant that never expires, matching "no token that never expires" in docs/mcp.md.
- The user's current state is checked on refresh: disabled, removed or demoted-to-guest user, or a grant whose stored resource no longer equals `<issuer>/mcp` (the base URL changed): `invalid_grant` and the grant is revoked.
- Refresh is **not audited per call** (it would be one row an hour per connector). Family revocation is.

### 5.5 `POST /oauth/revoke` (RFC 7009)

Form body `token` (an access or refresh token), optional `token_type_hint`, `client_id` (required for a public client, since there is no secret). If the token belongs to that client's grant the **whole grant** is revoked (access and refresh tokens). An unknown, expired, already revoked or other-client token answers `200` with an empty body (RFC 7009: do not leak validity). Unknown `client_id`: `401 invalid_client`. Audit `mcp.oauth.revoke` `{by: 'client'}` only when something was actually revoked. Allowed while a hosted workspace is read-only (`readOnlyOk` equivalent), like `DELETE me/tokens/:id`.

## 6. Access tokens and permissions

### 6.1 Token properties

| | Access token | Refresh token | Authorization code |
| --- | --- | --- | --- |
| Prefix | `tbo_` | `tbr_` | `tbc_` |
| Form | 32 random bytes, base64url | same | same |
| At rest | SHA-256 hex, `UNIQUE`, found by digest | same | same |
| Lifetime | 1 hour, fixed | 30 days sliding, 180 days absolute (grant) | 60 seconds |
| Accepted at | `/mcp` only | `/oauth/token` and `/oauth/revoke` only | `/oauth/token` only |

Prefixes let logs, the Admin list and secret scanners tell kinds apart (`tbl_` personal, `tbo_` OAuth access). The server uses the prefix of an incoming bearer only to choose which table to query (`tbl_` → `access_tokens`, `tbo_` → `oauth_tokens`); it carries no security meaning, and a wrong prefix is just an unknown token. Like `tbl_`, an OAuth token is never accepted on `/api/*` or `/sync`, the cookie is not read on `/mcp`, and the digest and token never appear in a log line, audit row or error message. The sole temporary exception is the encrypted replacement-pair cache for the 20-second refresh replay window (5.4); it is erased after use or expiry. An OAuth token cannot call `/oauth/authorize` decisions or create other tokens (those need the cookie session).

### 6.2 One permission model

An OAuth access token resolves, in `server/mcp.mjs` `authenticate`, to the **same actor object** a `tbl_` token resolves to: `{mode:'accounts', userId, user, tokenId, tokenName, scope, boardIds, expiresAt}` plus `source: 'oauth'`, `clientName`. From there nothing differs: `authorise()`, `canWriteRoom`, `accessOf`, fencing (`fence`, `cleanForModel`), `tools/list` filtering by scope, the read-only rule, and `MCP-Protocol-Version` / `Origin` handling are the existing code paths. Concretely:

- Scope is `read` ⊂ `comment` ⊂ `write`, same meaning as the table in docs/mcp.md ("Effective access is the lower of the token scope and the role").
- **Role caps, live per call.** A viewer's grant of `write` still resolves to `read` on every board where they are a viewer (`canWriteRoom` is false), a commenter's to comment. Role changes take effect on the next call; nothing is cached on the token.
- **Board scope and owners/admins**: `board_ids = NULL` means every board the person can open, **now and later**; changes to board membership therefore change the grant's reach. A board picker is required before launch can offer `comment` or `write` grants to owners/admins, and it must bind those grants to the explicitly selected boards. Until then an owner/admin connector can read boards, objects and comments, but cannot add comments or create, change or delete kanban cards. On shared workspaces, do not offer `write` to non-owner members until the board picker can limit the grant to chosen boards. Read grants with `board_ids = NULL` continue to cover all boards they can open, now and later. The "promoted later" rule is applied at use: a grant with `board_ids = NULL` held by someone who becomes owner/admin acts as `read` until it is replaced with a board-picked grant.
- Guests (join-code sessions) cannot consent: the API refuses them (`guestApiAllows`), and `/mcp` already answers `403` to a guest cookie.
- Rate limits: the per-token buckets of docs/mcp.md (calls and writes per minute) are keyed by **grant id** for OAuth, so refreshing does not reset them; the "wrong token" limiter counts bad `tbo_` tokens exactly as bad `tbl_` ones (20 per minute per IP).
- `last_used_at` is written at most once a minute per grant (the `touch` rule). It also supplies the "last used" column.
- `whoami` additionally reports `connector: <clientName>` (fenced like other user text).

### 6.3 Binding to one workspace and one user

- Tokens live in this instance's `directory.sqlite` and are found by digest there, so a token minted by workspace A is an *unknown token* at workspace B (`401`), by construction. One instance is one workspace; there is no shared token store.
- Each grant stores `resource` (`<issuer>/mcp` at consent time). At use the actor builder compares it to the live `<baseUrl>/mcp`; a mismatch (the base URL was changed, or a volume was adopted by another workspace) rejects the token. This is the audience check at the resource (RFC 8707 / MCP "token audience binding").
- The token is bound to exactly one `user_id`; it acts as that user and never as more. Disabling, removing or demoting a user to guest revokes all their grants. Removing a user also deletes the grant rows (`ON DELETE CASCADE`). "Sign out everywhere" revokes the user's grants as well as sessions.
- **Every whole-workspace restore**, including backup/snapshot restore and volume adoption, must revoke all OAuth grants and clear OAuth request markers and codes after restoring data. `server/restore.mjs` already revokes `tbl_` tokens; it must apply this OAuth invalidation on every restore path so a snapshot cannot resurrect a grant that was revoked later. Volume adoption from another workspace (`TABULA_ADOPT_VOLUME`, TAB-200) additionally deletes registered clients. The rollback runbook must include these steps.
- Token passthrough is never done: Tabula never forwards the incoming token anywhere.

## 7. Consent screen

An app route, `#/oauth/consent?request=…`, in `src/ui/oauth-consent.ts` (+ CSS). The `request` value is the signed stateless envelope. Chosen over a server-rendered page because the sign-in page, session cookie, `x-tabula` CSRF header, read-only handling and Swiss styling already exist there, and because a JS-driven navigation avoids the CSP `form-action` trap (a form that 302s to another origin is blocked in Chromium unless that origin is listed).

### 7.1 Flow

1. Browser arrives from `/oauth/authorize` (302) at the consent route with the signed envelope in its query.
2. **Not signed in** (`GET /api/me` → 401): show the existing sign-in screen with a line "Sign in to connect *<client name>*". The sign-in request carries the signed `oauthRequest` envelope (`POST /api/auth/request`; validated by HMAC and expiry, ignored if invalid). The emailed link carries that envelope; after a successful verify the app returns to the same consent request. A person may complete sign-in in another browser profile because the request is stateless; only an authenticated, explicit Allow creates a grant (Q8).
3. **Signed in**: `GET /api/oauth/requests?request=<envelope>` verifies the signature and returns what to render (below). It creates no pending row.
4. The person chooses and presses **Allow** or **Deny**: `POST /api/oauth/requests/decision {request, decision, scope, nonce}` returns `{redirect: "<validated URL>"}` and the app does `location.assign(redirect)`.

   **Board picker (server).** `GET /api/oauth/requests` also returns `pickerAvailable: true`, `boards: [{id, name, role}]` (the boards the person can open now, `role` as the board roles of `docs/admin.md`; owners and admins have `owner` on every board) and `scopes: {unrestricted, boards}`. `unrestricted` is today's `maxScope` (the old field stays as an alias): read-only for owners/admins and on shared workspaces. `boards` is the highest level the person's roles allow across all listed boards (editor or owner = `write`, commenter = `comment`, anything else = `read`), capped by the client's and the request's scope; a client that ticks boards recomputes the level for just the ticked ones with the same rule from the `role` values. The decision body takes an optional `boardIds` (1 to 50 different board ids). On Allow with `boardIds` every id is re-read at that moment and must be a board the person can open, else `400 invalid_boards`; the chosen `scope` may not exceed the maximum of the person's roles on just those boards (and the client's and request's caps), else `400 invalid_scope`; the grant is stored with those `board_ids` and `mcp.oauth.authorize` records `boardCount` (never the ids). Without `boardIds` the grant is unrestricted exactly as before. On Deny `boardIds` is ignored (not validated). At use, a grant with `board_ids` reaches only those boards, further capped by the live role on each call; a deleted or unshared board is dropped without error, and an empty remaining set means no boards, never all. The promotion rule (a grant acts as `read` after promotion to owner/admin) applies to unrestricted grants only: a board-restricted grant keeps its scope. The stored list holds at most 50 ids (`MAX_OAUTH_BOARD_IDS`); a damaged stored list reads back as no boards.

### 7.2 What is shown

- Title: **"An app that claims to be ‘<client name>’ wants access to <workspace name>"**. Always describe the client name as a claim chosen by the app; render it with `textContent` only, never HTML. Workspace name: Tabula has no workspace-name setting today (`chat-notify.mjs` uses the constant `Workspace`), so v1 uses the **host of `TABULA_BASE_URL`** (Q9).
- Signed in as: the person's name and email, with "Not you? Sign out" (which signs out and keeps the signed request).
- **Where you will be sent**: the redirect URI's host (and port for loopback), e.g. `claude.ai`, in a monospace line, with the full URI available on expansion. Show `Verified: <provider>` for an exact built-in URI, or "Verified host" for another URI on an exact configured host. For every other destination (including a self-hosted `*` allowlist), show an additional warning that Tabula has not verified it. For loopback, show "an app on this computer" with the real host and port, such as `localhost:3118`.
- **Access level** (radio group, labelled `fieldset`/`legend`), default **Read**:
  - *Read*: "See boards, objects and comments."
  - *Read and comment*: "…and add comments." Offered if the person is commenter-or-better on any board (`directory`: one query, `boardRole` over the person's boards) and the client's maximum allows it. For an owner/admin it is unavailable until the board picker is present and binds the grant to selected boards.
  - *Read and edit*: "…and add, change and delete objects." Offered only if the person is **editor or owner on at least one board**, the board picker is available for owners/admins and for non-owner members on shared workspaces, and the client's maximum allows it. A person who cannot write anywhere never sees it. The picker limits the grant to the chosen boards; the per-call role cap still applies.
- When `pickerAvailable` is true and boards are listed, **Which boards** defaults to all boards; choosing specific boards shows a scrollable list, caps selections at 50, and recalculates the available access levels from those boards' roles.
- For a grant without a board picker, say: "This app can access all boards you can open, now and later. It acts as you, never as more. You can disconnect it at any time under AI tool access." When a board picker is used, name the selected boards and say access is limited to those boards.
- **Allow** and **Deny** buttons. In a read-only hosted workspace Allow is disabled with the generic read-only message (granting is a mutating route: `402 read_only`).
- A visible, selectable code-less state: after Deny the app navigates to the redirect with `error=access_denied`.

### 7.3 Layout and accessibility

Swiss styling consistent with `src/ui/signin.ts`/`signin.css`: single centred column, theme variables only, no new colours. Works at 360 px width (stacked buttons, no horizontal scroll, redirect host wraps with `overflow-wrap:anywhere`). Real `<button>`s and `<fieldset>`; focus moves to the heading on load; Deny is a first-class button, not a link; contrast and target sizes as in `docs/accessibility-audit.md`; `prefers-reduced-motion` respected; errors in an `aria-live="polite"` region; Esc does nothing destructive (no auto-deny).

### 7.4 Decision endpoint and protection

`POST /api/oauth/requests/decision` goes through the API's ordinary dispatch, so it already requires: the session cookie (`SameSite=Lax`, `HttpOnly`, `__Host-` and `Secure` on https), the custom `x-tabula: 1` header (which a cross-site page cannot add without a CORS preflight the server never grants) and a matching `Origin`. On top of that:

| Protection | Mechanism |
| --- | --- |
| CSRF, per-request nonce (double submit) | `GET /api/oauth/requests` returns a nonce derived with HMAC from the request id, session id and expiry. The POST must carry it in the body; the server compares in constant time and requires the same session id. No nonce row is stored. A page that cannot read the GET response (cross-origin) cannot produce it. |
| Replay | an Allow transaction inserts the request id as a one-time marker; a second Allow for that id is `404`. Deny creates no grant and may be repeated harmlessly. |
| Clickjacking | the consent app-shell response has `frame-ancestors 'none'` and `cache-control: no-store`; the consent route inherits these headers. `X-Frame-Options: DENY` is added to the app HTML and to the `/oauth/*` error page, and the **decision API** is JSON so framing it is moot. `TABULA_DEV_ALLOW_FRAMING` must never be set on a server people use (existing warning), and the consent route refuses to render when `window.top !== window.self` as a second line. |
| Open redirect | the `redirect` in the response is rebuilt from the `redirect_uri` in the HMAC-verified envelope plus `code`/`error`, `state`, `iss`; the client never supplies a URL to the decision call. Build it with `URL` and `URLSearchParams`. |
| Scope tampering | `scope` in the body must be one of the three, not above the maximum offered **for this person now** (recomputed server-side, never trusted from the page) |
| Tab-nabbing / leak | the redirect carries no cookie or token other than `code`; the page uses `referrer-policy: no-referrer` (already set on static HTML) |
| Double grants | a person has **one grant per client**; Allow for a client that already has an active grant revokes the old grant and issues a new one (so reconnecting does not pile up; capped additionally at 20 active grants per person, `409 grant_limit` shown as text) |

Allow: in one transaction insert the one-time request marker, create the grant (scope granted), insert the code row, and audit `mcp.oauth.authorize {decision:'allow', …}`. Deny: audit `{decision:'deny'}` and redirect with `error=access_denied`; no pending request row exists to delete. Both callback URLs use `URLSearchParams` for every parameter.

### 7.5 CSP and headers

The SPA's existing CSP (`script-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`) is unchanged; navigating away with `location.assign` is not restricted by `connect-src` or `form-action`. The consent app-shell response and all consent API responses have `cache-control: no-store`; the consent route inherits the SPA CSP with `frame-ancestors 'none'`. The plain error page and metadata documents get `content-security-policy: default-src 'none'; frame-ancestors 'none'`. Every `/oauth/*` and `/api/oauth/*` response has `cache-control: no-store` and `x-content-type-options: nosniff`; redirects from `/oauth/authorize` add `referrer-policy: no-referrer`.

## 8. Gating

OAuth stays off by default in slice 1; the default switches on only after slice 5 passes.

| Setting | Behaviour |
| --- | --- |
| `TABULA_MCP` off (default) | **No change from today**: `/mcp` and token routes `404`, and now also `/.well-known/oauth-*`, `/oauth/*`, `/api/oauth/*`, `/api/me/grants`, `/api/admin/grants` `404` (`{error:'not_found'}`); no table is read; `tbo_` is not accepted anywhere. |
| `TABULA_MCP=on`, open mode (`TABULA_AUTH` off) | There are no users, so nothing to bind a grant to: all OAuth paths `404`. The shared open-mode token keeps working unchanged. `TABULA_MCP_OAUTH` is ignored with one log line (like `TABULA_MCP_TOKEN` in accounts mode). |
| `TABULA_MCP=on`, accounts mode | OAuth is off unless `TABULA_MCP_OAUTH=on`. |
| `TABULA_MCP_OAUTH=off` (new, default `off` in slice 1) | All OAuth paths `404`; the 401 on `/mcp` goes back to plain `WWW-Authenticate: Bearer`; `tbo_` tokens are refused (`401`) **immediately**, but rows are kept, so switching back on restores existing grants until they expire. Personal tokens are unaffected. Any other value than `on`/`off` refuses startup. |
| `TABULA_OAUTH_REDIRECTS` (`known` by default, or `none`) | Enables the built-in exact provider redirects, known localhost paths and the one tolerated Cursor URI. `none` disables those built-ins while preserving configured redirect hosts and schemes. Any other value refuses startup. |
| `TABULA_BASE_URL` `http://` for a non-loopback host | already refuses startup with MCP on; OAuth inherits it (codes and tokens must not cross the network in clear text). |
| Maintenance (restore in progress) | `503` + `retry-after: 30` on OAuth paths, like `/mcp`. |
| Hosted read-only workspace | Registration and token refresh keep working (reads work); **creating a grant** (Allow) is refused `402 read_only`; revoking is always allowed (`readOnlyOk`). Grants are not seats and never touch the seat limit. |

`server/config.mjs` `loadMcp` gains `oauth: boolean` (`config.mcp.oauth`) and the issuer. docs/cloud.md gets a line in the environment table (the control plane need not set it) and the A8 forwarding requirement.

## 9. `/mcp` responses and challenges

Only when OAuth is on:

| Situation | Response |
| --- | --- |
| No `Authorization` header | `401`, `WWW-Authenticate: Bearer resource_metadata="https://HOST/.well-known/oauth-protected-resource/mcp"` (no `error`, per RFC 6750 section 3.1 when no credentials were sent) |
| Token presented but unknown, expired, revoked, wrong audience, user disabled | `401`, `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`. Body unchanged: `{error:'invalid_token', message:'The token is unknown, expired or revoked.'}`, so the answer still reveals nothing about which. |
| Too many wrong tokens from one IP | `429` as today |
| OAuth token too weak for a tool (`tools/call` of a tool above the grant scope) | **`403`, `WWW-Authenticate: Bearer error="insufficient_scope", scope="write", resource_metadata="…"`** so the client may step up through a new authorization. `tools/list` already hides such tools, so this is reached only by a client that guesses. A `tbl_` token keeps today's tool-level `forbidden` result (an `isError` result, HTTP 200). Role problems (a viewer on a board) stay tool-level `forbidden` for both kinds: re-consenting cannot fix them. Interop tests must check that Claude performs at most one step-up and does not loop after this response (Q10). |

`tbl_` tokens get the same `resource_metadata` pointer on their 401 (the header is a hint; it changes nothing for header-token clients). With OAuth off or in open mode the header stays `WWW-Authenticate: Bearer`. `GET`/`DELETE /mcp` stay `405`. The `Origin` refusal on `/mcp` is unchanged and does not apply to the OAuth endpoints, which have their own rules (7.4; metadata CORS in section 3).

## 10. Admin and account UI, audit

### 10.1 Where grants appear

Grants are listed **next to** personal tokens, not hidden elsewhere, in both places that list `tbl_` tokens:

- **AI tool access** dialog (`src/ui/tokens.ts`, account menu): when OAuth is on, a second section "Connected apps" appears under the token list. Rows show the client name as text, redirect host, access level (*Read*, *Read and comment*, *Read and edit*), board count or all boards, created, last used, connection expiry, and a **Disconnect** button (armed confirmation). The existing **Revoke all** also disconnects every app; its confirmation text says so, and the response is `{revoked, grants}`. `GET /api/me` reports `mcpOauth: boolean` so the client knows whether to show this section. "Sign out everywhere" also revokes every grant for that user.
- **Admin → Access tokens** (`tokensAdminPanel`): one table combines personal tokens and connectors, with a "Type" column (*Personal token* or *Connector* plus the client name), person, access, boards, last used, expiry and revoke/disconnect actions. **Disconnect all apps** appears only when OAuth is on and active grants exist. Admins can disconnect any person's grant; acting on an owner's grant follows the same `guardOwner` rule as tokens.

Grant views never contain board ids, hashes, tokens or resource URLs. Personal token hints (the last four characters) may still appear in the admin table. API:

| Route | Rules |
| --- | --- |
| `GET /api/me/grants` | own active grants `{id, clientId, clientName, redirectHost, scope, boardCount, createdAt, lastUsedAt, expiresAt}`; `boardCount: null` means all boards the person can open |
| `DELETE /api/me/grants/:id` | own only (`404` otherwise); `readOnlyOk` |
| `GET /api/admin/grants` | `requireAdmin`; adds `userId, userName, email, userRole` |
| `DELETE /api/admin/grants/:id` | `requireAdmin`, `guardOwner`; `readOnlyOk` |
| `POST /api/me/tokens/revoke-all` | extended: also revokes the person's grants |
| `POST /api/admin/grants/revoke-all` | `requireAdmin`; revokes every grant in the workspace; `readOnlyOk` |

`src/ui/tokens-logic.ts` merges the two lists into one view model (kind `token` | `grant`) so the pure-logic tests cover both. Disabling, removing or demoting a user to guest revokes their grants; the all-sessions sign-out action does too. Revoking a grant sets `revoked_at` on the grant; every access and refresh token of it fails the live join on the next request (no per-token update needed, the same "stops working on the very next request" property as `tbl_`).

### 10.2 Audit

Rows go through `directory.audit` with the existing `audit()` helper; details never contain a code, token, verifier or digest. New actions are added to `KNOWN_AUDIT_ACTIONS` in `src/ui/admin-logic.ts`, to `auditSentence`, and the existing test that scans for known actions (test/admin.test.ts) gets the new ones.

| Action | Actor | Detail | Sentence |
| --- | --- | --- | --- |
| `mcp.oauth.client_registered` | none (system) | `{clientId, clientName, redirectHosts}`; written only for a **new** client (not for an idempotent repeat), and not at all when the registration was rate limited | "An app registered itself as "<name>"" |
| `mcp.oauth.authorize` | the person | `{clientId, clientName, scope, decision: 'allow'\|'deny', grantId?}` | allow: "<who> connected "<name>" with <read only / read and comment / read and edit> access"; deny: "<who> declined to connect "<name>"" |
| `mcp.oauth.revoke` | the person, the admin, the system for user-state/session events, or none for a client request | `{grantId, clientName, userId?, by: 'self'\|'admin'\|'client'\|'user_state'\|'sign_out_everywhere'}` | self: "<who> disconnected "<name>""; admin: "<who> disconnected "<name>" from <member>"; system events record the reason; client: ""<name>" disconnected itself from <member>"" |
| `mcp.oauth.revoke_all` | the admin | `{grants}` | "<who> revoked all connected apps" |
| `mcp.oauth.reuse_detected` | none (system) on behalf of `userId` | `{grantId, clientName, userId, kind: 'code'\|'refresh'}` | "A used <sign-in code / refresh token> was presented again; "<name>" was disconnected from <member>" |
| `mcp.token.revoke_all` (existing) | the person | `{count, grants}` (`grants` optional, so old rows still render) | existing sentence plus " and N connected apps" when `grants > 0` |

Not audited: `refresh`, `register` repeats, `last_used_at`. Client names are the client's own text: `clip(…, 60)` and `quote()` in sentences, `textContent` everywhere (the audit view already escapes).

## 11. Rate limits and abuse controls

Window limiters, the shape of `createWindowLimiter` in `server/mcp.mjs` (to be moved to `server/limiter.mjs` and imported by both), use `clientIp(req)` and the OAuth client identity so Claude connectors sharing Anthropic egress IPs do not share one client's quota. General OAuth buckets key by `(ip, client_id)`; refresh has an additional per-grant bucket. Return `Retry-After` on `429`.

| Endpoint | Limit | Notes |
| --- | --- | --- |
| `POST /oauth/register` | 10 new registrations/hour/IP, 100/hour/instance, 500 clients | 4.4; idempotent repeats do not count |
| `GET /oauth/authorize` | 30/minute per `(ip, client_id)` | over the limit: plain `429` page (unknown clients are handled by the IP bucket; no redirect before validation); stateless requests create no pending-row pool |
| `POST /oauth/token` | 30/minute per `(ip, client_id)`; **failures** (any `invalid_grant`/`invalid_client`) 10/minute per `(ip, client_id)`; refresh additionally limited per grant | a good refresh is not held back by failures of another client behind the same address |
| `POST /oauth/revoke` | 30/minute per `(ip, client_id)` | |
| `/api/oauth/requests/*` | the API's own limits, plus 10 decisions/minute/session | |
| `/mcp` with `tbo_` | the existing per-grant call/write buckets and the 20/minute wrong-token bucket | |
| Metadata GET | 120/minute/IP (cheap, cacheable) | |

Bodies are size-capped (8 KiB) and the content type is checked (`415`). Request-line and header sizes rely on Node defaults. Per-instance caps (500 clients, 20 grants/person) bound table growth even when one IP limit is bypassed through many addresses. Authorization is stateless until Allow, so there is no pending-request row pool to exhaust. Sweeps (section 12.3) run opportunistically and on a timer.

## 12. Data model

### 12.1 Migration

`MIGRATIONS` in `server/directory.mjs` currently has 15 entries; the new one is **migration 16**, defined in a new `server/oauth.mjs` (`OAUTH_MIGRATION`, like `TOKENS_MIGRATION` in `server/tokens.mjs`) and registered in `directory.mjs` with one spread/entry. It is **expand-only** (new tables and indexes only), declared as `{ sql, minReader: 11 }`, not a plain string: a plain string would set `minReader` to 15 and break rollback to v5.0.1 (generation 11). The v5.0.1 build can open and run the database after it, ignores the new tables, and (because it does not know `tbo_`) simply rejects OAuth tokens (fail closed). **Release notes and rollback runbook must state:** rollback to v4 is unsafe after this ships; the control-plane dry run reports `rollbackSafe=false`. The slice 4 changelog fragment should say: "Rollback to v4 is unsafe after migration 16 ships (`rollbackSafe=false` in the control-plane dry run); follow the rollback runbook." Do not describe v4 as a safe rollback target. The migration lint must pass.

```sql
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,                -- client_id
  name TEXT NOT NULL,                 -- sanitised, <= 80
  redirect_uris TEXT NOT NULL,        -- JSON array of strings, 1..5
  fingerprint TEXT NOT NULL UNIQUE,   -- sha256(name + sorted redirect uris), makes registration idempotent
  max_scope TEXT NOT NULL DEFAULT 'write' CHECK (max_scope IN ('read','comment','write')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL       -- last registration repeat or grant activity; drives expiry
);
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,                -- signed envelope request id, 128-bit random
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL         -- +10 minutes; row is inserted only on Allow as a replay marker
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('read','comment','write')),
  board_ids TEXT,                     -- NULL = every board the person can open, now and later; otherwise selected board ids
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,        -- absolute cap, created_at + 180 days
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT                 -- 'self' | 'admin' | 'client' | 'reuse' | 'replaced' | 'restore' | 'adopt' | 'user_state' | 'sign_out_everywhere'
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,         -- sha256 of the tbc_ code
  request_id TEXT NOT NULL UNIQUE,    -- prevents a signed Allow request from being applied twice
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read','comment','write')),
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,        -- +60 seconds
  used_at INTEGER
);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read','comment','write')),  -- issuance scope; effective scope is min(token scope, current grant scope)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,                    -- refresh: set when rotated
  replay_ciphertext TEXT,             -- encrypted replacement pair for the one 20-second retry
  replay_until INTEGER,
  replay_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
```

Lookups: `findOauthAccessToken(token)` = `oauth_tokens t JOIN oauth_grants g JOIN users u WHERE t.token_hash = ? AND t.kind='access' AND g.revoked_at IS NULL AND g.expires_at > now AND t.expires_at > now AND u.disabled = 0`, then the resource check in code. The effective scope is `min(t.scope, g.scope)`. Refresh rotation, persisted scope narrowing, the one allowed 20-second replay and reuse revocation run in one `directory.transaction`. A repeat returns the exact encrypted replacement pair once; on that retry, clear the ciphertext and increment `replay_count`. Code redemption marks `used_at` with `UPDATE … WHERE used_at IS NULL` and checks the change count, so two concurrent redemptions cannot both win. The signed request marker and code insert are also atomic.

### 12.2 Store module

`createOauthStore({get, all, run, transaction})` in `server/oauth.mjs` (mirrors `createTokenStore`): `registerClient`, `getClient`, `signRequest`, `readRequest`, `decideRequest`, `redeemCode`, `refresh`, `findAccessToken`, `touchGrant`, `listGrants(userId)`, `listGrantsAdmin`, `getGrant`, `revokeGrant(id, reason)`, `revokeUserGrants(userId)`, `revokeAllGrantsInstance`, `invalidateAfterRestore`, `purgeClients`, `sweep`. `signRequest` and `readRequest` are stateless; `decideRequest` inserts the one-time request marker only on Allow. Endpoint handlers (`server/oauth-routes.mjs`) hold validation and HTTP; the store holds SQL. Constants (`TOKEN_PREFIX_OAUTH = 'tbo_'`, refresh `tbr_`, code `tbc_`, lifetimes) live once in `server/oauth.mjs`, like `TOKEN_PREFIX` in `server/tokens.mjs`.

### 12.3 Retention and cleanup

| Row | Removed |
| --- | --- |
| `oauth_requests` | replay marker inserted only on Allow; removed at its 10-minute expiry, on restore, and by the timer |
| `oauth_codes` | 10 minutes after `expires_at` (kept briefly so reuse of an expired/used code can still be recognised and revoke its grant) |
| `oauth_tokens` | 7 days after `expires_at` (rotated refresh rows are kept until then for reuse detection) |
| `oauth_grants` | 30 days after `revoked_at` or `expires_at` (as `access_tokens` sweeps after 30 days) |
| `oauth_clients` | unused 7 days; used 90 days after `last_used_at` with no active grant (4.4) |

`sweep()` runs inside `registerClient`, `signRequest`, `decideRequest` and `redeemCode` (cheap `DELETE … WHERE expires_at < ?`) and on a 10-minute `setInterval` with `unref()`. Backups include the tables (they are in `directory.sqlite`); every whole-workspace restore revokes grants and clears request markers and codes as in 6.3. Volume adoption additionally removes clients. Operators can purge all registered clients through the maintenance purge, which cascades their grants, tokens and codes.

## 13. Threat model

| Threat | Mitigation |
| --- | --- |
| PKCE downgrade (client omits PKCE, or asks for `plain`) | Authorize refuses anything but `code_challenge_method=S256` with a 43-char challenge; the token endpoint refuses a code with no verifier. `plain` is not advertised or implemented. |
| Authorization code interception (malicious app on the redirect path, leaked via logs/Referer) | Code is useless without the verifier; 60 s life; single use; bound to client and exact `redirect_uri`; reuse revokes the grant; `referrer-policy: no-referrer`; hashed at rest. |
| Redirect URI or issuer tricks (trailing slash, case, userinfo `https://claude.ai@evil.example`, fragment, wildcard, open subdomain, path traversal, `localhost.evil.com`) | Registration requires canonical `new URL().href` equality; web URIs have no userinfo, fragment or wildcard and must match an exact built-in URI, configured host or configured scheme; exact string match at authorize and again at token; loopback accepts `127.0.0.1` and `[::1]` for any path and only the built-in localhost paths. `TABULA_BASE_URL` with a path, userinfo, query or fragment disables OAuth. |
| Open redirect via `/oauth/authorize` | Never redirects before `client_id` and `redirect_uri` are validated against the registry; the consent decision redirects only to the URI in the HMAC-verified envelope; `URL` and `URLSearchParams` build every response; no `next`/`return` parameter accepts a URL. |
| CSRF on consent (attacker page auto-approves) | Decision needs the session cookie (`SameSite=Lax`), `x-tabula` header with Origin check (not forgeable cross-site), and a session-bound HMAC nonce readable only by the same origin; an explicit Allow is required. |
| Clickjacking or caching the Allow screen | `frame-ancestors 'none'` + `X-Frame-Options: DENY`; consent JS refuses to run framed; consent document and API responses are `no-store`. |
| Lookalike / malicious client (phishing: name "Claude" with host `evil.example`) | Hosted registration accepts the built-in exact callbacks by default or an explicit exact host list; it refuses a wildcard. The name is always presented as a claim; built-in callbacks get a provider badge, other exact allowlisted hosts get "Verified host", and every other destination gets an extra warning. Self-hosted `*` is an explicit opt-in. Read is the default; grants are listed, revocable, and audited. |
| Confused deputy / token for another resource (RFC 8707) | `resource` must equal `<issuer>/mcp`; stored on the grant and re-checked at every `/mcp` call; tokens are per instance; Tabula never passes the token on. |
| Token theft (logs, disk, backup) | Opaque, only SHA-256 stored (as `tbl_`); never logged; 1 hour access life; refresh rotates; `no-store`; revocable instantly; distinct prefixes help secret scanning. |
| Refresh token theft/replay or ordinary concurrent refreshes | Rotation and one 20-second replay of the same replacement pair; any later or additional reuse revokes the whole grant; 180-day cap; bound to client id; scope narrowing persists. |
| Scope escalation or board access widening | Token request scope can only narrow; narrowing persists as the grant ceiling. Consent options are recomputed server-side and role caps are live. `board_ids = NULL` is disclosed as all boards the person can open now and later. Board picker is required before owner/admin write grants and before write is offered to non-owners on shared workspaces. |
| Privilege widening after promotion | An unrestricted grant held by someone now owner/admin acts as `read` until re-consented with a board picker and selected board ids. |
| DCR or anonymous authorize pool exhaustion | New registrations have per-IP/instance limits and a 500-client cap; idempotent repeats do not count; unused clients expire after 7 days. Authorize requests are HMAC-signed and stateless until Allow, so they cannot fill a pending-request table. Operators can purge registered clients. |
| SSRF | Tabula **never fetches** any client-supplied URL: `client_uri`, `logo_uri`, `jwks_uri`, `tos_uri`, `policy_uri` are ignored and not stored; `redirect_uri` is only ever sent to the browser as a `Location`, never requested by the server. No `client_id` metadata document (CIMD) support in v1 (Q11). |
| XSS / injection via `client_name` | Sanitised on input (controls, bidi); rendered with `textContent`/escaped everywhere (consent, lists, audit); length 80; never put into HTML, a header or a log line unescaped; fenced when handed to the model (`whoami`). |
| Header injection / log forging | Names stripped of CR/LF and controls; logs record ids, not names or tokens. |
| Cross-workspace use or restore resurrecting revoked grants | Per-instance token store (unknown token elsewhere); resource and issuer are the instance's `baseUrl`; every whole-workspace restore revokes all grants and clears request markers/codes; volume adoption also deletes clients. |
| Mix-up attack | `iss` returned in every authorization response; one issuer per instance. |
| Timing | Digest lookups by `UNIQUE` hash (no secret comparison), PKCE `timingSafeEqual`, identical error for unknown/expired code, constant-time nonce compare. |
| Session fixation / login CSRF through the sign-in return | The return carries only a signed, expiring request envelope; the mailed link still logs the person into **their own** account; the grant is still created only on an explicit Allow. |
| Guest, disabled or removed user obtaining access | Guests are refused by the API gate and `/mcp`; disabling, removing, demoting to guest and signing out everywhere revoke grants. |
| Enumeration of clients/requests | `client_id` and request id are 128-bit random; envelope tampering and expiry fail verification without creating a row. |
| Downgrade by turning OAuth off | Off means `404` and `tbo_` refused at once (fail closed). |

### 13.1 Residual risks accepted in slice 1 (security review)

- **Refresh replay window.** For 20 seconds anyone holding the just-rotated refresh token and the `client_id` gets the same replacement pair back once. A stolen old token used inside the window is not detected at that moment; it is detected when the second holder rotates after the window, or on a third presentation (family revoked). This is the usual RFC 9700-style grace window; keep it at 20 seconds.
- **Spoofed connector names.** Dynamic registration lets anyone choose the displayed client name. The consent API returns `clientNameIsClaim` and the redirect host; the consent UI (slice 2) must show the host, and an "unverified" marker where the name is, for every host not on the exact allowlist, loopback and custom-scheme clients included.
- **Registration is unauthenticated by design.** A client that never receives a grant lives one hour; repeating its registration does not extend that; when the 500-client cap is reached the oldest never-granted client is dropped, so the cap cannot be held. The per-IP (10 per hour) and instance (100 per hour) limits remain, and a distributed flood can still use up the instance limit for an hour: a real connector then gets 429 and retries later.
- **`max_scope` of a client** is self-asserted at registration and kept as first registered; the real caps are applied at consent and at each call.
- **`directory.oauthInternals`** (test only, `openDirectory(file, { oauthInternals: true })`) holds the store functions that skip consent, PKCE and user-state checks; nothing in the server passes that option.

## 14. Test plan

New files: `test/oauth-store.test.ts` (SQL, pure), `test/oauth-routes.test.ts` (HTTP against the spawned relay with the existing `mcp-harness.ts`), `test/oauth-gating.test.ts`, UI logic in `test/tokens-logic.test.ts` / `test/tokens-admin-panel.test.ts`, `test/admin.test.ts` for audit sentences, and one browser e2e (slice 5). The protocol smoke test with `@modelcontextprotocol/sdk` (devDependency) gains an OAuth run using its `OAuthClientProvider` against the relay.

### 14.1 Security tests (each must exist)

| Area | Cases |
| --- | --- |
| PKCE | missing `code_challenge` → redirect `invalid_request`; `plain` → refused; unknown method; challenge of wrong length/charset; token request with no verifier; wrong verifier → `invalid_grant` **and the code is burned** (a second try with the right verifier also fails); verifier of 42 and 129 characters |
| Redirect URI and issuer | registration refuses lookalikes of the exact built-in URIs, `http://example.com/cb`, userinfo, fragment, wildcard, `javascript:`, 6 URIs and non-canonical forms; hosted registration accepts built-in exact callbacks or configured exact hosts and always refuses a wildcard; self-hosted `*` is explicit and never marks a host verified; authorize mismatch for trailing slash, different case, added query, other port (web), other path, subdomain and `https://claude.ai@evil.example/cb`; `127.0.0.1` and `[::1]` loopback with a different port **match**, with a different path they do not; localhost accepts only `/callback`, `/oauth/callback` and `/oauth_callback` while built-ins are enabled and also ignores its port; `TABULA_BASE_URL` path, userinfo, query or fragment disables OAuth; unknown client or unregistered URI **does not redirect** (renders the error page, asserts no `Location` header) |
| Code | reuse → `invalid_grant` **and the grant's access and refresh tokens stop working**; expired (fake clock +61 s); redeemed with another `client_id`; with another `redirect_uri`; two concurrent redemptions (one wins) |
| Refresh | rotation returns new tokens, old refresh invalid; two concurrent refreshes of the same token return the same new pair (one initial response, one replay); one replay within 20 seconds succeeds, a second replay or a replay after 20 seconds revokes the whole family; refresh of an expired / revoked grant; sliding window extends; 180-day cap; refresh with a different `client_id`; `scope` wider than granted → `invalid_scope`; narrower works and remains the ceiling on later refreshes; replay ciphertext is erased |
| Scope and role | consent decision with `write` for a viewer-only person → refused; owner/admin remains read-only until picker, then a write grant is limited to the selected boards; non-owner write on a shared workspace is unavailable before picker; `board_ids = NULL` displays all boards available now and later; editor role cap still applies per call; promotion to admin lowers an unrestricted grant to `read`; token request cannot add `scope`; `tools/list` of a `read` grant hides write tools; `tools/call` write tool with a read grant → `403 insufficient_scope` with the challenge |
| Resource | authorize with `resource` of another host / path / trailing slash → `invalid_target`; token request mismatch; grant whose stored resource differs from live `baseUrl` → `401` |
| Cross-workspace | a `tbo_` token minted on instance A presented to instance B → `401`; a `tbl_` token to the OAuth endpoints is `invalid_grant`; a `tbo_` access token on `/api/*` and `/sync` → refused; refresh token as bearer on `/mcp` → `401` |
| Revoked client/grant and restore | revoke by the person, by an admin (owner rule), by RFC 7009 (access token revokes the refresh too); disabled, removed or demoted-to-guest user; "sign out everywhere"; account and admin revoke-all actions; deleted client (cascade); every restore path clears request markers/codes and revokes all grants. Snapshot regression: take a snapshot with an active grant, revoke it, restore the snapshot, and assert that the restored grant remains revoked. |
| Expiry | access token at +1 h + 1 s → `401` with `error="invalid_token"`; client expiry sweeps (unused 7 days, used 90) |
| Stateless consent and redirects | authorize creates no row; signed envelope tampering/expiry is refused; Allow atomically writes the one-time marker, grant and code; envelope cannot be applied twice; unusual `state` round-trips via `URLSearchParams`; every callback parameter is encoded using `URLSearchParams`; consent errors and consent API responses are `no-store` |
| CSRF on consent | decision without `x-tabula`; with a foreign `Origin`; without the nonce; with a nonce from another request or session; second Allow after the marker exists (`404`) |
| Clickjacking | consent HTML / app response has `frame-ancestors 'none'` and `cache-control: no-store`; error page `X-Frame-Options: DENY` |
| DCR and rate limits | 11th new registration/hour → `429`; the 501st client; idempotent repeat returns same id and does not increment quotas; same IP with distinct `client_id`s gets distinct buckets; refresh is limited per grant; oversized body; client name controls, bidi, long text and HTML are sanitized/rendered as text; `client_uri` etc. not stored; `client_secret_basic` refused; hosted allowlist enforcement and operator purge work |
| Headers | token endpoint and consent route `cache-control: no-store`; `frame-ancestors 'none'`; `401` challenges (no header / bad token / insufficient scope); metadata documents byte-exact against the examples in section 3 with the issuer substituted and a forged `Host` header (must not change output) |
| Gating | MCP off → every OAuth path `404`; open mode → `404`; `TABULA_MCP_OAUTH=off` → `404`, `tbo_` refused, `tbl_` unaffected, rows kept; invalid `TABULA_BASE_URL` origin disables with a log line; maintenance `503`; read-only workspace: Allow `402`, refresh and revoke work |
| Regression | every existing MCP test unchanged; `tbl_` flow unchanged (aside from the added `resource_metadata` parameter); open mode unchanged; drive Claude through a `403 insufficient_scope` and assert it performs at most one step-up instead of repeating authorize/consent |
| Hygiene | no token, code, verifier or digest appears in logs, audit rows or error bodies (a test greps captured output after a full flow); `server/oauth*.mjs` do not import `node:fs` |

Time-sensitive and concurrent OAuth coverage also runs on Windows with `npm run test:repeat -- test/oauth-store.test.ts test/oauth-routes.test.ts --platform win32 --times 15`.

### 14.2 Interop notes

- The official MCP SDK client (`auth()` helper with an in-memory `OAuthClientProvider`) must complete discovery, registration, authorize, token, refresh and a `tools/list` call against the relay.
- Check by hand with a real connector in claude.ai (web) and Claude Desktop on a staging workspace before announcing: A1 to A7 and A9. A8 is verified. Record which redirect URIs Claude registered, whether `resource` and `state` were sent, whether `scope` was sent, refresh retry behavior, and whether a `403 insufficient_scope` triggers one step-up or loops.
- MCP Inspector (browser) needs the metadata CORS headers; confirm only the metadata endpoints are fetched cross-origin.
- RFC conformance spot checks: RFC 6749 error codes, RFC 7009 `200` on unknown token, RFC 8414 field names, RFC 9207 `iss`.

## 15. Implementation slices

Each slice is mergeable and tested on its own; OAuth stays dark until slice 1 lands and `TABULA_MCP_OAUTH` defaults on only after slice 5 passes.

| # | Slice | Files |
| --- | --- | --- |
| 1 | **Server core**: migration 12, store, config flag, metadata documents, DCR, authorize (stateless signed request; marker created only on Allow), token, revoke, `/mcp` authenticate for `tbo_`, 20-second refresh replay, `WWW-Authenticate` challenges, client-aware limiters, relay routing and gating, revocation on every whole-workspace restore. Includes a test-only decision endpoint path through the real API route. | `server/oauth.mjs` (new), `server/oauth-routes.mjs` (new), `server/limiter.mjs` (new, moved from `mcp.mjs`), `server/directory.mjs` (register migration, revoke methods, store spread), `server/mcp.mjs`, `server/relay.mjs`, `server/config.mjs`, `server/api.mjs` (request/decision routes), `server/auth.mjs` (`oauthRequest` in the sign-in link), `server/restore.mjs`, tests `test/oauth-store.test.ts`, `test/oauth-routes.test.ts`, `test/oauth-gating.test.ts`, `test/mcp-harness.ts` |
| 2 | **Consent UI**: signed `#/oauth/consent` route, sign-in return, session-bound nonce/decision calls, deny, errors, framing and no-store headers, board picker, 360 px layout, a11y | `src/ui/oauth-consent.ts` + `.css` (new), `src/route.ts`, `src/main.ts`, `src/ui/signin.ts`, `src/api.ts` (client calls), tests for the view-model in `test/oauth-consent-logic.test.ts` |
| 3 | **Grants in Admin and AI tool access**, audit sentences, admin revoke-all grants | `src/ui/tokens.ts`, `src/ui/tokens-logic.ts`, `src/ui/tokens.css`, `src/ui/admin-logic.ts` (`KNOWN_AUDIT_ACTIONS`, `auditSentence`), `server/api.mjs` (`me/grants`, `admin/grants`, revoke-all routes), `test/tokens-logic.test.ts`, `test/tokens-admin-panel.test.ts`, `test/admin.test.ts` |
| 4 | **Docs**: rewrite the Claude Desktop paragraph in docs/mcp.md ("OAuth is not in this slice" is replaced), add the OAuth section and env var, `docs/admin.md` Access tokens tab, `docs/cloud.md` (verified edge behavior A8, env), user guide page for "Connect Claude" (`docs/guide/…`), `changelog.d/<id>.md` fragment (not `CHANGELOG.md`) including the v4 rollback warning, `npm run changelog:check` | `docs/mcp.md`, `docs/admin.md`, `docs/cloud.md`, `docs/guide/*`, `changelog.d/` |
| 5 | **End-to-end**: a scripted OAuth client (discovery, DCR, PKCE, loopback redirect receiver) drives the real flow through a headless browser: sign in by mailed link (`TABULA_MAIL=file`), consent Allow, token, `tools/list`, edit a board, refresh, revoke in the UI, confirm `401`; plus a Deny path and a 360 px screenshot | `test/e2e/…` (location to confirm against the repository's existing browser tests and `docs/e2e-hosted.md`), `scripts/` helper if needed |

Order: 1 → 2 → 3 can overlap after 1; 4 with 3; 5 last and gates the default-on switch.

## 16. Open questions (with the default taken in this spec)

| # | Question | Default |
| --- | --- | --- |
| Q1 | Count OAuth grants against the 20-token cap? | No: separate cap of 20 active grants per person, one per client. |
| Q2 | Require a board picker before owner/admin write grants and before non-owner write grants on shared workspaces? | Yes. Owner/admin write grants are a launch requirement only with selected-board limits; do not offer write to non-owners on shared workspaces until the picker can limit the grant. |
| Q3 | What redirect policy is enabled by default? | `TABULA_OAUTH_REDIRECTS=known` is the default on hosted and self-hosted workspaces; it enables the exact provider table and known localhost paths in 4.2. Hosted registration also accepts an explicit non-empty exact `TABULA_OAUTH_REDIRECT_HOSTS` list and always refuses `*`. Self-hosted operators can set an exact host list or explicitly opt into any HTTPS host with `TABULA_OAUTH_REDIRECT_HOSTS=*`. Set `TABULA_OAUTH_REDIRECTS=none` to disable only the built-ins. |
| Q4 | Require `resource`? | No: absent means `<issuer>/mcp` (A3 unverified); present must match. Tighten once Claude is confirmed to send it. |
| Q5 | Grace window for a refresh retried after a lost response? | 20 seconds. The same just-rotated token returns the same replacement pair once; any further or later reuse revokes the family. |
| Q6 | Absolute cap on a refresh family? | 180 days, then re-consent. |
| Q7 | Serve root aliases `/authorize`, `/token`, `/register` for 2025-03-26 clients that skip metadata discovery? | No. Add only if a target client needs it. |
| Q8 | Sign-in link opened in another browser: continue the consent there? | Yes: the signed envelope is stateless and remains valid for 10 minutes; the other browser still requires an authenticated session and explicit Allow. |
| Q9 | Workspace name on the consent screen | The host of `TABULA_BASE_URL`, until a workspace-name setting exists. |
| Q10 | HTTP `403 insufficient_scope` for OAuth tool calls above the scope, or tool-level error only? | Keep `403` for OAuth tokens, tool-level for `tbl_` and role denials. Add an interop regression test that Claude does not loop on step-up. |
| Q11 | Support Client ID Metadata Documents (client id is an HTTPS URL, newer MCP revisions)? | No: it requires the server to fetch a client-controlled URL (SSRF surface). DCR only. |
| Q12 | Allow `localhost` as a loopback host (A6)? | Yes, with the built-in list enabled and only for `/callback`, `/oauth/callback` and `/oauth_callback`; always accept `127.0.0.1` and `[::1]`. |
| Q13 | Private-use schemes (`claude://`) for Desktop? | Refused unless `TABULA_OAUTH_REDIRECT_SCHEMES` lists them. |
| Q14 | CORS on `register`/`token`/`revoke` for browser-based MCP clients? | None (A1). Metadata only. |
| Q15 | Should "Sign out everywhere" revoke grants, and should admins have a revoke-all-grants action? | Yes. Sign-out-everywhere revokes the user's grants; Admin → Access tokens adds a workspace-wide **Revoke all grants** action. |
| Q16 | Refresh token lifetime numbers (30 d sliding, 180 d cap) and access life (1 h) | As written; make them constants in `server/oauth.mjs`, not environment variables. |

## Review log

| Finding | Where it landed |
| --- | --- |
| 1 | Sections 4.2, 7.2, 13 and 14.1: hosted exact allowlist default/refusal, verified-host label, unverified-host warning and client name presented as a claim. |
| 2 | Sections 6.3, 12.1, 12.3, 14.1 and 15: every whole-workspace restore revokes grants and clears request markers/codes; snapshot regression and rollback runbook. |
| 3 | Sections 6.2 and 7.2: disclose `board_ids = NULL` as all boards available now and later; picker prioritized before shared-workspace non-owner write grants. |
| 4 | Sections 6.2, 7.2, Q2 and 15: owner/admin write grants require a launch board picker; until then their connector is read-only. |
| 5 | Sections 6.3 and 10.1: user lifecycle changes and sign-out-everywhere revoke grants; admins get a workspace-wide revoke-all action. |
| 6 | Sections 5.4, 12.1 and 14.1: one same-pair refresh replay within 20 seconds; later/additional reuse revokes the family; concurrent-refresh test. |
| 7 | Sections 4.4, 11 and 14.1: `(ip, client_id)` buckets, per-grant refresh limits and idempotent registration exclusion. |
| 8 | Sections 5.1, 7.1, 7.4, 12.1–12.3, 13 and 14.1: signed stateless authorize envelope, no row until Allow, and operator client purge. |
| 9 | Sections 3.1, 8 and 14.1: reject issuer userinfo, query, fragment and non-root path. |
| 10 | Sections 5.1, 5.2, 7.4 and 14.1: use `URLSearchParams` for state and all redirect parameters. |
| 11 | Sections 5.4, 12.1 and 14.1: refresh scope narrowing permanently lowers the grant ceiling. |
| 12 | Sections 2/A6, 4.2, 14.1 and Q12: IP loopback literals always allowed; known localhost callback paths enabled by default. |
| Other | Sections 2/A8, 3, 7.5, 12.1, 14.1 and 15: verified edge behavior and 503 discovery note, no-store/framing headers, and the v4 rollback warning. Section 14.2 also tests the 403 step-up loop. |

## Build requirements from the second review (tech lead)

1. Authorize envelope: HMAC key derived with a labelled KDF from APP_SECRET (own context string, separate from the nonce key and the replay-encryption key; never APP_SECRET itself). It carries client_id; at Allow the client must still exist and the redirect URI must still be one of its registered URIs (a purge in between fails closed). Constant-time verify; unknown versions rejected. Tests: tampered, expired, other-instance-signed, purged-client envelopes.
2. Refresh replay window: the replacement pair is stored AEAD-encrypted (AES-256-GCM, fresh nonce, key from the labelled KDF), lives 20 s, erased on use, on expiry and on restore, never logged; the access token is not readable from a database backup after the window. Tests: third presentation revokes the family; a repeat after 20 s revokes; ciphertext gone after the window.
3. Restore: revoke-all runs in the same step that swaps the restored database in (not a later job). Keep the revoke-then-restore test.
4. The authorize endpoint keeps its per-IP limit although it writes no row.
5. Hosted OAuth defaults: `TABULA_OAUTH_REDIRECTS=known` enables the exact provider callbacks. The control plane may additionally set `TABULA_OAUTH_REDIRECT_HOSTS` for other exact callback hosts; until then, only the built-in URI table is accepted for hosted web callbacks.
