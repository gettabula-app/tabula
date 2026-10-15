// Dev-only demo page (segmented-demo.html). It mounts the real segmented() component with the app's stylesheet.
import './styles.css';
import './tracker/ui/tracker.css';
import { segmented } from './ui/common';
import { applyTheme } from './themes';

type Source = 'pointer' | 'keyboard' | 'none';
interface Option { value: string; label: string; icon?: HTMLElement; ariaLabel?: string }
interface Demo { id: string; title: string; initial: string; options: () => Option[]; width?: boolean; tracker?: boolean }

const THEMES = ['default', 'ayu', 'kanagawa', 'matrix', 'evergreen'];
const picks = new Map<string, { value: string; source: Source }>();
let lastInput: Source = 'none';

document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
document.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) throw new Error(`missing #${id}`);
  return el as T;
}

const SVG: Record<string, string> = {
  list: '<path d="M3 4h10M3 8h10M3 12h10"/>',
  grid: '<rect x="3" y="3" width="4" height="4" rx="1"/><rect x="9" y="3" width="4" height="4" rx="1"/><rect x="3" y="9" width="4" height="4" rx="1"/><rect x="9" y="9" width="4" height="4" rx="1"/>',
  board: '<rect x="2.5" y="3" width="3.5" height="10" rx="1"/><rect x="6.25" y="3" width="3.5" height="7" rx="1"/><rect x="10" y="3" width="3.5" height="5" rx="1"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  chart: '<path d="M3 13V8M8 13V4M13 13V7"/>',
};

function icon(name: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'seg-icon';
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;
  return span;
}

const ICON_SEGMENTS: [string, string][] = [['list', 'List'], ['grid', 'Grid'], ['board', 'Board'], ['calendar', 'Calendar'], ['chart', 'Chart']];

const DEMOS: Demo[] = [
  { id: 'a', title: 'A. Comments tabs', initial: 'open', options: () => [{ value: 'open', label: 'Open (0)' }, { value: 'resolved', label: 'Resolved (1)' }] },
  { id: 'b', title: 'B. Three segments', initial: 'centre', options: () => [{ value: 'left', label: 'Left' }, { value: 'centre', label: 'Centre' }, { value: 'right', label: 'Right' }] },
  {
    id: 'c', title: 'C. Five icon segments', initial: 'grid',
    options: () => ICON_SEGMENTS.map(([name, label]) => ({ value: name, label, icon: icon(name), ariaLabel: label })),
  },
  {
    id: 'd', title: 'D. Long labels in a 320px container', initial: 'all', width: true,
    options: () => [{ value: 'all', label: 'Everything in the workspace' }, { value: 'mine', label: 'Only mine' }, { value: 'recent', label: 'Recently updated boards and cards' }],
  },
  { id: 'e', title: 'E. Tracker switch', initial: 'my', tracker: true, options: () => [{ value: 'all', label: 'All' }, { value: 'my', label: 'My' }, { value: 'board', label: 'Board' }] },
];

function renderDemos(host: HTMLElement): void {
  host.replaceChildren(...DEMOS.map((d) => {
    const section = document.createElement('section');
    section.className = 'demo';
    const title = document.createElement('h2');
    title.textContent = d.title;
    const status = document.createElement('p');
    status.className = 'status';
    const show = () => {
      const p = picks.get(d.id);
      status.textContent = p ? `Last pick: ${p.value} (${p.source})` : 'No pick yet';
    };
    const control = segmented(d.options(), picks.get(d.id)?.value ?? d.initial, (v) => {
      picks.set(d.id, { value: v, source: lastInput });
      show();
    }, d.title);
    show();
    const surface = document.createElement('div');
    surface.className = d.width ? 'tray-surface w320' : 'tray-surface';
    if (d.tracker) {
      const card = document.createElement('div');
      card.className = 'trk trk-element tracker-card';
      const switchBox = document.createElement('div');
      switchBox.className = 'trk-element-switch';
      switchBox.append(control);
      card.append(switchBox);
      surface.append(card);
    } else {
      surface.append(control);
    }
    section.append(title, surface, status);
    return section;
  }));
}

const themeBar = byId<HTMLElement>('themes');
function markTheme(id: string): void {
  for (const b of themeBar.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.theme === id));
}
for (const id of THEMES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.theme = id;
  b.textContent = id;
  b.addEventListener('click', () => {
    applyTheme(id);
    markTheme(id);
  });
  themeBar.append(b);
}
applyTheme('default');
markTheme('default');

const dirButton = byId<HTMLButtonElement>('dir');
const demos = byId<HTMLElement>('demos');
let rtl = false;
function setDir(): void {
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  dirButton.textContent = `dir=${rtl ? 'rtl' : 'ltr'}`;
  dirButton.setAttribute('aria-pressed', String(rtl));
  renderDemos(demos);
}
dirButton.addEventListener('click', () => {
  rtl = !rtl;
  setDir();
});
setDir();
