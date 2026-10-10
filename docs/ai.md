# AI features

AI that works on the board the person has open: write stickies from a prompt, summarise a board or a retro into notes and action items, group stickies into themes. Phase 1 runs on an API key the workspace or the person brings (**bring your own key**, BYOK). Phase 2 adds AI as part of the hosted service: each plan includes credits, and more can be bought.

Status: **slices A, B and C of phase 1 are built (TAB-97):** the provider layer, encrypted keys, settings and key endpoints with their admin and account screens; `POST /api/ai/run` with the three features, limits and audit rows; and the AI bar, its entry points and live previews. The bar appears when AI is enabled for the person and a workspace key, an allowed personal key or the hosted `credits` capability are available. A hosted control plane can enable that capability with the `aiCredits` limit; it remains false in open mode and on self-hosted instances. In accounts mode, runs with no saved key can use the hosted credits proxy. Credit metering and limits are enforced by that proxy. "Slice A: what is built" and "Slice B: what is built" below list where the code differs from or adds to the text above. Recommended answers to the open questions in TAB-99 are at the end.

## Summary

- **Calls run on the relay, never in the browser**, in both modes. The browser sends "summarise this board"; the relay reads the board, calls the provider with the stored key and streams back a **proposal** (stickies to add, notes to move). The key never reaches a browser after it is saved.
- **The person applies the proposal.** The app shows it as a preview and writes it as an ordinary local edit, so it is undoable with Ctrl+Z, follows the person's role, and nothing changes the board until a person says so.
- **One provider layer** with Anthropic as the only provider in v1 (Claude Opus 5.5 by default, Claude Sonnet 5.5 and Claude Haiku 5.5 selectable), shaped so OpenAI-compatible providers fit later.
- **Keys are encrypted at rest** with a server secret, are never returned by any API, never written to a board document, never logged.
- **Reuses the MCP layer from TAB-12** for reading boards: the same private-note withholding, the same fencing of untrusted board text, the same object validators. Writes do not go through MCP (see "Why proposals").
- **v1 features:** generate stickies, summarise with action items, cluster stickies.
- **Phase 2:** credits per workspace, pooled across seats; prepaid top-up packs; the control plane meters and bills through Stripe, as it already does for seats.

The board shows AI controls only when AI is enabled for the person and the config reports a usable workspace key, an allowed personal key, or `credits: true`. On hosted instances, the control plane sets that capability through `aiCredits`; open mode and self-hosted instances always report `false`. The run route uses hosted credits only when there is no saved key and both proxy environment values are configured.

### Hosted AI credits proxy

In accounts mode, key resolution is strict: an allowed personal key wins first, then the workspace key, then hosted credits when `limits.aiCredits === true` and both `TABULA_AI_PROXY_URL` and `TABULA_AI_PROXY_TOKEN` are set. A saved key avoids credit metering; an unreadable saved key returns `ai_key_unreadable` and does not fall back. With no key and no usable credits proxy, the run returns `409 ai_no_key`.

The instance sends a keyless run to the configured Anthropic Messages proxy using the proxy token as `x-api-key`. The token is held only in server configuration and never returned by an API, written to an audit row, or included in logs. The URL must use HTTPS; HTTP is accepted only for loopback test servers. Private runs cannot use credits because the workspace pays for them. See [AI credits](ai-credits.md) for the proxy contract, environment values and error codes.

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
providers.mjs   createProvider({ kind, apiKey, baseUrl?, model?, trusted? }) -> Provider
anthropic.mjs   kind 'anthropic', using @anthropic-ai/sdk
openai-compatible.mjs  kind 'openai-compatible' (TAB-222): Chat Completions over node:https, no SDK
net-guard.mjs   the address guard of its transport: public addresses only, pinned after the check
base-url.mjs    the base URL and model id rules, for the key screens and the operator's environment
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

### OpenAI-compatible providers

TAB-222. The kind `openai-compatible` speaks the Chat Completions API of OpenAI and of everything that copies it: NVIDIA's catalogue (`https://integrate.api.nvidia.com/v1`), OpenAI, OpenRouter and a local server such as Ollama or vLLM. It has no SDK (`server/ai/openai-compatible.mjs`, Node's `https`), and a key of this kind carries three things: the key, a **base URL** and a **model id**. Unlike Anthropic's, they are free text, so a person types them on the key screen.

- **Request.** A non-streaming `POST <base>/chat/completions` with `Authorization: Bearer <key>`, `temperature: 0` and `max_tokens`. The system message is the feature's frozen prompt plus the JSON Schema of the answer in text, and the request sets `response_format: { type: 'json_object' }`, which almost every server accepts. Only that origin is ever called.
- **Output.** The provider returns one parsed JSON object, and the existing feature validators (`features.mjs`) decide whether it is a proposal, exactly as for Anthropic. One fenced code block around the JSON is tolerated. At most two requests are made per run:
  - an HTTP 400 or 422 on the first retries once without `response_format` (some servers refuse it), and the body is never read to decide that;
  - an answer that is not a JSON object (prose, `null` or empty content, a reasoning model that put the text elsewhere, a cut-off reply) is retried once with a short "reply again with only the JSON object" message;
  - after that the run ends with `ai_bad_output`: "This model did not answer in the required JSON format. Try a stronger instruction-following model." Nothing is changed, and nothing the model said is shown.
