import { h, icon } from './dom';
import { focusFirst, focusIsIn, inertPage, restoreFocus, rovingRadios, trapTab } from './focus-scope';
import { safeInsets } from './safe-area';
import { placePopover } from './popover-layout';

let openPop: { el: HTMLElement; close: () => void } | null = null;

/** Floating panel anchored to an element; closes on outside click or Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { side?: 'right' | 'bottom' | 'top' | 'left'; className?: string; label?: string; onClose?: () => void } = {}) {
  closePopover();
  const label = opts.label ?? (anchor.getAttribute('aria-label') || anchor.textContent?.trim() || 'Options');
  const el = h('div', { class: `popover tray ${opts.className ?? ''}`, role: 'dialog', 'aria-label': label }, content);
  const opener = anchor.tagName === 'BUTTON' ? anchor : null;
  if (opener) {
    if (!opener.hasAttribute('aria-haspopup')) opener.setAttribute('aria-haspopup', 'dialog');
    opener.setAttribute('aria-expanded', 'true');
  }
  document.body.appendChild(el);
  const place = () => {
    const r = el.getBoundingClientRect();
    const safe = safeInsets();
    const side = opts.side ?? 'bottom';
    // the session bar is drawn again when its steps change, which detaches the button the panel opened from: the bar itself is then the anchor
    const bar = side === 'top' ? (anchor.closest<HTMLElement>('.flowbar.show') ?? document.querySelector<HTMLElement>('.flowbar.show')) : null;
    const a = anchor.isConnected || !bar ? anchor.getBoundingClientRect() : bar.getBoundingClientRect();
    if (!anchor.isConnected && !bar) return;
    const avoidAbove = bar?.getBoundingClientRect();
    const pos = placePopover(a, r, { width: window.innerWidth, height: window.innerHeight }, safe, side, avoidAbove);
    if (pos.maxHeight === null) el.style.removeProperty('max-height');
    else el.style.maxHeight = `${pos.maxHeight}px`;
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  };
  place();
  requestAnimationFrame(place);
  // a panel that grows after it opened (Add step in the Steps list, a longer list) is placed again, so a top panel keeps clear of the session bar instead
  // of running down over it; the window can change size under it too
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  observer?.observe(el);
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab' && focusIsIn(el)) trapTab(e, el);
  };
  const close = () => {
    const giveBack = focusIsIn(el);
    el.remove();
    opener?.setAttribute('aria-expanded', 'false');
    if (giveBack) restoreFocus(anchor);
    observer?.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    if (openPop?.el === el) openPop = null;
    opts.onClose?.();
  };
  setTimeout(() => window.addEventListener('pointerdown', onDown, true));
  window.addEventListener('keydown', onKey, true);
  openPop = { el, close };
  focusFirst(el);
  return { el, close, place };
}

export function closePopover() {
  openPop?.close();
}

let toastTimer = 0;
/** The toast's distance from the bottom of the window, as in styles.css; it moves up past a session bar. */
const TOAST_BOTTOM = 76;

/**
 * A short message. With `action` it also carries one button (such as Undo), which is why it should stay longer: pass `ms`.
 * The AI bar publishes `--ai-top` on the page, how far it reaches up from the bottom, and the toast stays above it.
 */
export function toast(msg: string, ms = 2600, action?: { label: string; onClick: () => void; keyId?: string }) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  const box = el;
  if (action) {
    box.replaceChildren(
      h('span', null, msg),
      h('button', {
        class: 'toast-action', type: 'button', 'data-tip': action.label, ...(action.keyId ? { 'data-tip-key': action.keyId } : {}),
        onclick: () => {
          clearTimeout(toastTimer);
          box.classList.remove('show');
          action.onClick();
        },
      }, action.label),
    );
  } else box.textContent = msg;
  box.classList.toggle('has-action', !!action);
  // above the session bar while one is showing, so a toast never covers its buttons (at phone width it is tall)
  const bar = document.querySelector('.flowbar.show');
  const safeBottom = safeInsets().bottom;
  const base = bar ? `${Math.max(TOAST_BOTTOM + safeBottom, Math.round(innerHeight - bar.getBoundingClientRect().top + 8))}px` : `${TOAST_BOTTOM + safeBottom}px`;
  box.style.bottom = `max(${base}, var(--ai-top, 0px))`;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.remove('show'), ms);
}

/** Open dialogs, oldest first: Escape closes only the last one. */
const openDialogs: object[] = [];
let dialogSeq = 0;

/** Modal dialog. Resolves when closed. */
export function dialog(
  title: string,
  body: HTMLElement,
  actions: { label: string; primary?: boolean; onClick?: () => void | boolean | Promise<void | boolean> }[] = [],
  opts: { className?: string; onClose?: () => void } = {},
) {
  const back = h('div', { class: `modal-back${opts.className ? ` ${opts.className}` : ''}` });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('close', 18));
  const titleId = `dialog-title-${++dialogSeq}`;
  const box = h('div', { class: 'modal tray', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, ...actions.map((a) =>
      h('button', {
        class: a.primary ? 'btn primary' : 'btn',
        onclick: async () => {
          const r = await a.onClick?.();
          if (r !== false) close();
        },
      }, a.label))) : null,
  );
  back.appendChild(box);
  document.body.appendChild(back);
  const self = {};
  openDialogs.push(self);
  const opener = document.activeElement as HTMLElement | null;
  const releasePage = inertPage(back);
  const onKey = (e: KeyboardEvent) => {
    if (openDialogs[openDialogs.length - 1] !== self) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab' && !(document.activeElement as HTMLElement | null)?.closest?.('.popover')) trapTab(e, box);
  };
  window.addEventListener('keydown', onKey);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey);
    const i = openDialogs.indexOf(self);
    if (i >= 0) openDialogs.splice(i, 1);
    back.remove();
    releasePage();
    restoreFocus(opener);
    opts.onClose?.();
  }
  // the first field, or the main button; a dialog with neither (a notice) starts on its close button
  requestAnimationFrame(() => focusFirst(box, (box.querySelector('input, textarea, button.primary') as HTMLElement | null) ?? closeBtn));
  return { close, box };
}

export function swatches(colors: { name: string; value: string }[], current: string | undefined, onPick: (v: string) => void, opts: { label: string }) {
  const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': opts.label });
  const buttons: HTMLButtonElement[] = [];
  for (const c of colors) {
    const b = h('button', {
      class: `swatch${c.value === 'none' ? ' none' : ''}${current?.toLowerCase() === c.value.toLowerCase() ? ' on' : ''}`,
      'data-tip': c.name, 'aria-label': c.name, role: 'radio', 'aria-checked': String(current?.toLowerCase() === c.value.toLowerCase()),
      style: c.value === 'none' ? undefined : `--c:${c.value}`,
      onclick: () => {
        for (const x of buttons) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', String(x === b));
        }
        onPick(c.value);
      },
    });
    buttons.push(b);
    row.appendChild(b);
  }
  rovingRadios(row);
  return row;
}

export function segmented<T extends string | number>(options: { value: T; label: string; icon?: HTMLElement }[], current: T | undefined, onPick: (v: T) => void, label: string) {
  const row = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const buttons: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = h('button', {
      class: o.value === current ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === current),
      'data-tip': o.icon ? o.label : undefined, 'aria-label': o.label,
      onclick: () => {
        for (const x of buttons) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', String(x === b));
        }
        onPick(o.value);
      },
    }, o.icon ?? o.label);
    buttons.push(b);
    row.appendChild(b);
  }
  rovingRadios(row);
  return row;
}

export function field(label: string, control: HTMLElement) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control);
}

export const fmtAgo = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
