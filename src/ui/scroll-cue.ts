/** Which edge of a row that scrolls sideways has more behind it: '' when it all fits. The CSS fades that edge (`data-more`). */
export function moreCue(scrollLeft: number, clientWidth: number, scrollWidth: number): '' | 'left' | 'right' | 'both' {
  const left = scrollLeft > 1;
  const right = scrollLeft + clientWidth < scrollWidth - 1;
  return left && right ? 'both' : left ? 'left' : right ? 'right' : '';
}

/** The scroll position that puts a child (at `offset`, `width` wide) in the middle of a row, kept inside what the row can scroll. */
export function centredScroll(offset: number, width: number, clientWidth: number, scrollWidth: number): number {
  return Math.max(0, Math.min(scrollWidth - clientWidth, offset + width / 2 - clientWidth / 2));
}

/** Keeps `data-more` on a scrolling row up to date as it scrolls and as its width changes. */
export function trackMore(el: HTMLElement): () => void {
  const update = () => {
    const cue = moreCue(el.scrollLeft, el.clientWidth, el.scrollWidth);
    if (cue) el.dataset.more = cue;
    else delete el.dataset.more;
  };
  el.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
  return update;
}

/** The same for a column that scrolls up and down: which edge has more behind it ('' when it all fits). The CSS fades that edge (`data-more-y`). */
export function moreCueY(scrollTop: number, clientHeight: number, scrollHeight: number): '' | 'up' | 'down' | 'both' {
  const up = scrollTop > 1;
  const down = scrollTop + clientHeight < scrollHeight - 1;
  return up && down ? 'both' : up ? 'up' : down ? 'down' : '';
}

/** Keeps `data-more-y` on a scrolling column up to date as it scrolls and as its height changes (a tray or a bar opening shortens it). */
export function trackMoreY(el: HTMLElement): () => void {
  const update = () => {
    const cue = moreCueY(el.scrollTop, el.clientHeight, el.scrollHeight);
    if (cue) el.dataset.moreY = cue;
    else delete el.dataset.moreY;
  };
  el.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  observer?.observe(el);
  update();
  return update;
}

/** One page of the rail's tools: the visible height less one item, so the item at the edge stays in view as a landmark. */
export function railPageStep(clientHeight: number, itemHeight: number): number {
  return Math.max(itemHeight, clientHeight - itemHeight);
}

/**
 * The cue for a tool rail that has to scroll: a chevron button between the tools and Undo/Redo, and a thin track with a
 * thumb beside the tools. Both exist only while the tools overflow, and follow the scroll and the window's height. The
 * chevron scrolls one page and turns into an up chevron at the end.
 */
export function mountRailScrollCue(rail: HTMLElement, tools: HTMLElement, chevron: HTMLButtonElement, track: HTMLElement, thumb: HTMLElement): () => void {
  const update = () => {
    const overflow = tools.scrollHeight - tools.clientHeight > 1;
    chevron.hidden = !overflow;
    track.hidden = !overflow;
    if (!overflow) return;
    const atEnd = tools.scrollTop + tools.clientHeight >= tools.scrollHeight - 1;
    const dir = atEnd ? 'up' : 'down';
    if (chevron.dataset.dir !== dir) {
      chevron.dataset.dir = dir;
      const label = dir === 'up' ? 'Scroll tools up' : 'Scroll tools down';
      chevron.setAttribute('aria-label', label);
      chevron.setAttribute('data-tip', label);
    }
    const trackHeight = tools.clientHeight;
    const thumbHeight = Math.max(16, Math.round((tools.clientHeight / tools.scrollHeight) * trackHeight));
    const range = tools.scrollHeight - tools.clientHeight;
    track.style.top = `${tools.offsetTop}px`;
    track.style.height = `${trackHeight}px`;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.round((tools.scrollTop / range) * (trackHeight - thumbHeight))}px)`;
  };
  chevron.addEventListener('click', () => {
    const item = tools.querySelector<HTMLElement>('button')?.offsetHeight || 34;
    const step = railPageStep(tools.clientHeight, item);
    tools.scrollBy({ top: chevron.dataset.dir === 'up' ? -step : step });
  });
  tools.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  observer?.observe(tools);
  observer?.observe(rail);
  update();
  return update;
}
