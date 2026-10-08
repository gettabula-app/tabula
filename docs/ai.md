# AI features

AI that works on the board the person has open: write stickies from a prompt, summarise a board or a retro into notes and action items, group stickies into themes. Phase 1 runs on an API key the workspace or the person brings (**bring your own key**, BYOK). Phase 2 adds AI as part of the hosted service: each plan includes credits, and more can be bought.

Status: **slices A and B of phase 1 are built (TAB-97): the provider layer, encrypted keys, the settings and key endpoints and their admin and account screens (A), and `POST /api/ai/run` with the three features, the limits and the audit rows (B).** The board entry points, the proposal preview and everything in phase 2 are not built yet (slice C). "Slice A: what is built" and "Slice B: what is built" below list where the code differs from or adds to the text above. Recommended answers to the open questions in TAB-99 are at the end.

## Summary

- **Calls run on the relay, never in the browser**, in both modes. The browser sends "summarise this board"; the relay reads the board, calls the provider with the stored key and streams back a **proposal** (stickies to add, notes to move). The key never reaches a browser after it is saved.
- **The person applies the proposal.** The app shows it as a preview and writes it as an ordinary local edit, so it is undoable with Ctrl+Z, follows the person's role, and nothing changes the board until a person says so.
- **One provider layer** with Anthropic as the only provider in v1 (Claude Opus 5.5 by default, Claude Sonnet 5.5 and Claude Haiku 5.5 selectable), shaped so OpenAI-compatible providers fit later.
- **Keys are encrypted at rest** with a server secret, are never returned by any API, never written to a board document, never logged.
- **Reuses the MCP layer from TAB-12** for reading boards: the same private-note withholding, the same fencing of untrusted board text, the same object validators. Writes do not go through MCP (see "Why proposals").
- **v1 features:** generate stickies, summarise with action items, cluster stickies.
- **Phase 2:** credits per workspace, pooled across seats; prepaid top-up packs; the control plane meters and bills through Stripe, as it already does for seats.

## Where calls run

| Option | Verdict |
| --- | --- |
| **Relay proxy** (`POST /api/ai/run`, the relay calls the provider) | **Chosen** |
| Browser calls the provider directly with the user's key | Rejected |
| Browser direct in open mode, relay in accounts mode | Rejected |

Why not the browser, even in open mode:

- **The key would live in the page.** Any script on the origin (an extension, a future XSS bug, a pasted SVG that gets past the sanitiser) could read it from storage or watch it go out. On the relay it is one environment variable or one encrypted row, and no response ever carries it.
- **Board text drives the request.** Notes are written by everyone on the board, possibly an attacker (see "Untrusted content" in `docs/mcp.md`). On the relay the board is read with the MCP rules: private notes withheld, text fenced and cleaned. A browser reading its own document would need all of that again, and would see private notes it must not send.
- **Phase 2 needs the server anyway.** Credits cannot be enforced or metered in a browser. One path for both phases means one implementation, one set of tests.
- **Open mode stays simple.** There are no accounts to own a key, so open mode uses an operator key in the environment, as it already does for the MCP shared token.

Cost of the proxy: one extra hop (a few milliseconds next to a model call of seconds) and the relay holding a streaming connection for the length of a call. Calls are capped (see "Limits").

## Provider layer

`server/ai/` (plain `.mjs`, like the rest of `server/`):

```
providers.mjs   createProvider({ kind, apiKey, baseUrl? }) -> Provider
anthropic.mjs   kind 'anthropic', using @anthropic-ai/sdk
features.mjs    the v1 features: prompt, output schema, effort and token cap per feature, input checks, proposal validation
board.mjs       the board read of a run: scope, caps, nearest first, fenced
limits.mjs      in-memory counters: runs per hour, runs in flight, key saves
run.mjs         POST /api/ai/run: checks, key resolution, limits, board read, streaming, audit (accounts route and open-mode handler)
keys.mjs        key encryption, storage, verification
```

