// TAB-375 slice 2 demo: the Boards home cards, list, sections, first-run welcome and the New board menu, on seed data. Dev only:
// boards-cards-demo.html at the repo root, which the production build does not bundle. Nothing here talks to the server.
import './styles.css';
import './ui/home.css';
import './ui/home-presence.css';
import { applyTheme, THEMES } from './themes';
import { closePopover, popover, segmented, toast } from './ui/common';
import { h } from './ui/dom';
import { USER_COLORS } from './palette';
import { boardCardSkeleton, templateCard, type BoardCardData, type TemplateCardData } from './ui/board-card';
import { boardsToolbar, loadPreviews, loadView, renderBoardSections, type BoardSection, type BoardView } from './ui/boards-cards-view';
import type { PreviewModel, PreviewShape, PreviewStyle, PreviewType } from './ui/board-preview';

type DemoState = 'normal' | 'loading' | 'empty-team' | 'few' | 'first-run' | 'previews-off';

const STATES: { value: DemoState; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'loading', label: 'Loading' },
  { value: 'empty-team', label: 'Empty team' },
  { value: 'few', label: 'Few boards' },
  { value: 'first-run', label: 'First run' },
  { value: 'previews-off', label: 'Previews off' },
];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => Date.now() - ms;
const box = (t: PreviewType, x: number, y: number, w: number, ht: number, extra: { fill?: string; name?: string } = {}): PreviewShape => ({ t, x, y, w, h: ht, ...extra });
const drawing = (shapes: PreviewShape[]): PreviewModel => ({ shapes });

// Preview models: what the server would store for each kind of board (frame and container names, sticky colours, shapes).
function kanban(): PreviewModel {
  const shapes: PreviewShape[] = [];
  ['To do', 'Doing', 'Done'].forEach((name, c) => {
    const x = c * 340;
    shapes.push(box('lane', x, 0, 320, 560, { name }));
    for (let r = 0; r < (c === 2 ? 3 : 2); r++) shapes.push(box('card', x + 24, 80 + r * 150, 272, 120));
  });
  return drawing(shapes);
}

function stickies(left = 'Went well', right = 'To improve'): PreviewModel {
  const shapes = [box('frame', 0, 0, 600, 620, { name: left }), box('frame', 640, 0, 600, 620, { name: right })];
  const spots: [number, number][] = [[40, 90], [260, 90], [40, 310], [260, 310], [680, 90], [900, 90], [680, 310]];
  const fills = ['yellow', 'pink', 'teal', 'blue', 'orange', 'violet', 'green'];
  fills.forEach((fill, i) => shapes.push(box('sticky', spots[i][0], spots[i][1], 180, 180, { fill })));
  return drawing(shapes);
}

function mind(): PreviewModel {
  const shapes = [box('shape', 400, 280, 200, 120, { fill: 'yellow' })];
  const kids: [number, number, string][] = [[80, 60, 'pink'], [80, 420, 'teal'], [700, 40, 'blue'], [700, 460, 'violet'], [30, 240, 'green'], [730, 240, 'orange']];
  for (const [x, y, fill] of kids) shapes.push(box('shape', x, y, 160, 100, { fill }));
  shapes.push(box('text', 400, 430, 200, 24));
  return drawing(shapes);
}

function frames(first = 'Intro'): PreviewModel {
  return drawing([
    box('frame', 0, 0, 400, 300, { name: first }),
    box('frame', 440, 0, 400, 300, { name: 'Flow' }),
    box('frame', 0, 340, 840, 260, { name: 'Notes' }),
    box('sticky', 40, 80, 150, 150, { fill: 'yellow' }),
    box('sticky', 220, 80, 150, 150, { fill: 'pink' }),
    box('sticky', 480, 80, 150, 150, { fill: 'blue' }),
    box('sticky', 660, 80, 150, 150, { fill: 'teal' }),
    box('sticky', 480, 240, 150, 150, { fill: 'green' }),
    box('sticky', 40, 390, 150, 150, { fill: 'orange' }),
    box('sticky', 220, 390, 150, 150, { fill: 'violet' }),
  ]);
}

