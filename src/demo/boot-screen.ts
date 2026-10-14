// The demo's loading screen (TAB-247). vite.config.ts injects DEMO_BOOT_STYLE at the end of <head> and DEMO_BOOT_HTML after
// <div id="app"> in the demo build only, so the screen paints from the first byte, before any script has run. Nothing here may load
// from the network or run script: the demo CSP and scripts/check-demo-dist.mjs forbid it. vite.config.ts imports this file in Node, so
// it has no imports and touches the DOM only inside demoBootDone().
// The demo always opens in the default (paper) theme, whatever the visitor's OS scheme, so the screen is paper only: a dark one would flash before a light board.

const MARK_T = 'M44.55 146.25V145.12H61.05V34.88H54Q48.23 34.88 43.58 37.76Q38.93 40.65 35.33 45.68Q31.73 50.7 29.33 57.19Q26.93 63.67 25.65 70.8H24.53V33.75H124.95V70.8H123.83Q122.62 63.67 120.19 57.19Q117.75 50.7 114.19 45.68Q110.62 40.65 105.94 37.76Q101.25 34.88 95.48 34.88H88.43V145.12H104.93V146.25Z';

export const DEMO_BOOT_STYLE = `
html, body { background: #F7F5F0; }
#demo-boot { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px; box-sizing: border-box; background-color: #F7F5F0; background-image: radial-gradient(rgba(18,18,22,.10) 1px, transparent 1px); background-size: 24px 24px; color: rgba(18,18,22,.6); font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; text-align: center; }
#demo-boot .demo-boot-mark { display: block; width: 56px; height: 56px; }
#demo-boot .demo-boot-text { margin: 0; font-size: 14px; line-height: 20px; color: rgba(18,18,22,.6); }
#demo-boot .demo-boot-late { position: absolute; left: 24px; right: 24px; top: calc(50% + 64px); margin: 0; font-size: 14px; line-height: 20px; color: rgba(18,18,22,.6); opacity: 0; visibility: hidden; animation: demo-boot-late 0s 15s forwards; }
@keyframes demo-boot-late { to { opacity: 1; visibility: visible; } }
#demo-boot .demo-boot-line { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; background: rgba(18,18,22,.25); }
#demo-boot .demo-boot-bar { position: absolute; top: 0; bottom: 0; left: 0; width: 30%; background: #121216; animation: demo-boot-slide 1.4s linear infinite; }
@keyframes demo-boot-slide { from { transform: translateX(-100%); } to { transform: translateX(333.334%); } }
#demo-boot.demo-boot-done { opacity: 0; transition: opacity 180ms ease; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  #demo-boot .demo-boot-bar { animation: none; width: 100%; }
  #demo-boot.demo-boot-done { transition: none; }
}
`;

export const DEMO_BOOT_HTML = `<div id="demo-boot" role="status" aria-live="polite">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="56" height="56" aria-hidden="true" class="demo-boot-mark"><path class="demo-boot-t" fill="#121216" d="${MARK_T}"/><path fill="#D42A18" d="M110.48 101.25h45.00v45.00h-45.00z"/></svg>
      <p class="demo-boot-text">Loading the demo…</p>
      <p class="demo-boot-late">This is taking longer than usual. Reload the page to try again.</p>
      <div class="demo-boot-line" aria-hidden="true"><div class="demo-boot-bar"></div></div>
    </div>`;

let finished = false;

/**
 * The board has painted: fade the loading screen out, remove it (at once under reduced motion), and tell an embedding page once.
 * Idempotent, and a no-op without a DOM.
 */
export function demoBootDone(): void {
  if (finished || typeof document === 'undefined' || typeof window === 'undefined') return;
  finished = true;
  const boot = document.getElementById('demo-boot');
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (boot) {
    boot.classList.add('demo-boot-done');
    if (reduced) boot.remove();
    else window.setTimeout(() => boot.remove(), 220);
  }
  const parent = window.parent;
  if (parent && parent !== window) parent.postMessage({ type: 'tabula-demo-ready' }, '*');
}
