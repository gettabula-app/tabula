# AI visualisations

Choose **Visualise** in the AI bar, select the context to send, describe a diagram,
calculator or interactive example, and press **Run**. The result opens in a dialog.
Its controls run inside that preview. **Retry** generates another result from the
same request; closing the dialog discards it. Leaving the board closes it too.
Results and control state last for the current preview only.

Visualise uses the provider and key already configured for Tabula, including an
OpenAI-compatible endpoint. It follows the existing board editing permissions,
context filtering, hourly limits, concurrency limits, timeout and usage audit.
Hosted AI credits use the same provider path. An admin can enable or disable the
feature under **Admin, AI**; an existing saved feature list must include
`visualise` before it is available.

## Integration

This first integration follows [OpenIntelligentUI's generated UI contract](https://github.com/CopilotKit/OpenIntelligentUI/tree/main/apps/app/src/components/generative-ui/open-generative-ui)
and uses the same sandbox primitive, `@jetbrains/websandbox` (pinned to 1.4.3).
Tabula's structured provider response supplies `title`, `description`,
`initialHeight`, `css`, `html`, `jsFunctions` and `jsExpressions`.
The preview opens after generation completes. The existing TypeScript frontend
and relay supply the UI and provider transport.

`shared/ai-visualization.mjs` validates the exact fields and bounds on both sides.
Before that check the relay repairs near misses that would otherwise discard the
whole run: it shortens an overlong title or description, replaces a blank title
and rounds a numeric `initialHeight` into range. It never rewrites code: CSS,
HTML or JavaScript over its limit is refused.
Title and description appear as plain text outside the frame. Generated HTML,
CSS and JavaScript execute only inside an opaque-origin frame with
`sandbox="allow-scripts"`, an empty host API and a separate restrictive CSP.
The empty bootstrap is served from `/api/ai/visual-frame`, so the app retains its
`script-src 'self'` policy. Generated code never executes on the server.
The initial generation prompt uses native DOM, SVG and canvas, with local controls.

The frame's policy blocks fetch, external scripts, styles and images, child
frames and forms, and the sandbox keeps generated code away from Tabula's DOM,
cookies and storage. The frame is not a network isolation boundary:

- **WebRTC is not covered.** Content Security Policy does not govern WebRTC.
  Generated code can open a peer connection whose STUN or TURN requests reach a
  host it chooses, and it can encode data in those requests. The browser test
  shows a STUN request leaving the frame in Chromium.
- **Navigation within this instance is allowed.** The parent policy limits frame
  destinations to this instance, and the frame can navigate itself there.
  Chromium sends that request as cross-site, without the person's cookies.

The model writes the code from the person's request and the board content sent
with it. That content is fenced as data, but the model can still follow
instructions planted in it. Hostile generated code can therefore pass what was
sent as context to a third party.

Visualisations are session previews, separate from shared board proposals.
They are not broadcast through live AI runs or stored in board documents, and
they expose no host actions. Existing sticky creation, summaries and clustering
continue to use the proposal review and apply flow.

## Verification

The backend tests cover bounded output, near-miss repair, existing provider and
credit routing, permissions, disabled features and absence from shared proposals.
`test/ai-visualization-browser.test.ts` exercises interactive controls and sandbox
boundaries under the production app CSP. It also records both limits above: a
cookieless cross-site navigation, and a STUN request that reaches a local UDP
port. The AI bar tests cover the action, required prompt and distinct
visualisation result stream.