function table(): PreviewModel {
  const shapes = [box('container', 0, 0, 840, 560, { name: 'Plans' }), box('image', 660, 60, 160, 100)];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) shapes.push(box('text', 40 + c * 260, 60 + r * 90, 180 - c * 30, 24));
  return drawing(shapes);
}

function lanes(names: string[], per: number, fills: string[]): PreviewModel {
  const shapes: PreviewShape[] = [];
  names.forEach((name, c) => {
    const x = c * 340;
    shapes.push(box('lane', x, 0, 320, 560, { name }));
    for (let r = 0; r < per; r++) shapes.push(box('sticky', x + 30 + (r % 2) * 150, 80 + Math.floor(r / 2) * 180, 140, 140, { fill: fills[(c * per + r) % fills.length] }));
  });
  return drawing(shapes);
}

function quadrants(): PreviewModel {
  const names = ['Quick wins', 'Big bets', 'Fill-ins', 'Money pits'];
  const shapes = names.map((name, i) => box('frame', (i % 2) * 440, Math.floor(i / 2) * 340, 400, 300, { name }));
  names.forEach((_, i) => {
    const x = (i % 2) * 440;
    const y = Math.floor(i / 2) * 340;
    shapes.push(box('sticky', x + 40, y + 80, 150, 150, { fill: 'yellow' }), box('sticky', x + 220, y + 80, 150, 150, { fill: 'teal' }));
  });
  return drawing(shapes);
}

const TEAMS = [{ id: 'design', name: 'Design team' }, { id: 'retro', name: 'Retro team' }, { id: 'growth', name: 'Growth team' }];
const MAJA = { initials: 'MJ', color: USER_COLORS[0] };
const OMAR = { initials: 'OM', color: USER_COLORS[1] };
const LIN = { initials: 'LL', color: USER_COLORS[2] };
const BEN = { initials: 'BN', color: USER_COLORS[3] };
const EVA = { initials: 'EV', color: USER_COLORS[4] };

// Seed boards: names from the Johan examples (long, CJK, emoji, unbroken), people from the palette, times relative to now.
const DESIGN: BoardCardData[] = [
  { id: 'q4-roadmap', name: 'Q4 roadmap', editedBy: { name: 'Maja' }, updatedAt: ago(12 * MIN), here: [MAJA, OMAR, LIN], hereMore: 2, unread: 4, preview: kanban() },
  { id: 'onboarding', name: 'Onboarding flow, version two with the new welcome screens', updatedAt: ago(26 * 60 * MIN), preview: frames('Welcome') },
  { id: 'q4-jp', name: '第四季度产品路线图', editedBy: { name: 'Claude', agent: true }, updatedAt: ago(5 * MIN), preview: stickies('Goals', 'Risks') },
  { id: 'interviews', name: 'Customer interviews', editedBy: { name: 'Eva' }, updatedAt: ago(120 * MIN), preview: mind() },
  { id: 'pricing', name: 'Pricing experiments', editedBy: { name: 'Ben' }, updatedAt: ago(3 * DAY), preview: table() },
  { id: 'workshop', name: 'Workshop 5 Nov', updatedAt: ago(5 * DAY), preview: drawing([]) },
];
const RETRO: BoardCardData[] = [
  { id: 'sprint-retro', name: 'Sprint retro', editedBy: { name: 'Omar' }, updatedAt: ago(2 * 60 * MIN), here: [BEN, EVA], preview: stickies() },
];
const PERSONAL: BoardCardData[] = [
  { id: 'launch', name: '🚀 Launch plan', updatedAt: ago(40 * MIN), preview: stickies('Now', 'Next') },
  { id: 'unbroken', name: 'Q4-roadmap-with-no-spaces-at-all-in-this-very-long-board-name-for-the-test', editedBy: { name: 'You' }, updatedAt: ago(DAY), preview: table() },
  { id: 'ideas', name: 'Ideas', editedBy: { name: 'You' }, updatedAt: ago(3 * DAY), preview: mind() },
];
const SHARED: BoardCardData[] = [
  { id: 'launch-review', name: 'Launch review', role: 'viewer', editedBy: { name: 'Lin' }, updatedAt: ago(40 * MIN), preview: frames('Intro') },
  { id: 'all-hands', name: 'Quarterly all-hands notes', role: 'viewer', updatedAt: ago(6 * DAY), preview: table() },
];

