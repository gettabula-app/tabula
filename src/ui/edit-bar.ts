import type { BoardApp } from '../app';
import { h, icon } from './dom';
import { safeInsets } from './safe-area';
import './edit-bar.css';

/** A small editing control that follows the text box while the camera moves. */
export function mountEditBar(app: BoardApp, parent: HTMLElement) {
  const bar = h('div', { class: 'tray edit-bar qb', role: 'toolbar', 'aria-label': 'Text editing' });
  const button = h('button', {
    class: 'icon-btn edit-emoji', type: 'button', 'aria-label': 'Add emoji', 'aria-haspopup': 'dialog',
    onclick: async () => {
      const { openEmojiPicker } = await import('./emoji-picker');
      await openEmojiPicker(app, button);
    },
  }, icon('icons', 20));
  // A mouse press must not move focus out of the text (preventDefault); on a touch screen WebKit drops the tap's click when pointerdown is
  // cancelled, so a finger only holds the blur: the text keeps its edit while the tap goes through.
  let release = 0;
  button.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') event.preventDefault();
    app.editor.holdBlur(true);
    window.clearTimeout(release);
    release = window.setTimeout(() => { if (!document.querySelector('.emoji-pop')) app.editor.holdBlur(false); }, 1200);
  });
  button.addEventListener('pointercancel', () => {
    window.clearTimeout(release);
    if (!document.querySelector('.emoji-pop')) app.editor.holdBlur(false);
  });
  button.addEventListener('mousedown', (event) => event.preventDefault());
  bar.appendChild(button);
  parent.appendChild(bar);

  const visible = () => app.editor.active && app.editor.textMode && !app.readOnly;
  const position = () => {
    if (!visible() || !bar.classList.contains('show')) return;
    const box = app.editor.textarea.getBoundingClientRect();
    const safe = safeInsets();
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const leftEdge = safe.left + 8;
    const rightEdge = window.innerWidth - safe.right - 8;
    const topEdge = Math.max(safe.top, window.visualViewport?.offsetTop ?? 0) + 8;
    // the soft keyboard shrinks the visual viewport, not the window: the bar stays in what the person can see
    const vv = window.visualViewport;
    const bottomEdge = Math.min(window.innerHeight, vv ? vv.offsetTop + vv.height : window.innerHeight) - safe.bottom - 8;
    const x = Math.max(leftEdge, Math.min((box.left + box.right - width) / 2, rightEdge - width));
    const above = box.top - 8 - height;
    const below = box.bottom + 8;
    // the side with more room, so the picker that opens away from the note is tall enough to use instead of two rows
    // never under the top bars (a high note on a phone): they are drawn over the canvas
    const chrome = [...document.querySelectorAll<HTMLElement>('.top-left, .top-right')].map((el) => el.getBoundingClientRect());
    const hits = (top: number) => chrome.some((r) => x < r.right && x + width > r.left && top < r.bottom && top + height > r.top);
    const side = hits(above) && !hits(below) ? 'below' : hits(below) && !hits(above) ? 'above'
      : box.top - topEdge >= bottomEdge - box.bottom - height ? 'above' : 'below';
    bar.dataset.side = side;
    let y = side === 'above' ? above : below;
    y = Math.max(topEdge, Math.min(y, bottomEdge - height));
    bar.style.transform = `translate(${x}px, ${y}px)`;
  };
  const sync = () => {
    const show = visible();
    bar.classList.toggle('show', show);
    if (show) position();
  };

  const offEditing = app.on('editing', sync);
  const offReadonly = app.on('readonly', sync);
  const offObjects = app.on('objects', position);
  const offCamera = app.r.onCamera(position);
  const onViewport = () => position();
  window.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
  observer?.observe(app.editor.textarea);
  app.onDestroy(() => {
    offEditing();
    offReadonly();
    offObjects();
    offCamera();
    observer?.disconnect();
    window.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
  });

  sync();
  return { el: bar };
}