```
interface Provider {
  kind: 'anthropic' | 'openai-compatible'
  models(): string[]                      // what the admin can pick
  run(req: {
    model: string
    system: string                        // frozen per feature, first for caching
    content: string                       // the fenced board content and the person's prompt
    schema: object                        // JSON Schema of the proposal
    effort: 'low' | 'medium' | 'high'
    maxTokens: number
    signal: AbortSignal
  }): AsyncIterable<{ type: 'progress' } | { type: 'result', value: unknown, usage: Usage } | { type: 'refused', category: string | null }>
}
Usage = { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

### Anthropic (v1)

- Official SDK `@anthropic-ai/sdk`, `messages.stream(...)` with `.finalMessage()`; streaming because summaries of large boards can run long.
- Models: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5`. Exact ids, no date suffixes. The list lives in one constant; the admin picks one per workspace.
- **Structured output, not tools.** Each feature asks for one JSON object with `output_config.format` (JSON Schema). v1 features need no tool loop: the relay sends the board content it already read, the model returns a proposal. Forced `tool_choice` is refused by Claude Opus 5.5 and Claude Sonnet 5.5 anyway, and a tool loop would let board text steer which tools run.
- **Effort, not thinking switches.** `output_config.effort` per feature (table below). Thinking is left unset: Claude Opus 5.5 cannot turn it off, and its default effort is `medium`, so the spec always sets effort explicitly.
- **Refusals.** `stop_reason: "refusal"` is checked before reading the content and becomes `{ type: 'refused' }`; the app says "The AI declined this request" and changes nothing. For Claude Opus 5.5 and Claude Sonnet 5.5 the request opts into server-side fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), so a policy decline is retried on a suitable model inside the same call; the model that answered is recorded in usage.
- **Caching.** The system prompt is fixed per feature and comes first with `cache_control`, so repeated runs of a feature share a cached prefix. The board content comes after it.
- **Errors** map from the SDK's typed errors: authentication (bad key) `ai_key_invalid`, rate limit `ai_rate_limited` (with `retry-after`), overloaded or 5xx `ai_unavailable`, anything else `internal`. Messages never contain the key or board text.

### OpenAI-compatible (later)

A second adapter: `POST <baseUrl>/v1/chat/completions` with `response_format: { type: 'json_schema' }`, `baseUrl` stored with the key. It covers OpenAI and self-hosted servers that speak the same API (useful to self-hosters who want a local model). Not in v1: each provider's structured output and error behaviour needs its own tests and prompts, and the provider list in the UI grows. The interface above takes it without changes.

## Keys (BYOK)

### Who owns a key

| Mode | Key | Set by |
| --- | --- | --- |
| Open mode | `TABULA_AI_API_KEY` (and `TABULA_AI_PROVIDER`, default `anthropic`) | The operator, in the environment |
| Accounts mode | **Workspace key** | A workspace owner or admin, in the admin dashboard |
| Accounts mode | **Personal key** | Each person, in their account menu, only when an admin allows personal keys |

Resolution for a run in accounts mode: the person's own key if they set one and personal keys are allowed, else the workspace key, else (phase 2, hosted) the platform with credits, else AI is unavailable. The app shows which one a run will use ("Uses the workspace key", "Uses your key").

### Storage

- Table `ai_keys(id, scope 'workspace'|'user', user_id NULL, provider, base_url NULL, ciphertext, nonce, key_version, hint, created_at, created_by, last_used_at)` in the directory (a migration after the one TAB-67 adds). One row per scope (and per user).
- **Encrypted with AES-256-GCM** under a key-encryption key from `TABULA_AI_SECRET` (32 bytes, base64; the relay refuses to start with a malformed one). Each row has a random 96-bit nonce, and the associated data binds the row's scope and user, so a ciphertext copied to another row does not decrypt. Without `TABULA_AI_SECRET`, saving a key is refused (`ai_unconfigured`) and the admin UI says why.
- `hint` is the last four characters, the only part ever shown again.
- **Never returned.** `GET` endpoints return `{ provider, hint, createdAt, lastUsedAt }`. There is no endpoint that reveals a key, to anyone.
- **Never synced, never logged.** Keys are not in any Yjs document, `.drift` file or export. The request and error loggers redact `authorization`, `x-api-key` and the `apiKey` body field; a test asserts that a known key never appears in logs, audit rows or responses.
- **Verified on save** with a cheap call (`models.list()` for Anthropic). A key that fails is not stored (`ai_key_invalid`).
- **Rotation.** `TABULA_AI_SECRET_PREVIOUS` decrypts rows written under the old secret, which are re-encrypted on next use; `key_version` says which secret wrote a row. The steps are in "Rotating TABULA_AI_SECRET" below.
- Deleting a person removes their key (foreign key cascade). Deleting the workspace key is immediate; runs in flight finish.

### Endpoints

