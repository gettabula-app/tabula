import { h, icon } from './dom';
import { popover } from './common';
import { SYSTEM, fontFamily, getCatalogue, loadCatalogue, previewFont, type FontEntry } from '../fonts';

/** Searchable Fontshare picker. Rows preview in their own face as they scroll into view. */
export function openFontPicker(anchor: HTMLElement, current: string | undefined, onPick: (slug: string) => void, opts: { pinned?: string[] } = {}) {
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search Fontshare fonts', 'aria-label': 'Search fonts' });
  const cats = h('div', { class: 'chips' });
  const list = h('div', { class: 'font-list', role: 'listbox', 'aria-label': 'Fonts' });
  const count = h('div', { class: 'muted small' });
  let cat = 'All';

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const slug = (e.target as HTMLElement).dataset.slug!;
      previewFont(slug);
      io.unobserve(e.target);
    }
  }, { root: list, rootMargin: '120px' });

  const row = (f: FontEntry | null) => {
    const slug = f?.slug ?? SYSTEM;
    const name = f?.name ?? 'System font';
    const el = h('button', {
      class: `font-row${slug === current ? ' on' : ''}`, role: 'option', 'aria-selected': String(slug === current),
      onclick: () => {
        onPick(slug);
        pop.close();
      },
    },
    h('span', { class: 'font-name', style: `font-family:${fontFamily(slug)}` }, name),
    h('span', { class: 'font-meta' }, f ? `${f.category}${f.variable ? ', variable' : ''}` : 'Your device'),
    slug === current ? icon('check', 16) : null);
    el.dataset.slug = slug;
    if (f) io.observe(el);
    return el;
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const all = getCatalogue();
    const categories = ['All', ...new Set(all.map((f) => f.category))].slice(0, 8);
    cats.replaceChildren(...categories.map((c) => h('button', { class: `chip${c === cat ? ' on' : ''}`, onclick: () => { cat = c; render(); } }, c)));
    const filtered = all.filter((f) => (cat === 'All' || f.category === cat) && (!q || f.name.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q))));
    const pinned = (opts.pinned ?? []).map((s) => all.find((f) => f.slug === s)).filter(Boolean) as FontEntry[];
    const rest = filtered.filter((f) => !pinned.includes(f));
    const children: HTMLElement[] = [];
    if (!q && cat === 'All') {
      if (pinned.length) {
        children.push(h('div', { class: 'list-label' }, 'On this board'));
        pinned.forEach((f) => children.push(row(f)));
        children.push(h('div', { class: 'list-label' }, 'All fonts'));
      }
      children.push(row(null));
    }
    rest.forEach((f) => children.push(row(f)));
    if (!children.length) children.push(h('div', { class: 'empty' }, 'No fonts match. Try another name or category.'));
    list.replaceChildren(...children);
    count.textContent = `${all.length} Fontshare families. Fonts load from Fontshare and are cached on this device for offline use.`;
  };
  search.addEventListener('input', render);

  const pop = popover(anchor, h('div', { class: 'font-picker' },
    h('div', { class: 'pop-head' }, h('h3', null, 'Font')),
    search, cats, list, h('div', { class: 'pop-foot' }, count)), { side: 'left', onClose: () => io.disconnect() });
  render();
  requestAnimationFrame(() => search.focus());
  loadCatalogue().then(() => {
    render();
    pop.place();
  });
}
