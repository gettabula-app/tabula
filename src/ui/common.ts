import { h, icon } from './dom';
import { focusFirst, focusIsIn, inertPage, restoreFocus, rovingRadios, trapTab } from './focus-scope';
import { placeBesideAnchor } from './popover-place';
import { safeInsets } from './safe-area';
import { placePopover } from './popover-layout';
import { projectTarget, releaseVelocity, resumeFrom, type PickRecord } from './segmented-logic';
import { formatShortcutLabel } from '../shortcuts';
import { LOAD_PIXEL_RATIO, devicePixelRatioNow, pageIsZoomed } from '../zoom-keys';
import { popoverOrigin, type PopoverBox } from './popover-origin';

/** Grows the panel from the anchor's centre (popover-in in styles.css). Set after left/top, so the box is where it will be. */
const setOrigin = (el: HTMLElement, anchor: PopoverBox, left: number, top: number) => {
  el.style.setProperty('--pop-origin', popoverOrigin(anchor, { left, top, width: el.offsetWidth, height: el.offsetHeight }));
};

/** The height of what is visible: the soft keyboard shrinks the visual viewport but not the window. */
const visibleHeight = () => Math.min(window.innerHeight, window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight);

let openPop: { el: HTMLElement; close: () => void } | null = null;

/** Floating panel anchored to an element; closes on outside click or Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { side?: 'right' | 'bottom' | 'top' | 'left'; fitBelow?: boolean; getAnchorRect?: () => Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>; className?: string; label?: string; role?: 'dialog' | 'menu'; onClose?: () => void; onKeyDown?: (event: KeyboardEvent) => boolean; avoidAnchor?: boolean; trap?: boolean } = {}) {
  closePopover();
  const label = opts.label ?? (anchor.getAttribute('aria-label') || anchor.textContent?.trim() || 'Options');
  const trackerSurface = opts.className?.split(/\s+/u).includes('trk-pop') === true;
  const el = h('div', { class: `popover${trackerSurface ? '' : ' tray'} ${opts.className ?? ''}`, role: opts.role ?? 'dialog', 'aria-label': label }, content);
  const opener = anchor.tagName === 'BUTTON' ? anchor : null;
  if (opener) {
    if (!opener.hasAttribute('aria-haspopup')) opener.setAttribute('aria-haspopup', opts.role ?? 'dialog');
    opener.setAttribute('aria-expanded', 'true');
  }
  document.body.appendChild(el);
  const place = () => {
    // layout size, not the rect: the opening animation scales the box, and a scaled size would skew the placement (no later pass re-measures it)
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const safe = safeInsets();
    if (opts.avoidAnchor) {
      // never under the anchor (a finger is still on it); shorter and scrolling when the room is small
      el.style.maxHeight = '';
      el.style.overflowY = '';
      const anchorRect = anchor.getBoundingClientRect();
      const at = placeBesideAnchor(anchorRect, { width: r.width, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, safe);
      el.style.maxHeight = `${at.maxHeight}px`;
      el.style.overflowY = 'auto';
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      setOrigin(el, anchorRect, at.left, at.top);
      return;
    }
    const side = opts.side ?? 'bottom';
    // the session bar is drawn again when its steps change, which detaches the button the panel opened from: the bar itself is then the anchor
    const bar = side === 'top' ? (anchor.closest<HTMLElement>('.flowbar.show') ?? document.querySelector<HTMLElement>('.flowbar.show')) : null;
    const a = opts.getAnchorRect?.() ?? (anchor.isConnected || !bar ? anchor.getBoundingClientRect() : bar.getBoundingClientRect());
    if (!anchor.isConnected && !bar) return;
    const avoidAbove = bar?.getBoundingClientRect();
    const pos = placePopover(a, r, { width: window.innerWidth, height: visibleHeight() }, safe, side, avoidAbove, opts.fitBelow);
    if (pos.maxHeight === null) el.style.removeProperty('max-height');
    else el.style.maxHeight = `${pos.maxHeight}px`;
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    setOrigin(el, a, pos.left, pos.top);
  };
  place();
  requestAnimationFrame(place);
  // a panel that grows after it opened (Add step in the Steps list, a longer list) is placed again, so a top panel keeps clear of the session bar instead
  // of running down over it; the window can change size under it too
  // (a menu placed beside a finger does not grow, and it resets its own height while placing, so it is left out)
  const observer = typeof ResizeObserver === 'function' && !opts.avoidAnchor ? new ResizeObserver(() => place()) : null;
  observer?.observe(el);
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (opts.onKeyDown?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab' && opts.trap !== false && focusIsIn(el)) trapTab(e, el);
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
  // (and above the poll card that docks over the bar, which the toast would otherwise hide the foot of)
  const tops = [...document.querySelectorAll('.flowbar.show, .poll-card:not([hidden])')].map((e) => e.getBoundingClientRect().top);
  const safeBottom = safeInsets().bottom;
  const base = tops.length ? `${Math.max(TOAST_BOTTOM + safeBottom, Math.round(innerHeight - Math.min(...tops) + 8))}px` : `${TOAST_BOTTOM + safeBottom}px`;
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
  const trackerSurface = opts.className?.split(/\s+/u).includes('trk-modal') === true;
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': `Close ${title}`, 'data-tip': 'Close', onclick: () => close() }, icon('close', 18));
  const titleId = `dialog-title-${++dialogSeq}`;
  const box = h('div', { class: `modal${trackerSurface ? '' : ' tray'}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
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
  // iOS Safari: 100vh is taller than what is visible (the toolbars collapse and the keyboard opens), so the dialog is laid out in the visual viewport
  const vv = window.visualViewport;
  const fitVisible = () => {
    if (!vv) return;
    back.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    back.style.setProperty('--vv-height', `${vv.height}px`);
  };
  fitVisible();
  vv?.addEventListener('resize', fitVisible);
  vv?.addEventListener('scroll', fitVisible);
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
    vv?.removeEventListener('resize', fitVisible);
    vv?.removeEventListener('scroll', fitVisible);
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

/** A pointer drag of the segmented marker: px values are physical (left is positive) and relative to the page. */
type SegDrag = {
  id: number; startX: number; grab: number; rest: number; threshold: number; active: boolean;
  lo: number; hi: number; from: number; samples: { t: number; x: number }[];
};

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The element's current translateX in px, read from its computed transform (a running slide gives its in-between value). */
const translateXOf = (el: HTMLElement) => {
  const m = /matrix\(([^)]+)\)/.exec(window.getComputedStyle?.(el)?.transform ?? '');
  return m ? parseFloat(m[1].split(',')[4] ?? '') || 0 : 0;
};