```
GET    /api/ai/config                -> { enabled, features: [...], keySource: 'user'|'workspace'|'platform'|null, model, credits?: {...} }
PUT    /api/ai/keys/me   { provider, apiKey, baseUrl? }   -> { provider, hint }      (when personal keys are allowed)
DELETE /api/ai/keys/me                                    -> 204
PUT    /api/admin/ai     { enabled?, features?, model?, personalKeys?, apiKey?, provider?, baseUrl? }   (owner or admin) -> settings, key hint
DELETE /api/admin/ai/key                                  -> 204
POST   /api/ai/run       { feature, boardId, input }      -> text/event-stream
```

All follow the existing API rules (JSON, CSRF header on writes, audit rows). In open mode only `GET /api/ai/config` and `POST /api/ai/run` exist.

### Rotating TABULA_AI_SECRET

`TABULA_AI_SECRET` is 32 random bytes as standard base64 (44 characters, for example `openssl rand -base64 32`). To replace it without asking anyone to enter their key again:

1. Generate the new secret.
2. Set `TABULA_AI_SECRET_PREVIOUS` to the **old** value and `TABULA_AI_SECRET` to the **new** one, then restart the relay. It refuses to start if either is malformed, or if the previous one is set without the current one.
3. Keys written under the old secret keep working. Each is sealed again under the new secret the next time it is used for a run, so a key nobody uses stays under the old secret.
4. Once every key has been used (or entered again), remove `TABULA_AI_SECRET_PREVIOUS` and restart. Admin, AI shows a workspace key the current secrets cannot open as unreadable; a person whose key cannot be opened gets `ai_key_unreadable` on a run and enters it again.

Changing the secret without keeping the old one as `TABULA_AI_SECRET_PREVIOUS` makes every stored key unreadable. Nothing is lost that the provider's console cannot reissue: enter the keys again. Removing the secret altogether turns saving keys off (`ai_unconfigured`); the stored rows stay in the directory and open again when the secret comes back.

## Running a feature

1. **Checks**, in order: signed in (accounts mode); AI enabled for the workspace and the feature; the person can **write** the board room (`canWriteRoom(role, 'board')`, the function the relay and MCP share), since every v1 feature proposes board edits; workspace not read-only; a key resolves (or, phase 2, credits remain); rate limits.
2. **Read the board** with the MCP read path (`ctx.readBoard`): objects, frames, connectors and votes. **Private notes are withheld while unrevealed**, as in `get_board`: the relay cannot tell whose they are, so it sends none. Comments are not sent in v1. Selection: the feature runs on the selected objects when there are any (the app sends their ids), on a frame when one is chosen, else on the whole board, capped (see "Limits").
3. **Fence and clean** the content exactly as `docs/mcp.md` "Untrusted content" describes: the fixed preamble, nonce markers, JSON escaping, invisible characters stripped. The person's own prompt sits outside the fence, labelled as the request.
4. **Call the provider** and stream progress to the app as server-sent events (`event: progress`, then one `event: result` or `event: error`). Closing the request aborts the call.
5. **Validate the proposal** against the feature's schema and the board as it is now (ids that exist, counts within limits, no private notes touched). An invalid proposal is an error, never a partial edit.
6. **Record** one audit row `ai.<feature>` with `{ boardId, model, keySource, counts, tokens }` and no board text, no prompt, no output; and, in phase 2, one usage row.

### Why proposals, not MCP writes

MCP writes with origin `mcp:<token>`, which no one's undo manager tracks, so an AI edit made that way cannot be undone with Ctrl+Z. Here a person asked from inside the app and is watching. Returning a proposal that the app applies with `store.transact` gives the AI's edit the same undo, the same read-only rules and the same live sync as a hand edit, and it puts a person between the model and the board. That matters, because board text can try to steer the model. MCP stays the path for external AI clients.

### Proposals

```
Proposal =
  | { kind: 'create', objects: NewSticky[], frame?: { title: string } }           // generate, summarise
  | { kind: 'group', groups: { title: string, ids: Id[] }[] }                      // cluster
NewSticky = { text: 1..2000 chars, color?: one of the sticky colours }
```

The app lays objects out itself, at `nextFree` (the MCP rule), in a new frame when the proposal names one. A `group` proposal moves the listed stickies into columns under their titles. Positions are never taken from the model.

The preview draws the proposal faded over the board with **Add to board** and **Discard**. Add is one undo entry. Discarding writes nothing.

## v1 features

