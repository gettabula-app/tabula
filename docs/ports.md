# Port audit

This audit covers the scripts, tests, Vitest configuration, package scripts and GitHub workflows in this worktree. It records real server starts; fixed addresses used only as config fixtures or URL assertions are not listeners.

| Script or config | What it starts | Before | After |
| --- | --- | --- | --- |
| `scripts/dev.mjs`, `vite.config.ts` | Relay and Vite dev server | Relay was forced to `8787`; Vite and its relay proxy targets were fixed at `5173` and `8787` | `PORT` selects the relay (default `8787`); `VITE_PORT` selects Vite (default `5173`); proxy targets and accounts links follow those values |
| `scripts/desktop-dev.mjs` (`npm run desktop:dev`) | Tauri webview and its dev servers | The webview URL was fixed at `5173`, even if Vite moved to another port | Tauri's webview URL follows `VITE_PORT` (default `5173`) |
| `scripts/docs-images.mjs` | Temporary open and accounts relays for screenshots | Open relay used a system-assigned port; accounts relay preferred `8787` and fell back when occupied | Both relays use a system-assigned port |
| `scripts/visual-check.mjs`, `scripts/check-ai-review.mjs`, `scripts/a11y-audit.mjs`, `scripts/load-class.mjs`, `scripts/qa-sweep-360.mjs` | Temporary relay and browser/load-check process | Relay ports were already selected dynamically | No change |
| `test/**` | Relay, proxy, control-plane and provider test servers | Listeners use `test/free-port.ts` or bind port `0`; `8787` values are config fixtures or URL assertions | No change |
| `vitest*.ts`, other `package.json` scripts, `.github/workflows/**` | Test/build commands | No additional fixed-port server or browser startup found | No change |

## Dev defaults

`npm run dev` keeps Vite on `5173` and the relay on `8787` by default. Set `VITE_PORT` and `PORT` to distinct available ports for concurrent dev sessions. Vite uses strict port binding so an occupied `VITE_PORT` fails clearly instead of silently moving away from the accounts link. `npm start` continues to use the relay's documented `8787` default and honors `PORT`.

`scripts/bench-relay.mjs` is absent from this worktree and was excluded as requested.