/** The last pick of each segmented control, by its label. A control rebuilt on a pick reads it to resume the slide (resumeFrom). */
const lastPick = new Map<string, PickRecord>();
/** Milliseconds for pick timing; Date.now() where performance is missing. */
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function segmented<T extends string | number>(options: { value: T; label: string; icon?: HTMLElement; ariaLabel?: string }[], current: T | undefined, onPick: (v: T) => void, label: string) {
  const row = h('div', { class: 'segmented has-marker', role: 'radiogroup', 'aria-label': label });
  const marker = h('span', { class: 'segmented-marker', 'aria-hidden': 'true' });
  row.appendChild(marker);
  const buttons: HTMLButtonElement[] = [];
  let keyNav = false; // the last input was a key: the click it makes (rovingRadios calls click()) is instant
  let motionTimer = 0;
  let swallowClick = false; // a drag must not also pick the segment it ends on
  let drag: SegDrag | null = null;

  // sail: a pointer click slides the marker. snap: a drag release settles it. Keyboard changes carry neither class.
  const setMotion = (kind: 'sail' | 'snap' | null) => {
    window.clearTimeout(motionTimer);
    row.classList.remove('sail', 'snap');
    if (!kind) return;
    row.classList.add(kind);
    motionTimer = window.setTimeout(() => row.classList.remove(kind), kind === 'sail' ? 240 : 220);
  };
  // The marker is the selected button's own box, measured (offsetLeft/offsetWidth are physical, so rtl and buttons of unequal widths need nothing special).
  // It is measured again whenever the row or a button changes size: fonts loading, a resize, a label change, the row entering the page.
  let shown = -1;
  const measure = () => {
    const b = buttons[shown];
    if (!b || !row.isConnected) return;
    row.style.setProperty('--seg-x', `${b.offsetLeft}px`);
    row.style.setProperty('--seg-w', `${b.offsetWidth}px`);
  };
  const place = (index: number) => {
    shown = index;
    row.style.setProperty('--seg-i', String(index));
    measure();
  };

  for (const o of options) {
    const b = h('button', {
      class: o.value === current ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === current),
      'data-tip': o.icon ? o.label : undefined, 'aria-label': o.ariaLabel ?? o.label,
      onclick: (ev: MouseEvent) => {
        const pointer = ev.detail > 0 && !keyNav;
        const from = buttons.findIndex((x) => x.classList.contains('on'));
        for (const x of buttons) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', String(x === b));
        }
        const to = buttons.indexOf(b);
        // recorded before onPick, which may rebuild this control: the new row then resumes the slide from `from`
        lastPick.set(label, { from, to, at: clock(), kbd: !pointer });
        // the class that carries the transition is in place and flushed before the position changes, so the browser has a start value to slide from
        setMotion(pointer ? 'sail' : null);
        void row.offsetWidth;
        place(to);
        onPick(o.value);
      },
    }, o.icon ?? h('span', { class: 'seg-label' }, o.label));
    buttons.push(b);
    row.appendChild(b);
  }
  const currentIndex = options.findIndex((o) => o.value === current);
  // a control rebuilt on a pointer pick starts its marker where the pick left it, then slides to the new segment
  const resumed = typeof window.requestAnimationFrame === 'function' ? resumeFrom(lastPick.get(label), clock(), currentIndex) : null;
  if (resumed !== null) lastPick.delete(label); // one slide per pick: a second rebuild inside the window stays put
  shown = resumed ?? currentIndex;
  row.style.setProperty('--seg-i', String(shown));

  // an ellipsized text label gets its full text as the tooltip; icon options keep the label they were given as data-tip
  const syncTips = () => {
    for (const b of buttons) {
      const text = b.querySelector<HTMLElement>('.seg-label');
      if (!text) continue;
      if (text.scrollWidth > text.clientWidth) b.dataset.tip = text.textContent ?? '';
      else b.removeAttribute('data-tip');
    }
  };

  // the row is not in the page yet, so its direction and its labels are read once it is
  window.requestAnimationFrame?.(() => { measure(); syncTips(); });
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(() => { measure(); syncTips(); });
    watch.observe(row);
    for (const b of buttons) watch.observe(b);
  }
  void document.fonts?.ready.then(measure);

  if (resumed !== null) {
    window.requestAnimationFrame?.(() => {
      if (!row.isConnected) { place(currentIndex); return; }
      void row.offsetWidth; // the marker is painted on the old segment before the slide starts
      setMotion('sail');
      void row.offsetWidth;
      place(currentIndex);
    });
  }

  row.addEventListener('keydown', () => { keyNav = true; }, true);

  row.addEventListener('pointerdown', (e) => {
    keyNav = false;
    if (drag) return; // a second pointer does not take over a drag in progress
    const from = buttons.findIndex((b) => b.classList.contains('on'));
    if (e.button !== 0 || buttons.length < 2 || from < 0) return;
    const at = marker.getBoundingClientRect();
    if (e.clientX < at.left || e.clientX > at.right || e.clientY < at.top || e.clientY > at.bottom) return;
    // a slide still running: take the marker where it is on screen, never where it is headed
    const moving = row.classList.contains('sail') || row.classList.contains('snap');
    const tx = translateXOf(marker);
    if (moving) {
      setMotion(null);
      marker.style.transform = `translateX(${tx}px)`;
    }
    const left = marker.getBoundingClientRect().left;
    // the marker travels from the first button's left edge to the last button's right edge, px from the row's left edge
    const lo = Math.min(...buttons.map((b) => b.offsetLeft));
    const hi = Math.max(lo, Math.max(...buttons.map((b) => b.offsetLeft + b.offsetWidth)) - marker.offsetWidth);
    drag = {
      id: e.pointerId, startX: e.clientX, grab: e.clientX - left, rest: left - tx,
      threshold: e.pointerType === 'touch' ? 8 : 4, active: false,
      lo, hi, from, samples: [{ t: e.timeStamp, x: e.clientX }],
    };
  });

  row.addEventListener('pointermove', (e) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    d.samples = d.samples.filter((s) => s.t >= e.timeStamp - 160);
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < d.threshold) return;
      d.active = true;
      row.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
    }
    marker.style.transform = `translateX(${clampTo(e.clientX - d.grab - d.rest, d.lo, d.hi)}px)`;
  });

  const release = (e: PointerEvent) => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    row.classList.remove('dragging');
    if (!d.active) {
      // a press that froze a running slide but never became a drag: let the marker finish its slide
      if (marker.style.transform) {
        marker.style.transform = '';
        setMotion('snap');
      }
      return;
    }
    const box = row.getBoundingClientRect();
    // the snap follows the marker's centre, not the pointer, so a grab near one edge does not delay it
    const centreX = e.clientX - d.grab + marker.offsetWidth / 2 - box.left;
    const idx = projectTarget(centreX, releaseVelocity(d.samples, e.timeStamp), buttons.map((b) => b.offsetLeft + b.offsetWidth / 2));
    // the click handler moves --seg-i and the .on state, then onPick runs
    if (idx !== d.from) buttons[idx].click();
    marker.style.transform = '';
    setMotion('snap');
    swallowClick = true;
    window.setTimeout(() => { swallowClick = false; }, 0);
  };
  row.addEventListener('pointerup', release);
  row.addEventListener('pointercancel', release);
  row.addEventListener('lostpointercapture', release);

  row.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

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

