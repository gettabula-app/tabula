import { h } from './dom';
import { dialog, field, toast } from './common';
import { rovingRadios } from './focus-scope';
import { api } from '../api';
import { authState, setSignedIn } from '../auth';
import { USER_COLORS, colorName } from '../palette';
import type { User } from '../types';

/**
 * The "Your name and colour" dialog, shared by the board menu and the account menu. A signed-in account's name is saved
 * to the account; the colour stays on this device. `onSaved` gets the person as saved, for whatever shows them (a board's cursor).
 */
export function openProfileDialog(current: User, onSaved: (saved: User) => void): void {
  const u = { ...current };
  const name = h('input', { class: 'input', value: u.name, 'aria-label': 'Your name', maxlength: '40' });
  const colors = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, ...USER_COLORS.map((c) => {
    const b = h('button', { class: `swatch${c === u.color ? ' on' : ''}`, style: `--c:${c}`, 'aria-label': colorName(c), role: 'radio', 'aria-checked': String(c === u.color), 'data-tip': colorName(c), onclick: () => {
      u.color = c;
      colors.querySelectorAll('.swatch').forEach((x) => {
        x.classList.remove('on');
        x.setAttribute('aria-checked', 'false');
      });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
    } });
    return b;
  }));
  rovingRadios(colors);
  const accountName = authState().mode === 'signed-in';
  dialog('Your name and colour', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, accountName
      ? 'Your name comes from your account and is shown next to your cursor and on the notes you write. The colour is stored on this device.'
      : 'Shown next to your cursor and on the notes you write.'),
    field('Name', name), field('Colour', colors),
  ), [{ label: 'Cancel' }, {
    label: 'Save', primary: true, onClick: async () => {
      const auth = authState();
      const typed = name.value.trim();
      if (auth.mode === 'signed-in' && typed && typed !== u.name) {
        try {
          const updated = await api.updateMe(typed);
          await setSignedIn({ ...auth.me, user: updated });
          u.name = updated.name;
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not save your name.');
          return false;
        }
      } else {
        u.name = typed || u.name;
      }
      onSaved(u);
    },
  }]);
}
