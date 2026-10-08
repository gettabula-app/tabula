import { h, icon } from './dom';

let openPop: { el: HTMLElement; close: () => void } | null = null;

/** Floating panel anchored to an element; closes on outside click or Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { side?: 'right' | 'bottom' | 'top' | 'left'; className?: string; onClose?: () => void } = {}) {
  closePopover();
  const el = h('div', { class: `popover tray ${opts.className ?? ''}`, role: 'dialog' }, content);
  document.body.appendChild(el);
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const side = opts.side ?? 'bottom';
    let x = a.left, y = a.bottom + 8;
    if (side === 'right') { x = a.right + 10; y = a.top; }
    if (side === 'left') { x = a.left - r.width - 10; y = a.top; }
    if (side === 'top') { x = a.left + a.width / 2 - r.width / 2; y = a.top - r.height - 10; }
    x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - r.height - 8, y));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  place();
  requestAnimationFrame(place);
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    el.remove();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    if (openPop?.el === el) openPop = null;
    opts.onClose?.();
  };
  setTimeout(() => window.addEventListener('pointerdown', onDown, true));
  window.addEventListener('keydown', onKey, true);
  openPop = { el, close };
  return { el, close, place };
}

export function closePopover() {
  openPop?.close();
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

/** Open dialogs, oldest first: Escape closes only the last one. */
const openDialogs: object[] = [];

/** Modal dialog. Resolves when closed. */
export function dialog(title: string, body: HTMLElement, actions: { label: string; primary?: boolean; onClick?: () => void | boolean | Promise<void | boolean> }[] = []) {
  const back = h('div', { class: 'modal-back' });
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('close', 18));
  const box = h('div', { class: 'modal tray', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn),
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && openDialogs[openDialogs.length - 1] === self) close();
  };
  window.addEventListener('keydown', onKey);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  function close() {
    window.removeEventListener('keydown', onKey);
    const i = openDialogs.indexOf(self);
    if (i >= 0) openDialogs.splice(i, 1);
    back.remove();
  }
  requestAnimationFrame(() => (box.querySelector('input, textarea, button.primary') as HTMLElement | null)?.focus());
  return { close, box };
}

export function swatches(colors: { name: string; value: string }[], current: string | undefined, onPick: (v: string) => void, opts: { label: string }) {
  const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': opts.label });
  const buttons: HTMLButtonElement[] = [];
  for (const c of colors) {
    const b = h('button', {
      class: `swatch${c.value === 'none' ? ' none' : ''}${current?.toLowerCase() === c.value.toLowerCase() ? ' on' : ''}`,
      title: c.name, 'aria-label': c.name, role: 'radio', 'aria-checked': String(current?.toLowerCase() === c.value.toLowerCase()),
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
  return row;
}

export function segmented<T extends string | number>(options: { value: T; label: string; icon?: HTMLElement }[], current: T | undefined, onPick: (v: T) => void, label: string) {
  const row = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const buttons: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = h('button', {
      class: o.value === current ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === current),
      title: o.label, 'aria-label': o.label,
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
