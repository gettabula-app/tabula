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