// Template seeds for the first-run welcome: the same card as a board, one link that creates it.
const TEMPLATES: TemplateCardData[] = [
  { id: 'start-stop-continue', name: 'Start / Stop / Continue', description: 'Three lanes for what to start, stop and keep doing.', category: 'Retro', tone: 'yellow', preview: lanes(['Start', 'Stop', 'Continue'], 2, ['yellow', 'teal', 'pink']) },
  { id: 'sprint-board', name: 'Sprint board', description: 'To do, doing and done, with a card for each item.', category: 'Planning', tone: 'blue', preview: kanban() },
  { id: 'lean-coffee', name: 'Lean coffee', description: 'Topics to vote on, then discuss one at a time.', category: 'Meeting', tone: 'green', preview: frames('Topics') },
  { id: 'mind-map', name: 'Mind map', description: 'One idea in the middle, branches around it.', category: 'Ideas', preview: mind() },
  { id: 'impact-effort', name: 'Impact / Effort', description: 'Sort ideas into four quadrants by impact and effort.', category: 'Planning', tone: 'blue', preview: quadrants() },
  { id: 'blank', name: 'Blank board', description: 'Start from an empty canvas.', category: 'Blank', blank: true },
];

function sectionsFor(state: DemoState, query: string): BoardSection[] {
  const q = query.trim().toLocaleLowerCase();
  const sec = (id: string, title: string, kind: BoardSection['kind'], boards: BoardCardData[], admin = false): BoardSection => ({
    id, title, kind, admin, boards: boards.filter((b) => q === '' || b.name.toLocaleLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt),
  });
  const sections = state === 'first-run'
    ? [sec('personal', 'Personal', 'personal', [])]
    : [
      sec('design', 'Design team', 'team', state === 'empty-team' ? [] : state === 'few' ? DESIGN.slice(0, 2) : DESIGN, true),
      sec('retro', 'Retro team', 'team', RETRO),
      sec('growth', 'Growth team', 'team', []),
      sec('personal', 'Personal', 'personal', state === 'few' ? PERSONAL.slice(0, 1) : PERSONAL),
      sec('shared', 'Shared with you', 'shared', state === 'few' ? SHARED.slice(0, 1) : SHARED),
    ];
  return q === '' ? sections : sections.filter((s) => s.boards.length > 0);
}

function welcome(previews: boolean, tile: PreviewStyle, onHide: () => void): HTMLElement {
  return h('section', { class: 'bc-group bc-welcome', 'aria-labelledby': 'bc-welcome-title' },
    h('div', { class: 'bc-welcome-head' },
      h('h2', { class: 'home-title', id: 'bc-welcome-title' }, 'Start your first board'),
      h('button', { class: 'link-more', type: 'button', 'aria-label': 'Hide the template suggestions', onclick: onHide }, 'Hide')),
    h('p', { class: 'bc-welcome-lede' }, 'Pick a starting point, or begin with a blank board.'),
    h('ul', { class: 'bc-grid' }, ...TEMPLATES.map((t) => templateCard(t, { tile, previews, onCreate: (d) => toast(`New board from “${d.name}”`) }))),
    h('div', { class: 'bc-skip' }, h('button', { class: 'link-more', type: 'button', onclick: () => toast('Blank board') }, 'Skip, start with a blank board')));
}

