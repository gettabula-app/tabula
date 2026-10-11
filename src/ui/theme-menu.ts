import { h, icon } from './dom';
import { rovingRadios } from './focus-scope';
import { THEMES, getStoredTheme, setTheme } from '../themes';

/**
 * The Theme radio group of the board menu and the tracker menu: one row per theme with its preview, the current one checked,
 * a change applied at once and remembered by setTheme.
 */
export function themeRadioGroup(): HTMLElement {
  const rows = THEMES.map((t) => {
    const check = h('span', { class: 'theme-check' });
    const row = h('button', { class: 'menu-item theme-item', type: 'button', role: 'radio', 'aria-checked': 'false', onclick: () => { setTheme(t.id); paint(); } },
      h('div', { class: 'theme-preview', 'aria-hidden': 'true', style: `--c:${t.vars['--canvas']};--t:${t.vars['--tray']};--a:${t.vars['--signal']}` }),
      h('span', null, t.name),
      check);
    return { id: t.id, row, check };
  });
  const paint = () => {
    const current = getStoredTheme();
    for (const r of rows) {
      const on = r.id === current;
      r.row.setAttribute('aria-checked', String(on));
      r.check.replaceChildren(on ? icon('check', 16) : '');
    }
  };
  paint();
  const group = h('div', { role: 'radiogroup', 'aria-label': 'Theme' }, rows.map((r) => r.row));
  rovingRadios(group);
  return group;
}
