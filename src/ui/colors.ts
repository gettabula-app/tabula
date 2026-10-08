import type { BoardApp } from '../app';
import { h, icon } from './dom';
import { normalizeHex } from '../palette';

/**
 * Sticky colour chooser: the default colours, the board's custom colours, and a
 * "+" that opens the system colour picker for any colour. `onLive` previews while
 * the picker is open; `onPick` commits (and the colour joins the board palette).
 */
export function stickyColorField(app: BoardApp, current: string | undefined, onPick: (c: string) => void, opts: { onLive?: (c: string) => void; label?: string; size?: 'sm' | 'lg' } = {}) {
  const cur = current ? normalizeHex(current) : undefined;
  const row = h('div', { class: `swatches sticky-swatches${opts.size === 'lg' ? ' lg' : ''}`, role: 'radiogroup', 'aria-label': opts.label ?? 'Sticky colour' });
  const palette = app.stickyPalette();
  for (const c of palette) {
    const on = cur === normalizeHex(c.value);
    row.appendChild(h('button', {
      class: `swatch sticky-swatch${on ? ' on' : ''}`, style: `--c:${c.value}`, title: c.name, 'aria-label': c.name,
      role: 'radio', 'aria-checked': String(on), onclick: () => onPick(c.value),
    }, h('span', { class: 'note', 'aria-hidden': 'true' })));
  }
  const isCustom = !!cur && !palette.some((c) => normalizeHex(c.value) === cur);
  const input = h('input', { type: 'color', value: cur ?? '#FFE16B', 'aria-label': 'Choose any colour', tabindex: '-1' });
  const add = h('label', {
    class: `swatch add${isCustom ? ' on' : ''}`, title: 'Any colour', style: isCustom ? `--c:${cur}` : undefined, tabindex: '0', role: 'button',
    'aria-label': 'Choose any colour',
  }, icon('plus', 14), input);
  add.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  let frame = 0;
  input.addEventListener('input', () => {
    add.style.setProperty('--c', input.value);
    add.classList.add('on');
    if (!opts.onLive) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => opts.onLive!(normalizeHex(input.value)));
  });
  input.addEventListener('change', () => {
    const c = normalizeHex(input.value);
    app.addStickyColor(c);
    onPick(c);
  });
  row.appendChild(add);
  return row;
}
