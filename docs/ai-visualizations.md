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
Title and description appear as plain text outside the frame. Generated HTML,
CSS and JavaScript execute only inside an opaque-origin frame with
`sandbox="allow-scripts"`, an empty host API and a separate restrictive CSP.
The empty bootstrap is served from `/api/ai/visual-frame`, so the app retains its
`script-src 'self'` policy. Generated code never executes on the server.
The initial generation prompt uses native DOM, SVG and canvas, with local controls.

The frame blocks fetches, external scripts, child frames, forms and access to
Tabula's DOM or storage. Its parent policy restricts frame destinations to this
instance. Sandbox isolation does allow navigation within a frame; it should not
be treated as a general-purpose network isolation boundary.

Visualisations are session previews, separate from shared board proposals.
They are not broadcast through live AI runs or stored in board documents, and
they expose no host actions. Existing sticky creation, summaries and clustering
continue to use the proposal review and apply flow.

## Verification

The backend tests cover bounded output, existing provider and credit routing,
permissions, disabled features and absence from shared proposals.
`test/ai-visualization-browser.test.ts` exercises interactive controls and sandbox
boundaries under the production app CSP. The AI bar tests cover the action,
required prompt and distinct visualisation result stream.
