# AI credits on hosted workspaces

Hosted workspaces can route AI runs through the Tabula credits proxy when their current limits include `aiCredits: true`. The proxy is a separate service that speaks the Anthropic Messages API; it owns credit metering and returns Anthropic-shaped responses.

## Key precedence

The run route resolves credentials in this order:

1. The caller's personal key, when personal keys are enabled.
2. The saved workspace key.
3. Hosted credits, only when neither saved key exists, the workspace has `limits.aiCredits === true`, and both proxy environment values are configured.
4. `409 ai_no_key` when no source is available.

An existing personal or workspace key always wins over credits. If a saved key cannot be read, the run returns `ai_key_unreadable`; it does not silently switch to credits. Private runs are allowed only with a personal key, so a credits run is refused with `400 bad_request`.

## Instance environment

The hosted instance receives these values from its operator:

- `TABULA_AI_PROXY_URL` is the Anthropic Messages API base for this workspace, for example `https://api.gettabula.app/ai/v1/<workspaceId>`.
- `TABULA_AI_PROXY_TOKEN` is the workspace-scoped credential sent as Anthropic's `x-api-key` header.

Use HTTPS for the proxy URL. The instance accepts HTTP only for loopback test servers. If either value is absent, AI credits may still be advertised to the client, but the run route does not attempt a proxy call and returns `ai_no_key`. The token is non-enumerable in server configuration and is never returned by an API, logged, or stored in an audit row.

In Admin → AI, `creditsActive` is true only when no workspace key is saved, the workspace has the `aiCredits` entitlement and both proxy values are present. Personal keys remain per-person and still take precedence for their owner.

## Proxy request and errors

The instance uses `POST {TABULA_AI_PROXY_URL}/v1/messages`, with the Anthropic SDK request body and `TABULA_AI_PROXY_TOKEN`. It accepts normal Anthropic message and stream responses. Immediate proxy errors are returned as ordinary HTTP errors before the app stream begins. The instance maps the stable `error.type` to the same API error code and displays `error.message` verbatim:

| HTTP status | `error.type` | Client behavior |
| --- | --- | --- |
| 429 | `credits_exhausted` | Shows the proxy's message, including its reset guidance. |
| 403 | `credits_not_included` | Shows the proxy's message. |
| 429 | `rate_limited` | Shows the proxy's message and forwards `retry-after` when present. |
| 400 | `model_not_allowed` | Shows the proxy's message. |
| 400 | `max_tokens_too_large` | Shows the proxy's message. |
| 413 | `request_too_large` | Shows the proxy's message. |
| 503 | `ai_unavailable` | Shows the proxy's message. |

Audit rows add no proxy details. They continue to record `keySource: 'credits'` and the usual model, outcome, counts and token totals; they contain no proxy token, request text or response text.