- **Refusals.** `finish_reason: content_filter` or a `refusal` field is a refusal, as for Anthropic.
- **Usage.** `prompt_tokens` and `completion_tokens`, summed over both attempts. There is no price: the model chip's popover says Tabula does not know it and the provider bills the key. The token estimate stays.
- **Errors**, from the status of the response only:

| Provider answer | Code |
| --- | --- |
| 401, 403 | `ai_key_invalid` |
| 404 (also 400 or 422 on the key check) | `ai_model_invalid`: "The provider does not know this model or this address." |
| 429 | `ai_rate_limited` (with `retry-after`) |
| a timeout (30 s a request, 8 s for `/models`) | `ai_timeout`: a slow model is not an unavailable provider |
| 5xx, 3xx, 408, other 4xx, a connection error, a body over 4 MB | `ai_unavailable` |
| 200 with no choices, or an answer that never becomes JSON | `ai_bad_output` |

- **Checking a key** (on save, and Test key) does two things. `GET <base>/models` says whether the key is accepted (a server without it answers 404, 405 or 501, and that is fine). Then one **1-token completion with the configured model**, because a catalogue lists models that do not answer: NVIDIA's `/models` lists models whose completions are 404. A model that does not exist is `ai_model_invalid`; one that takes longer than 30 s to say one token is `ai_timeout`.
- **Models.** There is no list to pick from. What works is a model that follows instructions well enough to return JSON from a long prompt: `moonshotai/kimi-k3` on NVIDIA's catalogue did in tests, small or "reasoning-only" models often return empty content, and some models time out. The error says which.

**Where the address comes from, and what is trusted.** The address of a key a person typed (admin or personal) is hostile input, because the server calls it:

- `https` only, at most 200 characters, no user name or password, no query or fragment, a path of `/v1` type.
- The transport (`server/ai/net-guard.mjs`) resolves the host itself and refuses a host that has any address outside global unicast: loopback, private, link-local (the cloud metadata address), CGNAT, multicast, IPv6 unique-local, IPv4-mapped and NAT64 forms of those, 6to4 and Teredo, and the names `localhost`, `*.localhost`, `*.local`, `*.internal`. An IP literal is checked before any connection. The connection is made to the address that was checked (the lookup hands the socket only checked addresses), so a DNS answer that changes between the check and the connect changes nothing.
- No redirect is ever followed (a 3xx is `ai_unavailable`), the response is capped at 4 MB, and every request has a timeout. The key is sent only to the configured origin, in the `Authorization` header, and a response body is never copied into an error, a log line, an audit row or the status of anything.
- The same checks run when the key is saved, at Test key and at every run, so a stored address cannot be redirected to another host without entering the key again.

The operator's environment is trusted: `TABULA_AI_PROVIDER=openai-compatible` with `TABULA_AI_BASE_URL` (an `http://` or local address is allowed there, for a model server on the same machine) and `TABULA_AI_MODEL` (any model id) in open mode. In accounts mode those variables are ignored with a warning: each key carries its own.