function loadingSections(): HTMLElement[] {
  const block = (n: number, id: string) => h('section', { class: 'bc-group', 'aria-busy': 'true', 'aria-labelledby': id },
    h('div', { class: 'group-head' }, h('h2', { id }, h('i', { class: 'bc-skel-line', 'aria-hidden': 'true', style: 'width: 140px; height: 20px' }))),
    h('ul', { class: 'bc-grid' }, ...Array.from({ length: n }, () => boardCardSkeleton())));
  return [block(6, 'bc-load-design'), block(3, 'bc-load-personal')];
}

function openNewMenu(anchor: HTMLElement): void {
  const item = (label: string, message: string) => h('button', {
    class: 'menu-item', type: 'button', role: 'menuitem',
    onclick: () => {
      closePopover();
      toast(message);
    },
  }, label);
  const list = h('div', { class: 'bc-menu-items' },
    item('Blank board', 'Blank board'),
    item('From a template…', 'Opens the templates page'),
    item('Import a file…', 'Opens the import dialog'));
  popover(anchor, list, { role: 'menu', className: 'bc-menu menu', label: 'New board' });
}

applyTheme('default');
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('boards-cards-demo: #app is missing');

let state: DemoState = 'normal';
let view: BoardView = loadView();
let tile: PreviewStyle = 'tint';
let previews = loadPreviews();
let query = '';
let templatesHidden = false;

const welcomeHost = h('div');
const sectionsHost = h('div');

const previewRow = boardsToolbar({
  view,
  previews,
  onView: (next) => {
    view = next;
    render();
  },
  onPreviews: (on) => {
    previews = on;
    render();
  },
});
const previewInput = previewRow.querySelector<HTMLInputElement>('input[role="switch"]');

const searchInput = h('input', {
  class: 'input', type: 'search', placeholder: 'Search boards', 'aria-label': 'Search boards',
  oninput: () => {
    query = searchInput.value;
    render();
  },
});
const newButton: HTMLButtonElement = h('button', { class: 'btn primary', type: 'button', 'aria-haspopup': 'menu', onclick: () => openNewMenu(newButton) }, 'New board');
const tileRow = segmented<PreviewStyle>([
  { value: 'outline', label: 'Outline' },
  { value: 'tint', label: 'Tint' },
  { value: 'dots', label: 'Dots' },
], tile, (next) => {
  tile = next;
  render();
}, 'Tile style');
const stateRow = segmented<DemoState>(STATES, state, (next) => {
  state = next;
  templatesHidden = false;
  previews = next === 'previews-off' ? false : loadPreviews();
  if (previewInput) previewInput.checked = previews;
  render();
}, 'Demo state');
const themeRow = segmented<string>(THEMES.map((t) => ({ value: t.id, label: t.name })), 'default', (id) => applyTheme(id), 'Theme');

function render(): void {
  if (state === 'loading') {
    welcomeHost.replaceChildren();
    sectionsHost.replaceChildren(...loadingSections());
    return;
  }
  const showWelcome = state === 'first-run' && !templatesHidden;
  welcomeHost.replaceChildren(...(showWelcome ? [welcome(previews, tile, () => {
    templatesHidden = true;
    render();
  })] : []));
  renderBoardSections(sectionsHost, showWelcome ? [] : sectionsFor(state, query), {
    view,
    tile,
    previews,
    teams: TEAMS,
    onNew: (section) => toast(`New board in ${section.title}`),
    onAction: (action, data) => toast(`${action}: ${data.name}`),
    onMove: (to, data) => toast(`Move “${data.name}” to ${to.name}`),
  });
}

root.replaceChildren(h('div', { class: 'home-root' },
  h('main', { class: 'home home-page', style: 'gap: 20px' },
    h('div', { class: 'bc-toolbar', style: 'justify-content: space-between' }, h('h1', { class: 'home-title' }, 'Boards'), themeRow),
    h('div', { class: 'bc-toolbar' }, h('div', { class: 'bc-search' }, searchInput), newButton),
    h('div', { class: 'bc-toolbar' }, previewRow, tileRow),
    h('div', { class: 'bc-toolbar' }, stateRow),
    welcomeHost,
    sectionsHost)));
render();
