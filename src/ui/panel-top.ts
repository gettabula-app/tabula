/** Space between the lowest top bar and a panel under it. */
export const PANEL_GAP = 8;
/** The smallest --panel-top, as in styles.css: on a wide screen the bars are shorter than this anyway. */
export const PANEL_TOP_MIN = 72;

/**
 * Where side panels start, in px from the top of the chrome: below the lowest of the top bars plus a gap. `bottoms` are
 * the bars' bottom edges and `origin` the chrome's top edge, both in viewport px; a bar that is not laid out is left out.
 */
export function panelTop(bottoms: number[], origin: number, min = PANEL_TOP_MIN): number {
  const lowest = Math.max(origin, ...bottoms);
  return Math.max(min, Math.ceil(lowest - origin + PANEL_GAP));
}

/**
 * Keeps --panel-top on `chrome` equal to the real bottom of the top bars, so comments, history, properties and poll
 * panels clear them at every width, also where a bar wraps onto a second line. styles.css keeps a fallback value.
 */
export function trackPanelTop(chrome: HTMLElement, bars: HTMLElement[]): () => void {
  const update = () => {
    const bottoms = bars.filter((b) => b.getClientRects().length > 0).map((b) => b.getBoundingClientRect().bottom);
    chrome.style.setProperty('--panel-top', `${panelTop(bottoms, chrome.getBoundingClientRect().top)}px`);
  };
  const ro = new ResizeObserver(update);
  for (const b of bars) ro.observe(b);
  ro.observe(chrome);
  update();
  return () => ro.disconnect();
}