| Feature | Input | Proposal | Default effort |
| --- | --- | --- | --- |
| **Generate stickies** | A prompt ("ten risks of moving to the cloud"), optional count 1..30 | `create`: stickies, optionally in a titled frame | `low` |
| **Summarise** | The board, a frame or the selection; type `summary` or `retro` | `create`: a summary sticky, then one sticky per action item (owner and due date in the text when the notes name them) in a frame "Summary" | `medium` |
| **Cluster** | The selected stickies (2..200) | `group`: 2..12 titled groups covering every selected sticky | `medium` |

Entry points: a **Generate** button in the sticky tray and on the empty-board hint; **Summarise** in the board menu and the session bar after Finish (a retro summary next to the dot-vote results); **Cluster** in the quick-action bar for two or more stickies. All are hidden when AI is off and disabled for viewers and commenters.

Next, not v1: text to diagram (needs the Mermaid parser and layout moved out of `src/` into shared JavaScript first, as `docs/mcp.md` notes), smart template fill, a free-form board assistant with tools.

## Limits

- Board content sent per run: at most 400 objects and 60,000 characters of text, nearest the selection or frame first; the result says when content was cut.
- Output: `max_tokens` 8,000 (cluster and summarise), 4,000 (generate).
- One run per person at a time; up to three at once on a shared key (the workspace key, the operator's key in open mode) and one on each personal key (`SHARED_KEY_RUNS` in `server/ai/run.mjs`); 20 runs per person per hour and 200 per workspace per hour by default, adjustable by the admin. 429 `rate_limited` with `retry-after`. The counts live in memory and start again from zero when the relay restarts.
- Saving a key makes an outbound call, so a person gets 10 saves an hour (personal and workspace key together) and one check at a time.
- A run is aborted after 120 seconds, and when the person closes the request.

## Privacy and admin controls

- **Off until an admin turns it on**, per workspace, with a notice that board content is sent to the chosen provider and processed under that provider's API terms. In open mode it is on only when `TABULA_AI_API_KEY` is set **and** `TABULA_AI_OPEN=1`: a key alone never turns it on.
- Admin settings (a new **AI** tab in the admin dashboard): on or off; which features; the model; whether people may use personal keys; the workspace key; the rate limits; and in phase 2 the credit balance and usage.
- **What leaves the instance:** only the content of the run (the board or part of it, minus private notes, plus the prompt). No emails, member names (sticky authors are not sent), comments or other boards.
- **What is kept:** the audit row and the usage row (counts and tokens). Prompts and outputs are not stored on the server. The applied stickies are ordinary board content.
- **Guests** can run features on boards they can edit, like any editor, unless the admin restricts AI to members.
- Admin audit log: a filter **AI** (prefix `ai.`).

## Phase 2: AI as a service

### Credits

- **1 credit = €0.01 of provider cost at list price**, computed from each run's usage and a price table per model (input, output, cache read and cache write tokens). Providers price in US dollars; the table carries a fixed conversion rate, reviewed with the prices. Credits are the unit people see; the price table changes without changing plans.
- **Pooled per workspace**, refreshed monthly: an allowance per paid seat, so a team shares one balance and a heavy user does not hit a personal wall.
- **Top-up packs**, prepaid, that do not expire for 12 months and are spent after the monthly allowance. No metered overage: bills stay predictable, and a runaway loop cannot create one.
- At zero, runs are refused with `402 ai_credits_exhausted` and the admin sees "Buy credits"; a personal or workspace key, if set, keeps working (BYOK runs never use credits).
- Admins can set a monthly cap below the allowance and see usage by feature and by person in the AI tab.

### Who holds the platform key, and who meters

The hosted relay never holds the platform's provider key. In cloud mode (`docs/cloud.md`) a credit-funded run goes through the control plane:

```
POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/ai/run   (bearer TABULA_CLOUD_TOKEN, streaming)
```

The control plane checks the balance, calls the provider with its key, meters the usage, debits the balance and streams the result back. The instance does everything before and after the call: reading the board, fencing, validation, the proposal. Metering in the control plane means an instance cannot under-report, and the platform key never sits on a customer's instance. `GET /api/me` gains `workspace.ai: { allowance, balance, resetsAt }` alongside the seat fields.

### Stripe

The control plane already owns Stripe for seats. It adds an AI allowance to each plan, top-up packs as one-off Checkout payments, and balance changes from Stripe webhooks. **Manage billing** opens the same customer portal, which shows the packs. Nothing about Stripe runs on the instance.

## Tests

- Provider: request shape per feature (model, effort, structured output schema, cache control, fallbacks on Claude Opus 5.5 and Claude Sonnet 5.5), refusal handling, error mapping, abort; a fake Anthropic client, no network.
- Keys: encrypt and decrypt, wrong scope or user in the associated data fails, rotation with the previous secret, refused without `TABULA_AI_SECRET`, verification on save, and no key in any response, log line or audit row (a canary key searched for everywhere).
- Run: the check order (signed out, AI off, feature off, guests when restricted, viewer, commenter, read-only workspace, no key, unreadable key, rate limits per person, per workspace and per key, key-save throttle), private notes never sent, fencing applied, content caps, invalid proposals refused, abort on close and on timeout, open mode on and off, one audit row without text (`test/ai-run.test.ts`, `test/ai-features.test.ts`, `test/ai-open-run.test.ts`, and the relay as a process in `test/ai-relay.test.ts`).
- App: proposal preview, Add as one undo entry, Discard writes nothing, read-only roles see no entry points.
- Phase 2: credit arithmetic from usage, allowance and packs, refusal at zero, BYOK unaffected by the balance; the control plane call with a fake gateway.

## Slice A: what is built

This is the first slice of phase 1 (TAB-97). The text above is the design; these are the points where the code adds to it or chose between options.

**Environment.** `TABULA_AI_API_KEY`, `TABULA_AI_OPEN` (open mode), `TABULA_AI_SECRET`, `TABULA_AI_SECRET_PREVIOUS`, `TABULA_AI_PROVIDER` (only `anthropic`) and `TABULA_AI_MODEL` (default `claude-opus-5-5`); the old `MIRA_` spellings still work. In accounts mode `TABULA_AI_API_KEY` and `TABULA_AI_OPEN` are ignored with a warning, because the workspace key lives in the directory. The config keeps the secrets out of anything that prints or serialises it.

> **Open mode and cost.** With `TABULA_AI_API_KEY` and `TABULA_AI_OPEN=1`, anyone who has a board link can run the AI features and spend the operator's key, because open mode has no accounts. Use it for a private instance or behind something that decides who may reach it, and set a spending limit in the provider's console.

**Keys.** The key version is one byte, the first byte of an HMAC of the secret, so nobody numbers secrets. It is stored in `key_version` and is also the first byte of the `ciphertext` blob. The AES-256-GCM key is derived from the secret with HKDF, the nonce is 96 random bits per row, and the associated data is the version, the scope and the user. A unique index per scope (and per user) allows one workspace row and one row per person, and a check ties `scope` to `user_id`. A custom `baseUrl` is refused in v1 (`400`); the provider layer only accepts an `https://` one, for the later OpenAI-compatible adapter.

**Settings** are rows of the `settings` table: `ai.enabled`, `ai.features`, `ai.model`, `ai.personalKeys`, `ai.membersOnly` (default off: guests may use AI), `ai.limits.perPersonHour` (20, at most 1000) and `ai.limits.perWorkspaceHour` (200, at most 10000). The limits are stored and edited here; `run.mjs` enforces them (slice B).

**Endpoints** beyond the list above:

- `GET /api/ai/config` also returns `personalKeys` (whether this person may add a key), `hasSecret` (whether the server can store keys) and `myKey` (`{ provider, hint, createdAt, lastUsedAt }` or null). `enabled` and `personalKeys` are false for a guest when `membersOnly` is on. In open mode `keySource` is `workspace` for the operator's key.
- `GET /api/admin/ai` returns the settings, `hasSecret` and the workspace key as `{ provider, hint, createdAt, lastUsedAt, readable }`; `PUT /api/admin/ai` answers the same. `readable` is false for a key the current secrets cannot open.
- `GET /api/me` carries `ai: { personalKeys: true }` only when this person may add a key, so the account menu can offer **Your AI key** without another request.
- A key is verified with the provider (a `models.list` call with a 5 second timeout) before anything is stored. In `PUT /api/admin/ai` the settings and the key are one change: if the key is refused, the settings in that request are not applied either. The caller is checked again after the provider answers.
- Errors: `ai_key_invalid` 400, `ai_rate_limited` 429 with `retry-after`, `ai_unavailable` 502, `ai_unconfigured` 409 (no secret on the server), `ai_key_unreadable` 409 (a stored key the secrets cannot open), anything else `internal` 500. Their messages are fixed text.
- `DELETE /api/ai/keys/me` and `DELETE /api/admin/ai/key` answer 204 whether or not there was a key, and work while the workspace is read-only. A person can remove their key even after personal keys were switched off.
- Audit rows: `ai.settings` (the changed settings only), `ai.key.set` and `ai.key.delete` (`{ scope, provider }` and `{ scope }`; never a key or its hint). The audit log has an AI filter.

**Logging.** A raw provider error can carry the request headers, so every provider error is mapped to an `AiError` with a fixed message before it leaves `server/ai/anthropic.mjs`. The API's and the relay's error logs write an AI or provider error as its name, code and status only, and any other error as its stack with anything shaped like a key blanked.

**Provider.** `messages.stream(...)` and `finalMessage()`; the system prompt first with `cache_control`; `output_config` with the JSON schema and the effort; `stop_reason: "refusal"` checked first. Server-side fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are set for Claude Opus 5.5 and Claude Sonnet 5.5 only, in one function (`openStream` in `server/ai/anthropic.mjs`), because the field exists only on the SDK's beta client. Claude Haiku 5.5 has no fallback and uses the plain client. The SDK is pinned at exactly 0.128.0 and loaded on first use.

## Slice B: what is built

The second slice of phase 1 (TAB-97): `POST /api/ai/run` and the three features, on the server only. Nothing in the board UI calls it yet (slice C). The text above is the design; these are the points where the code adds to it or chose between options.

**Request.**

```
POST /api/ai/run    JSON, with the CSRF header like every write
{ "feature": "generate" | "summarise" | "cluster", "boardId": "<board id>", "input": { ... } }
```

| Feature | `input` |
| --- | --- |
| `generate` | `prompt` (required, up to 2,000 characters), `count` (1 to 30), and `selection` or `frameId` |
| `summarise` | `type` (`summary`, the default, or `retro`), `prompt` (optional: what to focus on), and `selection` or `frameId` |
| `cluster` | `selection` (required, 2 to 200 ids) |

Unknown fields are refused. `selection` (1 to 400 object ids, no repeats) and `frameId` (the direct children of that frame) are exclusive; with neither, the run works on the whole board. A prompt with a control or tag character is refused; zero-width and bidirectional characters are removed.

**Answers before the stream** are plain HTTP errors with a JSON body `{ error, message }`, in the order of the checks: `403 csrf`, `401 unauthenticated`, `400 bad_request` (the body), `403 ai_disabled` (AI is off, or restricted to members and the caller is a guest), `403 ai_feature_disabled`, `404 not_found` (no such board, a deleted one, or none the person can open), `403 forbidden` (cannot edit the board: viewers and commenters), `402 read_only` (a hosted workspace that is read-only; a viewer is told `forbidden` first), `409 ai_no_key`, `409 ai_key_unreadable`, `429 rate_limited` with `retry-after` (an hourly limit, a run already going for this person, or the key busy with another run). Then, with the board read, `400 bad_request` for a frame that is not on the board, a summary of nothing, or a cluster with fewer than two stickies the AI may read. A request that fails there does not use up the person's hour. `ai_no_key` is also what a person gets where phase 2 would offer credits. Where the stored key is the one of the person (personal keys allowed), it wins and there is no fallback to the workspace key if it cannot be read.

**The stream** is `text/event-stream`:

```
event: progress          data: {"n":0,"runId":"..."}   (first at once, naming the live run; then {"n":1}, ...)
event: result            data: {"runId":"...","proposal":{...},"cut":false,"usage":{"model","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"}}
event: error             data: {"error":"ai_refused","message":"..."}
```

Exactly one `result` or one `error` ends it. After the stream has started every failure is an `error` event: `ai_refused` (the provider declined; nothing changed), `ai_invalid_proposal`, `ai_timeout`, `ai_key_invalid`, `ai_rate_limited`, `ai_unavailable`, `forbidden` (the person lost the right to edit while the model worked), `internal`. The messages are fixed text. `ai_aborted` is what an audit row says when the person closed the request.

**Proposals** (`proposal.kind` is set by the server). `create`: `objects` is 1 to 30 stickies (at most `count` for generate) of `{ text, color? }`, `text` 1 to 2,000 characters and `color` the **name** of a sticky colour (Yellow, Orange, Pink, Violet, Blue, Teal, Green, Grey; any case is accepted and written back in the palette's spelling); `frame` is `{ title }` of 1 to 100 characters, required for summarise. `group`: 2 to 12 groups of `{ title, ids }`, no group empty, every id a sticky that is in the selection and exists and is readable now, each exactly once, together all of the stickies that were sent. Everything the model returns is plain text: control, tag, zero-width and bidirectional characters are removed, titles lose line breaks, a tag or an `&amp;` stays exactly the characters it is (the app has to draw it as text, never as markup), unknown keys are refused, and anything over a limit is an error, not a cut. An answer that fails any check is an `ai_invalid_proposal` error and carries no part of the proposal. The server log gets a fixed word for why (`unknown_id`, `duplicate_id`, ...), never anything the model wrote. The validator also checks the role: a role that cannot create stickies and frames (or move stickies, for a group) gets no proposal.

**Reading the board** uses the MCP reader (`readAll` and the same summaries as `get_board`), so private notes are withheld while unrevealed and a connector attached to one is left out; no author, no comment and no name is read. The scope is the selection (ids that are missing or withheld are left out), the direct children of a frame, or the whole board, nearest the centre of the selection, the frame or the board first (ties by id). Boxes come first, then the connectors whose ends were all sent. At most 400 objects and 60,000 characters of text go, and one object's text is cut at 1,000 characters; the answer says `cut: true` when anything was left out or shortened. A cluster sends only the selected stickies, and when the selection was cut the grouping must cover the stickies that were sent. The result is fenced with `fence()` from `server/board-ops.mjs`, exactly as the MCP tools fence board text; the board title is inside the fence, and the person's prompt, with a label saying it is the request and not the board, comes after it. The system prompt is a constant per feature and never changes with the run, so it caches.

**Limits** live in the process, not in the directory: a restart forgets every count and every run in flight. A run is admitted when the person has no run going, the key is under its cap (three for a shared key, one for a personal key), and the person and the workspace are under their hourly limits (the admin's `ai.limits.*`, 20 and 200 by default); a refused request counts for nothing. A run that never reached the provider (bad frame, nothing to summarise) takes its count back. Everything else counts, a provider error included. The hour is a sliding window. The per-key cap guards the key's provider rate limit and cost, and keeps one person from filling it: while a workspace key has three runs going, the next person is told to try again in a moment. The provider call gets an `AbortSignal` that fires after 120 seconds (`ai_timeout`) or when the person closes the request (`ai_aborted`), and the run is released either way. Key saves (`PUT /api/ai/keys/me`, and `PUT /api/admin/ai` with an `apiKey`) are limited to 10 an hour per person and one check in flight, `429 rate_limited`; saving settings without a key is not limited.

**Audit.** One row `ai.generate`, `ai.summarise` or `ai.cluster` for each run that reached the provider, written before the last event: `{ boardId, model, keySource: 'user' | 'workspace', outcome: 'ok' | <error code>, counts: { scope, inScope, sent, chars, cut, proposed }, tokens: { input, output, cacheRead, cacheWrite } }`. No board text, no prompt, no output, no key. The audit log shows them as sentences ("Ana summarised “Roadmap”") under the AI filter.

**Open mode** has `POST /api/ai/run` too (and still no other AI endpoint besides `GET /api/ai/config`). It needs the CSRF header, answers `403 ai_disabled` unless `TABULA_AI_API_KEY` and `TABULA_AI_OPEN=1` are both set, uses that key and `TABULA_AI_MODEL`, counts runs per client address (the last `X-Forwarded-For` entry with `TABULA_TRUST_PROXY=1`, else the socket address; a run per address at a time, 20 an hour) and keeps one count for the whole instance (200 an hour), with up to three runs at once on the operator's key. There is no directory, so the audit row is a log line `ai.<feature> {json}` with the same fields.

**Code.** `server/ai/features.mjs` (prompts, schemas, input and proposal checks), `server/ai/board.mjs` (the read), `server/ai/limits.mjs` (the counters), `server/ai/run.mjs` (the run core, the accounts route and the open-mode handler). `board-ops.mjs` exports `readAll`, `summarise` and `stripInvisible` for them; `api.mjs` lets a route stream (`stream: true`), and the relay hands `canWriteRoom` and a room reader to the API and to the open-mode handler.

## Live runs

Everyone on a board sees its AI runs (TAB-141): while a run is going ("Ana is asking AI…"), and its proposal, as a faded preview with the runner's name, until someone adds or discards it. A run's proposal is never in the board document until then.

**State.** `server/ai/live.mjs` keeps the runs in memory, per board: `{ id, feature, by: { id, name }, status, startedAt, readyAt, proposal, cut, error, resolvedBy }`. The run route starts one when the provider is about to be called (a request refused before that leaves no run), marks it `ready` with the validated proposal or `failed` with the error code, and the first `progress` event and the `result` carry its `runId`. A ready run nobody settles `expired`s after 10 minutes, one still `running` after 5 minutes is `failed`, a board holds at most 12 open runs (the oldest ready one expires to make room), and a settled run is remembered for 10 minutes so a late click is told so. When a board's room unloads its runs are dropped; a restart forgets them all. In open mode `by` is `{ id: null, name: null }`: nobody has a name there and a client address is never shown.

**The relay** sends message type 6 (`MSG_AI_RUNS`, relay to client only, board rooms only) with JSON `{ kind: 'snapshot', runs }` to a socket that joins while runs are open, then `{ kind: 'patch', run }` for each change. Every socket gets its own copy, built for its person by `viewFor`, so a rule that hides something is applied on the server and never left to the app. `accepted`, `discarded`, `failed` and `expired` mean the run is gone; they carry only `id`, `feature`, `status`, `by`, the `error` code of a failed run and `resolvedBy`.

**Settling.** `POST /api/ai/runs/:id/resolve` with `{ action: 'accept' | 'discard' }` (CSRF header, as every write). The first one wins: `200 { id, action, feature }`, and an accept adds `proposal` and `cut`, which the app of the person who clicked writes with `store.transact`, as one undo step on their own stack, laid out at `nextFree`. Then `409 ai_run_resolved` for everyone after, also for a failed or expired run, `409 ai_run_running` while it is still going, `404 not_found` for a run that is gone or on a board the person cannot open, `403 forbidden` when the policy says no, and `402 read_only` in a read-only hosted workspace. The server writes an audit row `ai.run.accept` or `ai.run.discard` with `{ boardId, feature }`. Open mode has the same route.

**Policy**, in `server/ai/policy.mjs` and repeated in `src/ai-policy.ts` for the app's buttons (a test keeps the two equal). Johan has still to confirm these (TAB-141), so each is one constant:

| Rule | Now | Other choices |
| --- | --- | --- |
| Who sees runs (`canSeeRun`) | everyone who can open the board, viewers and commenters too | |
| Who may add or discard (`RESOLVE_POLICY`) | `'editors'`: anyone who can edit the board | `'runner-first'`: the runner, then any editor 30 s (`RUNNER_FIRST_MS`) after the run is ready |
| Who sees the prompt (`PROMPT_VISIBILITY`) | `'runner'`: nobody is sent it, since the runner's app has it already | `'everyone'`, `'none'` |

## Not in this slice

The board entry points and the proposal preview (slice C), text to diagram, smart template fill, a chat assistant with tools, OpenAI-compatible providers, image input, AI on comments, local-only (per-device) keys, per-person credit allowances, metered overage.

## Recommended answers to TAB-99

1. **First features: generate stickies, summarise (with action items), cluster stickies.** They cover the start, middle and end of a session, each is one model call with a structured answer and no tools, and their results are ordinary stickies the person can undo. Action items ship inside summarise. Text to diagram waits for the Mermaid move. Smart template fill waits until templates have fields to fill.
2. **Anthropic only at first**, behind a provider interface that takes an OpenAI-compatible adapter next. Shipping one provider well (structured output, refusals, caching, error messages) beats two half-tested ones; the second mostly helps self-hosters with local models and can follow without schema or UI changes.
3. **Both, workspace first.** The admin sets the workspace key, which controls spend and where data goes, and decides whether people may add personal keys (off by default). A personal key wins over the workspace key when allowed. Open mode uses the operator's environment key only.
4. **Credits pooled per workspace, top-up packs, no metered overage.** Suggested starting point at €8 per seat per month: 100 credits (about €1 of provider cost) per paid seat per month, the same monthly amount on yearly plans. At the defaults above on Claude Opus 5.5 ($4 / $20 per million input / output tokens) a board summary (about 15,000 tokens in, 3,000 out, thinking included) costs about 11 credits and a sticky generation about 2 to 3, so that is roughly 9 summaries or 40 generations per seat per month, pooled. Fully used, it is about 12% of seat revenue; Claude Sonnet 5.5 halves the cost per run if that proves too tight. Packs: 1,000 credits for €15 and 5,000 for €60. The backups add-on is unrelated; AI does not need its own add-on while it rides on seats. These numbers should be checked against real usage from the BYOK phase before phase 2 launches.
