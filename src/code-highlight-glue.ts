// INTEGRATOR: THIS FILE IS A STUB. Replace the body of `initCodeHighlight` when the highlighter branch (cybersec/code-highlight) is merged.
//
// What the real glue does (docs/code-blocks.md, the seam in src/code-markup.ts):
//   1. `setCodeTokenSource(fn)`: fn(o) answers, synchronously and from a cache, with the CodeLines of exactly this block's current text and language and the
//      current theme (or null: the block is drawn as plain ink). It must never return tokens for another text.
//   2. For blocks in or near the viewport (and only those) it calls `highlightCode({ lang, theme, text })` from src/code-highlight.ts, one request in flight
//      per block, idle-scheduled; when the answer arrives it stores it and calls `requestRepaint()` (src/code-markup.ts), which redraws the code blocks.
//   3. The theme comes from src/code-themes.ts for the board's current theme and surface.
//   4. It returns a function that stops all of that (called when the board goes away); `setCodeTokenSource(null)` goes there.
// Until then no block has tokens: every block is drawn as plain text in the same geometry. Nothing else in the UI depends on this file.
import type { BoardApp } from './app';

// TODO(integrator): register the token source, request tokens for blocks near the viewport, call requestRepaint() when they arrive.
export function initCodeHighlight(_app: BoardApp): () => void {
  return () => {};
}