**Storage.** `ai_keys` has a nullable `model` column next to `base_url` (a migration of its own; an Anthropic key leaves both empty and uses the workspace's `ai.model`). A key replaces the address and the model with it. Audit rows (`ai.key.set`, `ai.key.test`) carry the provider, and for this kind the host and the model id, never the key or the whole address.

**Key screens.** Both "Your AI key" and the admin AI tab have a provider choice. For OpenAI-compatible they add **Base URL** and **Model** and check the same rules as the server before **Save key** enables. When the admin AI response says `creditsActive: true` and no workspace key is saved, the workspace key form says "AI credits are used until you add a key." The note is hidden when a workspace key exists. The admin Anthropic model setting is hidden while the workspace key is OpenAI-compatible: the model shown is the key's. On the wire, the model of a personal key is `model`; the admin body already has `model` (the Anthropic setting), so there the key's model is `keyModel`.


## Keys (BYOK)

### Who owns a key

| Mode | Key | Set by |
| --- | --- | --- |
| Open mode | `TABULA_AI_API_KEY` (and `TABULA_AI_PROVIDER`, default `anthropic`; `openai-compatible` also needs `TABULA_AI_BASE_URL` and `TABULA_AI_MODEL`) | The operator, in the environment |
| Accounts mode | **Workspace key** | A workspace owner or admin, in the admin dashboard |
| Accounts mode | **Personal key** | Each person, in their account menu, only when an admin allows personal keys |

Resolution for a run in accounts mode: the person's own key if they set one and personal keys are allowed, else the workspace key, else the hosted credits proxy when `aiCredits` is enabled and its environment values are set, else AI is unavailable. The app shows which source a run will use ("Uses the workspace key", "Uses your key", or "Uses AI credits" when `credits: true` and no key source applies).

### Storage

- Table `ai_keys(id, scope 'workspace'|'user', user_id NULL, provider, base_url NULL, model NULL, ciphertext, nonce, key_version, hint, created_at, created_by, last_used_at)` in the directory (a migration after the one TAB-67 adds). One row per scope (and per user).
- **Encrypted with AES-256-GCM** under a key-encryption key from `TABULA_AI_SECRET` (32 bytes, base64; the relay refuses to start with a malformed one). Each row has a random 96-bit nonce, and the associated data binds the row's scope and user, so a ciphertext copied to another row does not decrypt. Without `TABULA_AI_SECRET`, saving a key is refused (`ai_unconfigured`) and the admin UI says why.
- `hint` is the last four characters, the only part ever shown again.
- **Never returned.** `GET` endpoints return `{ provider, baseUrl, model, hint, createdAt, lastUsedAt }`. There is no endpoint that reveals a key, to anyone.
- **Never synced, never logged.** Keys are not in any Yjs document, `.drift` file or export. The request and error loggers redact `authorization`, `x-api-key` and the `apiKey` body field; a test asserts that a known key never appears in logs, audit rows or responses.
- **Verified on save** with a cheap call (`models.list()` for Anthropic; for an OpenAI-compatible provider `/models` and a 1-token completion with the model). A key that fails is not stored (`ai_key_invalid`, `ai_model_invalid`, `ai_timeout`).
- **Rotation.** `TABULA_AI_SECRET_PREVIOUS` decrypts rows written under the old secret, which are re-encrypted on next use; `key_version` says which secret wrote a row. The steps are in "Rotating TABULA_AI_SECRET" below.
- Deleting a person removes their key (foreign key cascade). Deleting the workspace key is immediate; runs in flight finish.

### Endpoints

```
GET    /api/ai/config                -> { enabled, features: [...], keySource: 'user'|'workspace'|null, provider, model, personalKeys, credits: boolean }   (`model` is the key's own for an OpenAI-compatible key; `credits` reflects the hosted workspace's `aiCredits` limit and is false in open mode and self-hosted instances; when `keySource` is null and `credits` is true, the bar says "Uses AI credits")
PUT    /api/ai/keys/me   { provider, apiKey, baseUrl?, model? }   -> { provider, hint, baseUrl, model }      (when personal keys are allowed; baseUrl and model only for openai-compatible, and then both)
POST   /api/ai/keys/me/test                              -> { ok: true, provider, checkedAt } (when personal keys are allowed)
DELETE /api/ai/keys/me                                    -> 204
GET    /api/admin/ai                -> settings, `creditsActive`, and the workspace key hint (`creditsActive` is true when hosted credits will be used without a workspace key)
PUT    /api/admin/ai     { enabled?, features?, model?, personalKeys?, apiKey?, provider?, baseUrl?, keyModel? }   (owner or admin; `model` is the Anthropic model, `keyModel` the key's own) -> settings, key hint
POST   /api/admin/ai/key/test                             -> { ok: true, provider, checkedAt } (owner or admin)
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

1. **Checks**, in order: signed in (accounts mode); AI enabled for this person and the feature; the person can **write** the board room (`canWriteRoom(role, 'board')`, the function the relay and MCP share), since every v1 feature proposes board edits; workspace not read-only; an allowed personal key, workspace key or eligible credits proxy resolves; rate limits.
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

Entry points: a **Generate** button in the sticky tray and on the empty-board hint; **Summarise** in the board menu and the session bar after Finish (a retro summary next to the dot-vote results); **Cluster** in the quick-action bar for two or more stickies. They appear when AI is enabled for the person and a workspace key, an allowed personal key or the hosted `credits` capability is available, and are disabled for viewers and commenters. When credits are active and there is no saved key, the run uses the AI credits proxy. Setup is in Admin → AI.

Next, not v1: text to diagram (needs the Mermaid parser and layout moved out of `src/` into shared JavaScript first, as `docs/mcp.md` notes), smart template fill, a free-form board assistant with tools.

## Limits

- Board content sent per run: at most 400 objects and 60,000 characters of text, nearest the selection or frame first; the result says when content was cut.
- Output: `max_tokens` 8,000 (cluster and summarise), 4,000 (generate).
- One run per person at a time; up to three at once on a shared key (the workspace key, the operator's key in open mode) and one on each personal key (`SHARED_KEY_RUNS` in `server/ai/run.mjs`); 20 runs per person per hour and 200 per workspace per hour by default, adjustable by the admin. 429 `rate_limited` with `retry-after`. The counts live in memory and start again from zero when the relay restarts.
- Saving or testing a key makes an outbound call, so a person gets 10 checks an hour (personal and workspace key together) and one check at a time.
- A run is aborted after 120 seconds, and when the person closes the request.

## Privacy and admin controls

- **Off until an admin turns it on**, per workspace, with a notice that board content is sent to the chosen provider and processed under that provider's API terms. In open mode it is on only when `TABULA_AI_API_KEY` is set **and** `TABULA_AI_OPEN=1`: a key alone never turns it on.
- Admin settings (a new **AI** tab in the admin dashboard): on or off; which features; the model; whether people may use personal keys; the workspace key; the rate limits; and in phase 2 the credit balance and usage.
- **What leaves the instance:** only the content of the run (the board or part of it, minus private notes, plus the prompt). No emails, member names (sticky authors are not sent), comments or other boards.
- **What is kept:** the audit row and the usage row (counts and tokens). Prompts and outputs are not stored on the server: a proposal is held in the relay's memory only while its preview lives (see "Live runs"), never on disk or in a log. The applied stickies are ordinary board content.
- **Guests** can run features on boards they can edit, like any editor, unless the admin restricts AI to members.
- Admin audit log: a filter **AI** (prefix `ai.`).

## Phase 2: AI as a service

### Credits

- **1 credit = €0.01 of provider cost at list price**, computed from each run's usage and a price table per model (input, output, cache read and cache write tokens). Providers price in US dollars; the table carries a fixed conversion rate, reviewed with the prices. Credits are the unit people see; the price table changes without changing plans.
- **Pooled per workspace**, refreshed monthly: an allowance per paid seat, so a team shares one balance and a heavy user does not hit a personal wall.
- **Top-up packs**, prepaid, that do not expire for 12 months and are spent after the monthly allowance. No metered overage: bills stay predictable, and a runaway loop cannot create one.
- At zero, the credits proxy refuses runs with `429 credits_exhausted` and a message naming the reset date; a personal or workspace key, if set, keeps working (BYOK runs never use credits).
- Admins can set a monthly cap below the allowance and see usage by feature and by person in the AI tab.

### Who holds the platform key, and who meters

The hosted relay never holds the platform's provider key. In cloud mode (`docs/cloud.md`) a credit-funded run goes through the hosted AI credits proxy:

```
POST {TABULA_AI_PROXY_URL}/v1/messages   (x-api-key TABULA_AI_PROXY_TOKEN, Anthropic Messages API)
```

The control plane proxy checks the balance, calls the provider with its key, meters usage, debits the balance and streams the result back. The instance does everything before and after the call: reading the board, fencing, validation and the proposal. The platform key never sits on a customer's instance. The instance URL and token are described in [AI credits](ai-credits.md).

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

**Environment.** `TABULA_AI_API_KEY`, `TABULA_AI_OPEN` (open mode), `TABULA_AI_SECRET`, `TABULA_AI_SECRET_PREVIOUS`, `TABULA_AI_PROVIDER` (`anthropic` or `openai-compatible`), `TABULA_AI_BASE_URL` (openai-compatible only) and `TABULA_AI_MODEL` (default `claude-opus-5-5`; any model id for openai-compatible); the old `MIRA_` spellings still work. In accounts mode `TABULA_AI_API_KEY` and `TABULA_AI_OPEN` are ignored with a warning, because the workspace key lives in the directory. The config keeps the secrets out of anything that prints or serialises it.

> **Open mode and cost.** With `TABULA_AI_API_KEY` and `TABULA_AI_OPEN=1`, anyone who has a board link can run the AI features and spend the operator's key, because open mode has no accounts. Use it for a private instance or behind something that decides who may reach it, and set a spending limit in the provider's console.

**Keys.** The key version is one byte, the first byte of an HMAC of the secret, so nobody numbers secrets. It is stored in `key_version` and is also the first byte of the `ciphertext` blob. The AES-256-GCM key is derived from the secret with HKDF, the nonce is 96 random bits per row, and the associated data is the version, the scope and the user. A unique index per scope (and per user) allows one workspace row and one row per person, and a check ties `scope` to `user_id`. A custom `baseUrl` is refused in v1 (`400`); the provider layer only accepts an `https://` one, for the later OpenAI-compatible adapter.

**Settings** are rows of the `settings` table: `ai.enabled`, `ai.features`, `ai.model`, `ai.personalKeys`, `ai.membersOnly` (default off: guests may use AI), `ai.limits.perPersonHour` (20, at most 1000) and `ai.limits.perWorkspaceHour` (200, at most 10000). The limits are stored and edited here; `run.mjs` enforces them (slice B).

**Endpoints** beyond the list above:

- `GET /api/ai/config` also returns `personalKeys` (whether this person may add a key), `hasSecret` (whether the server can store keys) and `myKey` (`{ provider, hint, createdAt, lastUsedAt }` or null). `enabled` and `personalKeys` are false for a guest when `membersOnly` is on. In open mode `keySource` is `workspace` for the operator's key.
- `GET /api/admin/ai` returns the settings, `hasSecret` and the workspace key as `{ provider, hint, createdAt, lastUsedAt, readable }`; `PUT /api/admin/ai` answers the same. `readable` is false for a key the current secrets cannot open.
- `GET /api/me` carries `ai: { personalKeys: true }` only when this person may add a key, so the account menu can offer **Your AI key** without another request.
- A key is verified with the provider (a `models.list` call with a 5 second timeout) before anything is stored. In `PUT /api/admin/ai` the settings and the key are one change: if the key is refused, the settings in that request are not applied either. The caller is checked again after the provider answers.
- `POST /api/admin/ai/key/test` checks the workspace key for an owner or admin; `POST /api/ai/keys/me/test` checks the caller's key when personal keys are allowed. Both use the same check limit as saving a key, and read the stored key without changing it, re-sealing it or updating `last_used_at`. They work in a read-only hosted workspace. A success returns `{ ok, provider, checkedAt }`; a failure leaves the key and settings alone.
- Errors: `ai_key_invalid` 400, `ai_rate_limited` 429 with `retry-after`, `ai_unavailable` 502, `ai_unconfigured` 409 (no secret on the server), `ai_key_unreadable` 409 (a stored key the secrets cannot open), anything else `internal` 500. Their messages are fixed text.
- `DELETE /api/ai/keys/me` and `DELETE /api/admin/ai/key` answer 204 whether or not there was a key, and work while the workspace is read-only. A person can remove their key even after personal keys were switched off.
- Audit rows: `ai.settings` (the changed settings only), `ai.key.set`, `ai.key.delete` and `ai.key.test` (`{ scope, provider }`, `{ scope }` and `{ scope, provider, ok }`; never a key or its hint). The audit log has an AI filter.

**Logging.** A raw provider error can carry the request headers, so every provider error is mapped to an `AiError` with a fixed message before it leaves `server/ai/anthropic.mjs`. The API's and the relay's error logs write an AI or provider error as its name, code and status only, and any other error as its stack with anything shaped like a key blanked.

**Provider.** `messages.stream(...)` and `finalMessage()`; the system prompt first with `cache_control`; `output_config` with the JSON schema and the effort; `stop_reason: "refusal"` checked first. Server-side fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are set for Claude Opus 5.5 and Claude Sonnet 5.5 only, in one function (`openStream` in `server/ai/anthropic.mjs`), because the field exists only on the SDK's beta client. Claude Haiku 5.5 has no fallback and uses the plain client. The SDK is pinned at exactly 0.128.0 and loaded on first use.

## Slice B: what is built

The second slice of phase 1 (TAB-97): `POST /api/ai/run` and the three features on the server. The AI bar in slice C uses the config's `credits` capability, sourced from the hosted `aiCredits` limit, when deciding whether to appear without a key. A keyless hosted run uses the AI credits proxy described above; credit metering and billing stay in the hosted proxy. The text above is the design; these are the points where the code adds to it or chose between options.

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

**Answers before the stream** are plain HTTP errors with a JSON body `{ error, message }`, in the order of the checks: `403 csrf`, `401 unauthenticated`, `400 bad_request` (the body), `403 ai_disabled` (AI is off, or restricted to members and the caller is a guest), `403 ai_feature_disabled`, `404 not_found` (no such board, a deleted one, or none the person can open), `403 forbidden` (cannot edit the board: viewers and commenters), `402 read_only` (a hosted workspace that is read-only; a viewer is told `forbidden` first), `409 ai_no_key`, `409 ai_key_unreadable`, `429 rate_limited` with `retry-after` (an hourly limit, a run already going for this person, or the key busy with another run). Then, with the board read, `400 bad_request` for a frame that is not on the board, a summary of nothing, or a cluster with fewer than two stickies the AI may read. A request that fails there does not use up the person's hour. With a credits run, an immediate proxy error is also returned as a plain HTTP error with its stable proxy code, status and message. An allowed personal key wins, then the workspace key; an unreadable saved key does not fall back to credits.

**The stream** is `text/event-stream`:

```
event: progress          data: {"n":0,"runId":"..."}   (first at once, naming the live run; then {"n":1}, ...)
event: result            data: {"runId":"...","proposal":{...},"cut":false,"usage":{"model","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"}}
event: error             data: {"error":"ai_refused","message":"..."}
```

Exactly one `result` or one `error` ends it. After the stream has started every failure is an `error` event: `ai_refused` (the provider declined; nothing changed), `ai_invalid_proposal`, `ai_timeout`, `ai_key_invalid`, `ai_rate_limited`, `ai_unavailable`, `forbidden` (the person lost the right to edit while the model worked), `internal`. Credits proxy errors use the proxy's `error.message` verbatim; see [AI credits](ai-credits.md) for codes and HTTP statuses. Other messages are fixed text. `ai_aborted` is what an audit row says when the person closed the request.

**Proposals** (`proposal.kind` is set by the server). `create`: `objects` is 1 to 30 stickies (at most `count` for generate) of `{ text, color? }`, `text` 1 to 2,000 characters and `color` the **name** of a sticky colour (Yellow, Orange, Pink, Violet, Blue, Teal, Green, Grey; any case is accepted and written back in the palette's spelling); `frame` is `{ title }` of 1 to 100 characters, required for summarise. `group`: 2 to 12 groups of `{ title, ids }`, no group empty, every id a sticky that is in the selection and exists and is readable now, each exactly once, together all of the stickies that were sent. Everything the model returns is plain text: control, tag, zero-width and bidirectional characters are removed, titles lose line breaks, a tag or an `&amp;` stays exactly the characters it is (the app has to draw it as text, never as markup), unknown keys are refused, and anything over a limit is an error, not a cut. An answer that fails any check is an `ai_invalid_proposal` error and carries no part of the proposal. The server log gets a fixed word for why (`unknown_id`, `duplicate_id`, ...), never anything the model wrote. The validator also checks the role: a role that cannot create stickies and frames (or move stickies, for a group) gets no proposal.

**Reading the board** uses the MCP reader (`readAll` and the same summaries as `get_board`), so private notes are withheld while unrevealed and a connector attached to one is left out; no author, no comment and no name is read. The scope is the selection (ids that are missing or withheld are left out), the direct children of a frame, or the whole board, nearest the centre of the selection, the frame or the board first (ties by id). Boxes come first, then the connectors whose ends were all sent. At most 400 objects and 60,000 characters of text go, and one object's text is cut at 1,000 characters; the answer says `cut: true` when anything was left out or shortened. A cluster sends only the selected stickies, and when the selection was cut the grouping must cover the stickies that were sent. The result is fenced with `fence()` from `server/board-ops.mjs`, exactly as the MCP tools fence board text; the board title is inside the fence, and the person's prompt, with a label saying it is the request and not the board, comes after it. The system prompt is a constant per feature and never changes with the run, so it caches.

**Limits** live in the process, not in the directory: a restart forgets every count and every run in flight. A run is admitted when the person has no run going, the key is under its cap (three for a shared key, one for a personal key), and the person and the workspace are under their hourly limits (the admin's `ai.limits.*`, 20 and 200 by default); a refused request counts for nothing. A run that never reached the provider (bad frame, nothing to summarise) takes its count back. Everything else counts, a provider error included. The hour is a sliding window. The per-key cap guards the key's provider rate limit and cost, and keeps one person from filling it: while a workspace key has three runs going, the next person is told to try again in a moment. The provider call gets an `AbortSignal` that fires after 120 seconds (`ai_timeout`) or when the person closes the request (`ai_aborted`), and the run is released either way. Key saves (`PUT /api/ai/keys/me`, and `PUT /api/admin/ai` with an `apiKey`) are limited to 10 an hour per person and one check in flight, `429 rate_limited`; saving settings without a key is not limited.

**Audit.** One row `ai.generate`, `ai.summarise` or `ai.cluster` for each run that reached the provider, written before the last event: `{ boardId, model, keySource: 'user' | 'workspace' | 'credits', outcome: 'ok' | <error code>, counts: { scope, inScope, sent, chars, cut, proposed }, tokens: { input, output, cacheRead, cacheWrite } }`. No board text, no prompt, no output, no key or proxy token. The audit log shows them as sentences ("Ana summarised “Roadmap”") under the AI filter.

**Open mode** has `POST /api/ai/run` too (and still no other AI endpoint besides `GET /api/ai/config`). It needs the CSRF header, answers `403 ai_disabled` unless `TABULA_AI_API_KEY` and `TABULA_AI_OPEN=1` are both set, uses that key and `TABULA_AI_MODEL`, counts runs per client address (the last `X-Forwarded-For` entry with `TABULA_TRUST_PROXY=1`, else the socket address; a run per address at a time, 20 an hour) and keeps one count for the whole instance (200 an hour), with up to three runs at once on the operator's key. There is no directory, so the audit row is a log line `ai.<feature> {json}` with the same fields.

**Code.** `server/ai/features.mjs` (prompts, schemas, input and proposal checks), `server/ai/board.mjs` (the read), `server/ai/limits.mjs` (the counters), `server/ai/run.mjs` (the run core, the accounts route and the open-mode handler). `board-ops.mjs` exports `readAll`, `summarise` and `stripInvisible` for them; `api.mjs` lets a route stream (`stream: true`), and the relay hands `canWriteRoom` and a room reader to the API and to the open-mode handler.

## Live runs

Everyone on a board sees its AI runs (TAB-141): while a run is going ("Ana is asking AI…"), and its proposal, as a faded preview with the runner's name, until someone adds or discards it. A run's proposal is never in the board document until then.

**State.** `server/ai/live.mjs` keeps the runs in memory, per board: `{ id, feature, by: { id, name, color }, target, private, status, startedAt, readyAt, proposal, cut, error, resolvedBy }`. The run route starts one when the provider is about to be called (a request refused before that leaves no run), marks it `ready` with the validated proposal or `failed` with the error code, and the first `progress` event and the `result` carry its `runId`. A ready run nobody settles `expired`s after 10 minutes, one still `running` after 5 minutes is `failed`, a board holds at most 12 open runs (the oldest ready one expires to make room), and a settled run is remembered for 10 minutes so a late click is told so. When a board's room unloads its runs are dropped; a restart forgets them all. **What the run request adds** (`POST /api/ai/run`, both optional): `presence: { color?, name?, outline? }` and `private`. `color` is the runner's cursor colour (`#RRGGBB`). `name` is used in open mode only, as plain text cut to 40 characters; in accounts mode the name is always the account's. `target`, what others outline while the run is going, is never taken from the client: it is `{ ids }` for a selection or `{ frameId }` for a frame, from the input the route already checks, and each app draws the outline from its own board; `outline: false` leaves it out (the bar's "Visible area", a selection the person did not make), and a whole-board run has none. In open mode `by.id` is null and a client address is never shown.

**Private runs** (`private: true`) are for a personal key only; on the workspace key, credits or the operator's key in open mode the request is `400 bad_request`, because the people who share the bill see what it is spent on. Nobody but the runner is sent anything about a private run, in any message, and to anyone else its id is `404`. Its audit row is written as for every run.

**The relay** sends message type 6 (`MSG_AI_RUNS`, relay to client only, board rooms only) with JSON `{ kind: 'snapshot', runs }` to a socket that joins while runs are open, then `{ kind: 'patch', run }` for each change. Every socket gets its own copy, built for its person by `viewFor`, so a rule that hides something is applied on the server and never left to the app. `accepted`, `discarded`, `failed` and `expired` mean the run is gone; they carry only `id`, `feature`, `status`, `by`, the `error` code of a failed run and `resolvedBy`.

**Settling.** `POST /api/ai/runs/:id/resolve` with `{ action: 'accept' | 'discard', presence?: { name } }` (CSRF header, as every write). The name is used in open mode only, as on a run, so the runner can be told who settled it; in accounts mode it is the account's. The first one wins: `200 { id, action, feature }`, and an accept adds `proposal` and `cut`, which the app of the person who clicked writes with `store.transact`, as one undo step on their own stack, laid out at `nextFree`. Then `409 ai_run_resolved` for everyone after, also for a failed or expired run, with `action` (`accept`, `discard`, `expired` or `failed`) and `by` (who settled it, `{ id, name }`, or null) next to `error`, so the app can say "Ana added her preview first", `409 ai_run_running` while it is still going, `404 not_found` for a run that is gone or on a board the person cannot open, `403 forbidden` when the policy says no, and `402 read_only` in a read-only hosted workspace. The server writes an audit row `ai.run.accept` or `ai.run.discard` with `{ boardId, feature }`. Open mode has the same route.

**Policy**, in `server/ai/policy.mjs` and repeated in `src/ai-policy.ts` for the app's buttons (a test keeps the two equal). Johan has still to confirm these (TAB-141), so each is one constant:

| Rule | Now | Other choices |
| --- | --- | --- |
| Who sees runs (`canSeeRun`) | everyone who can open the board, viewers and commenters too; a private run only its runner | |
| Who may add or discard (`RESOLVE_POLICY`) | `'editors'`: anyone who can edit the board | `'runner-first'`: the runner, then any editor 30 s (`RUNNER_FIRST_MS`) after the run is ready |
| Who sees the prompt (`PROMPT_VISIBILITY`) | `'runner'`: nobody is sent it, since the runner's app has it already | `'everyone'`, `'none'` |

## Reviewing a proposal

Review panel (TAB-160). A ready preview, on the bar and in the live-run tray, has a **Review** button that opens a panel on the right of the board. It shows every item of the proposal with a box to keep it, and the person can change it before it is added:

- A `create` proposal (generate, summarise): each sticky has its text (up to 2,000 characters) and its colour (one of the sticky colours), and the frame, if there is one, has a title (up to 100) and a box to leave it out. A sticky whose text is emptied is left out; a frame needs at least one sticky.
- A `group` proposal (cluster): each group has a title and a box, and each sticky it would move has a box. A group needs a title and at least one sticky left.
- The button reads **Add all (n)** while everything is kept and **Add selected (k)** or **Move selected (k)** when not; **Discard** is the preview's Discard. Add with nothing kept says so and writes nothing.

**Edits are the reviewer's own.** A review lives in the reviewing app only (`src/ai-review.ts`, kept per run in `src/ui/ai-live.ts`) and is never sent to the relay or written to the document. The ghosts on that screen follow it, so what the person sees is what they add; everyone else keeps seeing the proposal as it came, until it is added or discarded. The relay still settles the run with the first Add or Discard, as in "Live runs", and the person who clicked writes their reviewed version.

**Stale items.** When a group proposal arrives the app notes how each sticky it would move looked (position, size, text, frame, kind, lock). A sticky that has changed since, or is gone, is marked **Changed since**, unticked, and cannot be ticked: it is left where it is. This is judged on the reviewer's screen only. It holds without opening Review too (TAB-213): with no review open, the ghosts and **Add to board** / **Accept** use the review the panel would start with, so a sticky that changed since (or was deleted, locked or turned into another kind) is neither drawn nor moved, and the toast says how many were left ("1 sticky that changed since the proposal came was left where it is."). When every sticky changed, the preview has nothing left to draw or add: Add says so and does not ask the relay, and the preview keeps a short label row on the board (TAB-221): "Ana's AI preview" with the note "everything changed since it came", over the stickies that are still there (in the middle of the view when they are all gone), and a **Discard** for whoever may settle it. The runner's own short row has no Discard: their bar has it. It is placed like any other row and never moves the camera.

**One undo step.** Add writes the reviewed proposal with `applyProposal`, one `store.transact`, so one Ctrl+Z takes back the whole subset. The objects are `createdBy` the person who added them and carry `proposedBy`.

**`proposedBy`** is `{ feature: 'generate' | 'summarise' | 'cluster', by: { id, name } }` on each object a proposal created: which run it came from and who asked for it. It is a field in the document, so it is read like any other stored data that a collaborator, a file or a tool could have written (TAB-203):

- `cleanProposedBy` (`src/safe-obj.ts`, run by `safeObj`) keeps the one shape: the feature must be one of the three, the id a plain id (`[A-Za-z0-9_-]`, 64 at most), the name one line of at most 40 visible characters with control, zero-width, bidirectional and tag characters removed. Anything else in the value is dropped, and a value that is not an object, or has another feature, is dropped whole.
- The properties panel shows "Proposed by AI (Summarise) for Ana" from the cleaned value, set as text.
- MCP (the object lists and `get_objects`) shows only `{ feature, name }`, the name cut to 40 characters like other names a model reads; the id is not shown. An unknown shape shows nothing. MCP cannot write it: `create_objects` takes no such field.
- Copy, paste and duplicate (`remapObjects`) pass it through `cleanProposedBy` too, so a crafted clipboard or file cannot put another shape on a board. The readable snapshot (`toJson`, which is also `board.json` inside a `.drift` file) writes it in the clean shape or leaves it out. The CRDT state a `.drift` file carries is the document as it is, so it keeps what the document holds, and it is cleaned when read.
- Templates never keep it: saving one removes it, and using one (in the app, `instantiate`, and on the server, `planUseTemplate`) drops it from content that has it.

### Deferred

Not in this slice, each to follow on the same ghost overlay and resolve flow:

- **Proposals stored in the document**, with the 7-day expiry TAB-160 describes. Toolbar previews stay relay-held and in memory, 10 minutes (Johan's decision of 2026-10-09 on TAB-160).
- **Accepting while offline**, applied on reconnect. Add needs the relay to settle the run, so it needs a connection.
- **Proposals from MCP agents.** Agents still write through MCP with their own origin; they do not yet propose.
- **Live shared edits** of a proposal: one person's review changes are not seen by others.

### Checking the review in a browser

`npm run check:ai-review` drives the review panel in headless Chromium, with nothing on the network. It builds the app (`npm run build:app`; `-- --no-build` reuses `dist/`), starts a throwaway relay in open mode (a fresh data folder, a free port, `TABULA_AI_OPEN=1`), and points the relay's Anthropic client at a local stub (`scripts/lib/anthropic-stub.mjs`, 127.0.0.1 only, through `ANTHROPIC_BASE_URL`). The stub streams a canned answer for the feature that asked (five stickies and a frame for generate, two groups for cluster) and records every call, and the check asserts that no other call was made. Nothing from the shell's `TABULA_*` or `ANTHROPIC_*` variables reaches the relay. The relay runs with `TABULA_TRUST_PROXY=1` and every browser context sends its own `x-forwarded-for` address (from 198.18.0.0/15), so the open-mode limit of 20 runs an hour per address cannot stop a check or two checks in the same hour; the production limits are not changed. It needs Chromium once (`npx playwright install chromium`).

It asserts, and prints `PASS` or `FAIL` for each step and a last line `REPORT: PASS=n FAIL=n BLOCKED=n`. The exit code is 1 unless every step passed and nothing was blocked (the app did not build, Chromium is missing, a relay or the stub did not start).

- **At 390 and 1024 wide:** a ready create proposal with the panel closed and open, after one sticky was unticked, one text edited and one colour changed (the ghosts follow), with every item unticked, a cluster proposal where a peer edited one sticky after it arrived ("Changed since", unticked, disabled), and after Add selected (the added objects carry `proposedBy`, and the properties panel reads "Proposed by AI (Generate ideas) for …"). Each state is a screenshot in `tabula-review/ai-review/` (git-ignored; `-- --out <folder>` to move them), taken for a person to look at: the asserts do not judge a layout.
- **Show:** with the preview panned off screen the view does not move by itself, and the bar's Show brings the preview into view (its label row inside the viewport, its own Show pressable). `-- --theme <id>` takes the same shots in another theme from `src/themes.ts` (the colours are asserted for the default theme only). `-- --provider openai-compatible` runs the same scenario with the relay in open mode pointed at `scripts/lib/openai-stub.mjs`, a fake OpenAI-style server (`/models` and `/chat/completions`, with modes for a server that honours `json_object`, one that rejects it with a 400, fenced or prose answers, errors and refusals); the check then asserts that every call went to that stub with the `json_object` format. `-- --runner "Alexandria Montgomery-Li"` runs it with a long reviewer name (at most 40 characters), which is how the label rows are checked at 360. `-- --widths 360,390,1024` sets the widths of the single-person scenario (default 390 and 1024); at every width it asserts that none of the bar's preview-row buttons is cut off.
- **Show on the label row, and a preview that all changed:** with the preview half out of the view, the label row's own Show brings it back. When a peer changes every sticky of a cluster preview, the peer's and the runner's views swap its ghosts for the short row; the peer's Discard settles the run for both.
- **Two people on one board:** A asks and both see the preview; B reviews it and A still sees the original; B adds the subset; both boards then hold the same objects, written once, with `proposedBy`; the preview is gone for A; one Undo for B removes every added object for both.
- **Every page:** the console and page errors of each browser context are printed (`CONSOLE`, `PAGEERROR`). They are listed, not asserted.

It is never part of `npm test` or CI: it takes about a minute and needs a browser. `test/ai-review-check-config.test.ts` checks that no npm script or workflow runs it, that vitest collects nothing under `scripts/`, that the script names no path of the machine it was written on, that it writes only to `dist/`, `tabula-review/` and a temporary folder, and that the stub answers as described. Run it by hand when the panel, `ai-live.ts` or the resolve flow changes.

## Not in this slice

Text to diagram, smart template fill, a chat assistant with tools, OpenAI-compatible providers, image input, AI on comments, local-only (per-device) keys, per-person credit allowances, metered overage.

## Recommended answers to TAB-99

1. **First features: generate stickies, summarise (with action items), cluster stickies.** They cover the start, middle and end of a session, each is one model call with a structured answer and no tools, and their results are ordinary stickies the person can undo. Action items ship inside summarise. Text to diagram waits for the Mermaid move. Smart template fill waits until templates have fields to fill.
2. **Anthropic only at first**, behind a provider interface that takes an OpenAI-compatible adapter next. Shipping one provider well (structured output, refusals, caching, error messages) beats two half-tested ones; the second mostly helps self-hosters with local models and can follow without schema or UI changes.
3. **Both, workspace first.** The admin sets the workspace key, which controls spend and where data goes, and decides whether people may add personal keys (off by default). A personal key wins over the workspace key when allowed. Open mode uses the operator's environment key only.
4. **Credits pooled per workspace, top-up packs, no metered overage.** Suggested starting point at €8 per seat per month: 100 credits (about €1 of provider cost) per paid seat per month, the same monthly amount on yearly plans. At the defaults above on Claude Opus 5.5 ($4 / $20 per million input / output tokens) a board summary (about 15,000 tokens in, 3,000 out, thinking included) costs about 11 credits and a sticky generation about 2 to 3, so that is roughly 9 summaries or 40 generations per seat per month, pooled. Fully used, it is about 12% of seat revenue; Claude Sonnet 5.5 halves the cost per run if that proves too tight. Packs: 1,000 credits for €15 and 5,000 for €60. The backups add-on is unrelated; AI does not need its own add-on while it rides on seats. These numbers should be checked against real usage from the BYOK phase before phase 2 launches.
