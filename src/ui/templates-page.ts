import './home.css';
import { h } from './dom';
import { newId } from '../store';
import { TEMPLATES, type TemplateDef } from '../templates';
import type { AuthState } from '../auth';
import type { HomeNav } from './home';
import { createWorkspaceBanner } from './workspace';
import { accountMe, createTopbar, pageFooter, searchField } from './topbar';

const CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];
/** Null is the All filter. */
const FILTERS: (string | null)[] = [null, ...CATEGORIES];

/** Opens a new board from a template; the cards on the home strip and on the templates page both start here. */
export function useTemplate(nav: HomeNav, id: string): void {
  nav.open(newId(), { template: id });
}

/** One template from each of the first categories: the short list on the home page. */
export function featuredTemplates(count = 4): TemplateDef[] {
  return CATEGORIES.slice(0, count).flatMap((category) => TEMPLATES.find((t) => t.category === category) ?? []);
}

const matches = (t: TemplateDef, query: string) =>
  !query || `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(query);

/** Every template with a category filter and a search box. */
export function renderTemplates(root: HTMLElement, nav: HomeNav, auth: AuthState = { mode: 'open' }): void {
  document.title = 'Templates - Mira';
  const me = accountMe(auth);
  const down = auth.mode === 'offline';
  let category: string | null = null;
  let query = '';

  const grid = h('ul', { class: 'tpl-grid', 'aria-label': 'Templates' });
  const count = h('p', { class: 'tpl-count', 'aria-live': 'polite' });
  const empty = h('p', { class: 'home-empty' }, 'No templates match.');
  const chips = FILTERS.map((c) => h('button', {
    class: 'tpl-chip', 'aria-pressed': 'false', onclick: () => {
      category = c;
      paint();
    },
  }, c ?? 'All'));

  const paint = () => {
    const q = query.trim().toLowerCase();
    const shown = TEMPLATES.filter((t) => (category === null || t.category === category) && matches(t, q));
    chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(FILTERS[i] === category)));
    count.textContent = `${shown.length} ${shown.length === 1 ? 'template' : 'templates'}`;
    grid.replaceChildren(...shown.map((t) => h('li', null,
      h('article', { class: 'tpl-card' },
        h('p', { class: 'tpl-label' }, t.category),
        h('h2', { class: 'tpl-title' }, t.name),
        h('p', { class: 'tpl-text' }, t.description),
        h('button', {
          class: 'btn', disabled: down, 'aria-label': `Use template ${t.name}`, onclick: () => useTemplate(nav, t.id),
        }, 'Use template')))));
    empty.hidden = shown.length > 0;
  };

  const banner = me ? createWorkspaceBanner() : null;
  root.replaceChildren(...(banner ? [banner.el] : []), h('div', { class: 'home-page' },
    createTopbar('templates', me),
    h('main', { class: 'home' },
      h('header', { class: 'home-head' },
        h('h1', { class: 'home-title' }, 'Templates'),
        h('p', { class: 'home-lede' }, 'Ready-made boards for team exercises. Pick one to open it as a new board.'),
        down ? h('p', { class: 'home-note', role: 'status' }, 'You are offline. Starting a board from a template needs the server.') : null,
        h('div', { class: 'tpl-toolbar' },
          h('div', { class: 'tpl-chips', role: 'group', 'aria-label': 'Filter by category' }, chips),
          searchField('Search templates', query, (value) => {
            query = value;
            paint();
          }))),
      h('section', { class: 'tpl-results' }, count, grid, empty),
      pageFooter(me ? 'Boards sync through your workspace server when it is reachable.' : 'Boards are stored in this browser.'))));
  paint();
}
