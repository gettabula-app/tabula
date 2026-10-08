import { failureMessage, failureOf, iconSets, type IconSet } from '../icons';
import { dialog } from './common';
import { h } from './dom';

const GROUPS: { tier: IconSet['tier']; title: string; note: string; open?: true }[] = [
  { tier: 'attribution', title: 'Credit the author', note: 'CC BY: credit the author, link the licence and say if you changed the icons when you publish them.', open: true },
  { tier: 'notice', title: 'Keep the notice', note: 'MIT, ISC, Apache-2.0, BSD and OFL-1.1: keep the copyright and licence notice with copies of the icons.' },
  { tier: 'public', title: 'Public domain', note: 'CC0, Unlicense and 0BSD: no conditions.' },
];

const link = (text: string, url?: string) => (url && /^https?:\/\//.test(url)
  ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text)
  : text);

/** The dialog that credits every icon set Tabula hosts, grouped by what its licence asks for. */
export function openIconCredits() {
  const body = h('div', { class: 'credits' }, h('p', { class: 'muted small', role: 'status' }, 'Loading…'));
  dialog('Icon credits', body, [{ label: 'Close', primary: true }]);
  iconSets().then((sets) => {
    const all = Object.values(sets);
    body.replaceChildren(
      h('p', { class: 'muted small' }, `Tabula hosts ${all.length} icon sets itself. Each keeps the licence its authors chose. Placed icons are copies stored in your board. `, link('Plain-text list', '/icons/LICENSES.txt'), '.'),
      h('p', { class: 'muted small' }, 'Logos and brand marks in the logo sets remain trademarks of their owners. The licence covers the artwork, not the right to use a mark.'),
      ...GROUPS.flatMap((g) => {
        const list = all.filter((s) => s.tier === g.tier).sort((a, b) => a.name.localeCompare(b.name));
        return list.length ? [h('details', { open: g.open }, h('summary', null, `${g.title} (${list.length})`), h('p', { class: 'muted small' }, g.note),
          h('ul', null, ...list.map((s) => h('li', null, s.name, s.logos ? ' (logos)' : '', ': ', link(s.license, s.licenseUrl), s.author ? [' · ', link(s.author, s.authorUrl)] : null))))] : [];
      }),
    );
  }).catch((e) => body.replaceChildren(h('p', { class: 'muted', role: 'alert' }, failureMessage(failureOf(e)))));
}