/** What the page-zoom notice reads: the pinch scale (undefined without a visual viewport) and the device pixel ratio, and a watch for a change. */
export interface PageZoomEnv {
  reading: () => { visualScale: number | undefined; pixelRatio: number };
  loadPixelRatio: number;
  watch: (fn: () => void) => () => void;
  platform: string;
  storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } | null;
}

const PAGE_ZOOM_DISMISSED = 'tabula.pageZoomNoticeDismissed';

function browserPageZoomEnv(): PageZoomEnv {
  return {
    reading: () => ({ visualScale: window.visualViewport?.scale, pixelRatio: devicePixelRatioNow() }),
    loadPixelRatio: LOAD_PIXEL_RATIO,
    watch: (fn) => {
      const vv = window.visualViewport;
      vv?.addEventListener('resize', fn);
      window.addEventListener('resize', fn);
      return () => {
        vv?.removeEventListener('resize', fn);
        window.removeEventListener('resize', fn);
      };
    },
    platform: typeof navigator === 'undefined' ? '' : navigator.platform,
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  };
}

/**
 * A notice on the board when the page itself is zoomed (pinched, or zoomed in the browser), since the board's own zoom does not undo
 * that. Ctrl/Cmd+0 is named, in the platform's form. Dismissed for the session only (sessionStorage); otherwise it follows the zoom.
 */
export function mountPageZoomChip(host: HTMLElement, env: PageZoomEnv = browserPageZoomEnv()): () => void {
  let dismissed = false;
  try { dismissed = env.storage?.getItem(PAGE_ZOOM_DISMISSED) === '1'; } catch { dismissed = false; }
  const note = h('div', { class: 'page-zoom-note', role: 'status', hidden: true },
    h('span', { class: 'page-zoom-text' }, `Page is zoomed — press ${formatShortcutLabel('Ctrl/Cmd+0', env.platform)}`),
    h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss',
      onclick: () => {
        dismissed = true;
        try { env.storage?.setItem(PAGE_ZOOM_DISMISSED, '1'); } catch { /* the notice still goes away for this page */ }
        paint();
      },
    }, icon('close', 16)),
  );
  const paint = () => {
    const r = env.reading();
    note.hidden = dismissed || !pageIsZoomed(r.visualScale, r.pixelRatio, env.loadPixelRatio);
  };
  const stop = env.watch(paint);
  paint();
  host.appendChild(note);
  return () => {
    stop();
    note.remove();
  };
}
