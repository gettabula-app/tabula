import type { Me } from '../../api';
import { openTrackerMenu } from './account-menu';
import './tracker.css';
import { closePopover, dialog, popover, segmented, toast } from '../../ui/common';
import { h, icon } from '../../ui/dom';
import { kbdHint } from '../../ui/kbd';
import { TrackerError, type TrackerFacets, type TrackerListQuery, type TrackerMeta, type TrackerPriority, type TrackerSortField, type TrackerState, type TrackerTicket, type TrackerView } from '../../tracker-types';
import type { TrackerApi, TrackerStore } from '../../tracker-data';
import { build, parse, type FilterChip } from './filter';
import { createFilterBar, type FilterBarController } from './filter-bar';
import { avatar, keyChip, labelChip, relativeTime, dueChip, formatTrackerDate } from './primitives';
import { priorityGlyph, priorityLabel, stateGlyph } from './glyphs';
import { buildListModel, moveCursor, moveCursorTo, selectAll, toggleSelection, extendSelection, type ListFacets, type ListGroupBy, type ListRenderModel, type ListSortPlan, type TrackerRow } from './list-model';
import { buildCommandItems, openCommandBox, type CommandItem } from './command-box';
import { isNativeActivationTarget, resolveKey, SHORTCUTS, type KeyboardLayer, type TrackerAction } from './keys';
import { openPicker, type PickerResult } from './picker';
import { autoScrollDelta, AUTO_SCROLL_EDGE_PX, clipRect, DRAG_THRESHOLD_PX, laneAtPoint, laneWidthFor, LONG_PRESS_MS, scaleOf, type BoardLane, type BoardPoint } from './board-drag';
import { openNewIssueDialog } from './new-issue';
import { publishTrackerSnapshot } from './frame-snapshot';
import { mountTicketPage } from './ticket-page';
import { mountInbox } from './inbox';
import { renderSnippet } from './snippet';
import { trackerErrorField } from './error-path';
import { buildTrackerPath } from '../../tracker-route';
import { trackerPeekAllowed } from './peek-rule';

const TABS: ReadonlyArray<{ id: TrackerView; label: string; shortLabel: string; glyph: string }> = [
  { id: 'inbox', label: 'Inbox', shortLabel: 'Inbox', glyph: '◉' },
  { id: 'my', label: 'My issues', shortLabel: 'Mine', glyph: '◎' },
  { id: 'all', label: 'All issues', shortLabel: 'All', glyph: '≡' },
  { id: 'board', label: 'Board', shortLabel: 'Board', glyph: '▦' },
  { id: 'projects', label: 'Projects', shortLabel: 'Projects', glyph: '▤' },
];
const GROUPS: Array<{ value: ListGroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' }, { value: 'state', label: 'State' }, { value: 'assignee', label: 'Assignee' },
  { value: 'project', label: 'Project' }, { value: 'priority', label: 'Priority' }, { value: 'label', label: 'Label' },
  { value: 'milestone', label: 'Milestone' }, { value: 'due-week', label: 'Due week' },
];
const SORTS: Array<{ value: TrackerSortField; label: string }> = [
  { value: 'updatedAt', label: 'Updated' }, { value: 'createdAt', label: 'Created' }, { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due date' }, { value: 'title', label: 'Title' }, { value: 'key', label: 'Key' },
];
const REQUIRED_COLUMNS = ['state', 'key', 'title', 'priority', 'assignee'] as const;
const OPTIONAL_COLUMNS = ['project', 'due', 'updated'] as const;
type Column = typeof REQUIRED_COLUMNS[number] | typeof OPTIONAL_COLUMNS[number];
type TrackerSort = { field: TrackerSortField; direction: 'asc' | 'desc' };

export interface TrackerViewerState {
  tab: TrackerView;
  viewId: string | null;
  /** The chosen saved view's own filter (from runView), in memory only: the element lists it in place of the tab's query. */
  viewFilter: string[] | null;
  filter: string[];
  queryText: string;
  group: ListGroupBy;
  sort: TrackerSort;
  allSort: TrackerSort;
  mySort: TrackerSort;
  density: 'comfortable' | 'compact';
  columns: Set<Column>;
  collapsedGroups: Set<string>;
  cursorKey: string | null;
  selectedKeys: string[];
  anchorKey: string | null;
  scrollTop: number;
  ticketKey: string | null;
  mySubtab: 'active' | 'created';
}

/** A card press on the element's board: pending until the pointer moves (or a touch rests), then a drag until it is dropped or cancelled. */
interface BoardDrag {
  pointerId: number;
  pointerType: string;
  ticket: TrackerTicket;
  card: HTMLElement;
  start: BoardPoint;
  last: BoardPoint;
  /** The press point in the card's own layout units, so the ghost keeps the grip. */
  grab: BoardPoint;
  scale: number;
  ghost: HTMLElement | null;
  active: boolean;
  /** The lane under the pointer (null outside every lane). */
  over: string | null;
  timer: number | undefined;
  frame: number | undefined;
}

const viewerStates = new WeakMap<TrackerStore, Map<string, TrackerViewerState>>();

/** Tabs, filters, cursor, and layout belong to this viewer's tracker window. */
export function trackerViewerState(store: TrackerStore, viewerId: string, trackerId = 'default', defaultTab: TrackerView = 'inbox'): TrackerViewerState {
  let byViewer = viewerStates.get(store);
  if (!byViewer) { byViewer = new Map(); viewerStates.set(store, byViewer); }
  const stateKey = `${trackerId}:${viewerId}`;
  const existing = byViewer.get(stateKey);
  if (existing) return existing;
  const state: TrackerViewerState = {
    tab: defaultTab, viewId: null, viewFilter: null, filter: [], queryText: '', group: 'state',
    sort: defaultTab === 'my' ? { field: 'priority', direction: 'asc' } : { field: 'updatedAt', direction: 'desc' },
    allSort: { field: 'updatedAt', direction: 'desc' }, mySort: { field: 'priority', direction: 'asc' },
    density: 'comfortable', columns: new Set<Column>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]), collapsedGroups: new Set(),
    cursorKey: null, selectedKeys: [], anchorKey: null, scrollTop: 0, ticketKey: null, mySubtab: 'active',
  };
  byViewer.set(stateKey, state);
  return state;
}

export function visibleColumns(width: number, chosen: ReadonlySet<Column>): Column[] {
  const columns: Column[] = [...REQUIRED_COLUMNS];
  if (width >= 800 && chosen.has('project')) columns.push('project');
  if ((width < 600 || width >= 920) && chosen.has('due')) columns.push('due'); // on a phone the due date sits under the key
  if (width >= 1080 && chosen.has('updated')) columns.push('updated');
  return columns;
}

export type ElementColumn = 'state' | 'key' | 'title' | 'assignee' | 'priority';

/** The columns of an element's list at its width: the key and priority drop under 560px, the avatar under 420px. */
export function elementColumns(width: number): ElementColumn[] {
  if (width >= 560) return ['state', 'key', 'title', 'assignee', 'priority'];
  if (width >= 420) return ['state', 'title', 'assignee'];
  return ['state', 'title'];
}

export function facetsForGroup(group: ListGroupBy, facets?: TrackerFacets): ListFacets | undefined {
  if (!facets) return undefined;
  if (group === 'state' && facets.states) return { state: facets.states.map((item) => ({ key: item.id, label: item.name, count: item.count })) };
  if (group === 'label' && facets.labels) return { label: facets.labels.map((item) => ({ key: item.id, label: item.name, count: item.count })) };
  if (group === 'assignee' && facets.assignees) return { assignee: facets.assignees.map((item) => ({ key: item.userId, label: item.name, count: item.count })) };
  return undefined;
}

export interface TrackerShellOptions {
  store: TrackerStore;
  api: TrackerApi;
  viewerId: string;
  trackerId: string;
  windowId?: string;
  initialTab?: TrackerView;
  initialViewId?: string;
  initialTicketKey?: string;
  fullScreen?: boolean;
  /** Opened as a page of its own (no board behind it): the strip leads back to Boards instead of to a board. */
  routeMode?: boolean;
  /** The signed-in person, for the strip's menu (theme, account links). Without one the strip has no menu button. */
  account?: Me | null;
  /** Go to the boards page, for the strip and the menu in route mode. */
  onBoards?: () => void;
  boardName?: string;
  layoutWidth?: number;
  readOnly?: boolean;
  onFullscreenChange?: (fullScreen: boolean) => void;
  onTicketChange?: (key: string | null) => void;
  onTabChange?: (tab: TrackerView, viewId?: string) => void;
  onWorkExit?: () => void;
  /** A mouse press on a board card in the element (the frame selects itself and focuses, as it does for a press on a row). */
  onPointerPress?: () => void;
  /** The element (a frame on a board), not the full-screen route: a compact header with All and My, and no tabs or filters. */
  element?: boolean;
  /** Element only: the expand button opens the full-screen route. */
  onOpenFullScreen?: () => void;
  /** Element only: the link that the menu's Copy link copies (the full-screen route of this element), or null. */
  elementLink?: () => string | null;
  onCreated?: (key: string) => void;
  onSnapshot?: () => void;
  active?: () => boolean;
}

export interface TrackerShellController {
  el: HTMLElement;
  focus(): void;
  setFullscreen(value: boolean): void;
  setTicket(key: string | null): void;
  updateLayout(width: number): void;
  /** The person's access changed (the board went read-only or back): the header and the board's buttons follow it. */
  refreshAccess(): void;
  destroy(): void;
  state: TrackerViewerState;
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable || Boolean(element.closest('[contenteditable="true"]')));
}

function stableQuery(state: TrackerViewerState): TrackerListQuery {
  // The REST list route currently accepts filters, q and limit. Grouping, facets and sorting are applied locally.
  // A chosen saved view runs its own filter (the element's tab is All while one is open).
  if (state.viewId && state.viewFilter) return { filter: [...state.viewFilter], q: state.queryText.trim() || undefined, limit: 50 };
  const filters = state.tab === 'my' && state.mySubtab === 'active' ? ['assignee:me', ...state.filter] : [...state.filter];
  return {
    filter: filters, q: state.queryText.trim() || undefined, limit: 50,
  };
}

/** The server's list endpoint returns a compact projection; fill fields used by the shared row UI. */
function ticketFromListRow(row: TrackerRow, meta: TrackerMeta, trackerId: string): TrackerTicket {
  const partial = row as unknown as Partial<TrackerTicket>;
  const listedState = partial.state as Partial<TrackerTicket['state']> | undefined;
  const stateReference = listedState?.id ?? listedState?.key ?? listedState?.name;
  const canonicalState = meta.states.find((item) => item.id === stateReference || item.key === stateReference || item.name === stateReference);
  const categories = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
  const category = listedState?.category;
  const priorities: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];
  const updatedAt = typeof partial.updatedAt === 'number' && Number.isFinite(partial.updatedAt) ? partial.updatedAt : 0;
  const labels = Array.isArray(partial.labels) ? partial.labels.filter((label) => label && typeof label.name === 'string') : [];
  const assignee = partial.assignee && typeof partial.assignee.userId === 'string' && typeof partial.assignee.name === 'string'
    ? partial.assignee : null;
  const project = partial.project && typeof partial.project.id === 'string' && typeof partial.project.name === 'string'
    ? partial.project : null;
  const milestone = partial.milestone && typeof partial.milestone.id === 'string' && typeof partial.milestone.name === 'string'
    ? partial.milestone : null;
  return {
    ...partial,
    id: typeof partial.id === 'string' ? partial.id : `list:${row.key}`,
    key: row.key,
    trackerId: typeof partial.trackerId === 'string' ? partial.trackerId : trackerId,
    title: typeof partial.title === 'string' ? partial.title : row.key,
    description: typeof partial.description === 'string' ? partial.description : '',
    state: {
      id: typeof listedState?.id === 'string' ? listedState.id : canonicalState?.id ?? stateReference ?? 'unknown',
      key: typeof listedState?.key === 'string' ? listedState.key : canonicalState?.key ?? stateReference ?? 'unknown',
      name: typeof listedState?.name === 'string' ? listedState.name : canonicalState?.name ?? String(stateReference ?? 'Unknown state'),
      category: categories.includes(category as (typeof categories)[number]) ? category as TrackerTicket['state']['category'] : canonicalState?.category ?? 'unstarted',
    },
    priority: priorities.includes(partial.priority as TrackerPriority) ? partial.priority! : 'none',
    assignee,
    creator: partial.creator ?? { type: 'system', id: null, name: 'System' },
    labels,
    project,
    milestone,
    estimate: typeof partial.estimate === 'number' ? partial.estimate : null,
    due: typeof partial.due === 'string' ? partial.due : null,
    parent: typeof partial.parent === 'string' ? partial.parent : null,
    relations: Array.isArray(partial.relations) ? partial.relations : [],
    links: Array.isArray(partial.links) ? partial.links : [],
    aliases: Array.isArray(partial.aliases) ? partial.aliases : [],
    archivedAt: typeof partial.archivedAt === 'number' ? partial.archivedAt : null,
    createdAt: typeof partial.createdAt === 'number' ? partial.createdAt : updatedAt,
    updatedAt,
    updatedSeq: typeof partial.updatedSeq === 'number' ? partial.updatedSeq : 0,
  };
}

function valueFor(ticket: TrackerTicket, field: string): string {
  if (field === 'state') return ticket.state.name;
  if (field === 'assignee') return ticket.assignee?.name ?? 'No one';
  if (field === 'priority') return priorityLabel(ticket.priority);
  if (field === 'labels') return ticket.labels.map((label) => label.name).join(', ') || 'No labels';
  if (field === 'due') return ticket.due ?? 'No due date';
  if (field === 'project') return ticket.project?.name ?? 'No project';
  return 'current value';
}

export function mountTrackerShell(parent: HTMLElement, options: TrackerShellOptions): TrackerShellController {
  const state = trackerViewerState(options.store, options.viewerId, options.windowId ?? options.trackerId, options.initialTab);
  state.viewId = options.initialViewId ?? state.viewId;
  state.ticketKey = options.initialTicketKey ?? state.ticketKey;
  const elementMode = options.element === true;
  // an element shows All, My or Board; a view stored from before (inbox, projects) reads as All
  if (elementMode && state.tab !== 'all' && state.tab !== 'my' && state.tab !== 'board') state.tab = 'all';
  if (elementMode && state.viewId) state.tab = 'all';
  let fullScreen = options.fullScreen === true;
  let elementEmpty = false;
  let elementDenied = false;
  let meta = options.store.snapshot().meta;
  let readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
  let currentCache = options.store.list(stableQuery(state));
  let listModel: ListRenderModel | null = null;
  let stopList: (() => void) | null = null;
  let stopBoard: Array<() => void> = [];
  let stopStore: (() => void) | null = null;
  let stopKeyListener: (() => void) | null = null;
  let debounce: number | undefined;
  let unreadCount = 0;
  let inboxController: ReturnType<typeof mountInbox> | null = null;
  let ticketPageController: ReturnType<typeof mountTicketPage> | null = null;
  let boardLaneStrip: HTMLElement | null = null;
  let boardLanesHost: HTMLElement | null = null;
  let boardErrorHost: HTMLElement | null = null;
  let boardLaneKey: string | null = null;
  const boardCaches = new Map<string, { state: TrackerState; query: TrackerListQuery; cache: ReturnType<TrackerStore['list']> }>();
  let listRenderHost: HTMLElement | null = null;
  let listLoadMore: HTMLButtonElement | null = null;
  let resultsHost: HTMLElement | null = null;
  let errorHost: HTMLElement | null = null;
  let skeletonHost: HTMLElement | null = null;
  let filterController: FilterBarController | null = null;
  let lastUndoAction: (() => Promise<unknown>) | null = null;
  let pendingSequence: { key: 'g'; expiresAt: number } | null = null;
  let layoutWidth = options.layoutWidth ?? (fullScreen ? window.innerWidth : 1440);
  let destroyed = false;
  let ticketError = '';

  const root = h('section', { class: 'trk trk-shell', tabindex: '0', 'aria-label': 'Tracker', 'data-fullscreen': String(fullScreen) });
  if (elementMode) root.classList.add('trk-element');
  // When the focused control is removed or hidden by a re-render (a row, once its ticket opens), the browser drops focus on the
  // body, and the next key would reach the board. The tracker takes the focus back. The listener is on the document because a
  // removed node's focusout no longer bubbles to the shell.
  let lastFocused: EventTarget | null = null;
  root.addEventListener('focusin', (event) => { lastFocused = event.target; });
  const rescueFocus = (event: FocusEvent) => {
    if (event.target !== lastFocused || event.relatedTarget) return;
    const lost = event.target as Node;
    requestAnimationFrame(() => {
      const gone = !lost.isConnected || (lost instanceof HTMLElement && !lost.checkVisibility());
      if (gone && root.isConnected && !root.hidden && document.activeElement === document.body) root.focus({ preventScroll: true });
    });
  };
  document.addEventListener('focusout', rescueFocus, true);
  const routeMode = options.routeMode === true;
  const menuButton = h('button', {
    class: 'trk-menu-button', type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, icon('dots', 18));
  menuButton.hidden = !options.account;
  menuButton.addEventListener('click', () => {
    if (options.account) openTrackerMenu(menuButton, { me: options.account, onBoards: () => options.onBoards?.() });
  });
  const fullscreenStrip = h('div', { class: 'trk-fullscreen-strip', hidden: !fullScreen },
    h('h1', { class: 'trk-board-name' }, options.boardName ?? 'Tracker'),
    h('span', { class: 'trk-strip-spacer' }),
    routeMode
      ? h('button', { class: 'trk-small-button trk-back-boards', type: 'button', onclick: () => options.onBoards?.() }, '‹ Boards')
      : h('button', { class: 'trk-small-button', type: 'button', onclick: () => setFullscreen(false) }, 'Back to board'),
    menuButton,
  );
  const tabs = h('nav', { class: 'trk-tabs', role: 'tablist', 'aria-label': 'Tracker sections' });
  const commandButton = h('button', { class: 'trk-command-trigger', type: 'button', 'aria-label': 'Open command box, Command or Control K' }, kbdHint('Ctrl/Cmd+K'));
  const newButton = h('button', { class: 'trk-primary-button trk-new-trigger', type: 'button', 'aria-label': elementMode ? 'New ticket' : 'New issue' }, elementMode ? '+ New ticket' : '+ New issue');
  const fullscreenButton = elementMode
    ? h('button', { class: 'trk-icon-button trk-element-expand', type: 'button', 'aria-label': 'Open full screen', 'data-tip': 'Open full screen' }, icon('expand', 16))
    : h('button', { class: 'trk-icon-button', type: 'button', 'aria-label': fullScreen ? 'Back to board' : 'Open full screen' }, fullScreen ? '↙' : '↗');
  // the element's own header parts (only mounted in element mode)
  const elementName = h('h2', { class: 'trk-element-name' }, 'Tracker');
  const elementSub = h('span', { class: 'trk-element-sub' }, 'Workspace tickets');
  const elementSwitchHost = h('div', { class: 'trk-element-switch' });
  let elementSwitcher: HTMLElement | null = null;
  const elementBack = h('button', { class: 'trk-small-button trk-element-back', type: 'button', onclick: () => setTicket(null) }, 'Back');
  const elementViewsButton = h('button', { class: 'trk-element-views', type: 'button', 'aria-haspopup': 'menu' }, 'Views');
  elementViewsButton.hidden = true;
  const elementMenuButton = h('button', {
    class: 'trk-icon-button trk-element-menu-button', type: 'button', 'aria-label': 'Tracker menu', 'aria-haspopup': 'menu', 'data-tip': 'Tracker menu',
  }, icon('dots', 16));
  const offlineLine = h('div', { class: 'trk-offline-line', role: 'status', hidden: typeof navigator === 'undefined' || navigator.onLine !== false },
    h('span', null, 'Offline. Changes are saved here and will sync.'),
    h('span', { class: 'trk-offline-create-reason' }, 'Needs a connection to get a ticket number.'),
  );
  const errorBanner = h('div', { class: 'trk-error-banner', role: 'alert', hidden: true });
  const content = h('div', { class: 'trk-content' });
  const live = h('div', { class: 'trk-live-region', 'aria-live': 'polite', 'aria-atomic': 'true' });
  root.append(fullscreenStrip, elementMode
    ? h('header', { class: 'trk-header trk-element-header' },
      h('div', { class: 'trk-element-title' }, elementName, elementSub),
      h('div', { class: 'trk-element-actions' }, elementSwitchHost, elementViewsButton, elementBack, newButton, fullscreenButton, elementMenuButton))
    : h('header', { class: 'trk-header' }, tabs,
      h('div', { class: 'trk-header-actions' }, commandButton, newButton, fullscreenButton)),
  offlineLine, errorBanner, content, live);
  parent.appendChild(root);
  root.dataset.width = String(layoutWidth);
  // the soft keyboard shrinks the visual viewport, not the layout one: the phone's suggestion sheet rides on top of it (--trk-kb)
  const publishKeyboard = () => {
    const vv = window.visualViewport;
    root.style.setProperty('--trk-kb', `${Math.round(vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0)}px`);
  };
  window.visualViewport?.addEventListener('resize', publishKeyboard);
  window.visualViewport?.addEventListener('scroll', publishKeyboard);
  publishKeyboard();

  const announce = (message: string) => { live.textContent = message; };
  const destroyInbox = () => {
    inboxController?.destroy();
    inboxController = null;
  };
  const destroyTicketPage = () => {
    ticketPageController?.destroy();
    ticketPageController = null;
  };
  const runUndo = async () => {
    const undo = lastUndoAction;
    if (!undo) return;
    lastUndoAction = null;
    try { await undo(); announce('Change undone'); toast('Change undone'); }
    catch { toast('The change could not be undone.'); }
  };
  const active = () => !destroyed && (options.active?.() ?? (root === document.activeElement || root.contains(document.activeElement) || fullScreen));
  const updateActions = () => {
    const wasReadOnly = readOnly;
    readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
    if (wasReadOnly !== readOnly && state.tab === 'board' && !state.ticketKey && meta && boardLanesHost) renderBoardContents();
    newButton.hidden = readOnly || (elementMode && (elementDenied || elementEmpty));
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    offlineLine.hidden = !offline;
    newButton.disabled = offline;
    if (offline) newButton.setAttribute('aria-description', 'Needs a connection to get a ticket number.');
    else newButton.removeAttribute('aria-description');
  };

  const switchTab = (tab: TrackerView) => {
    if (state.tab === 'my') state.mySort = { ...state.sort };
    else if (state.tab === 'all') state.allSort = { ...state.sort };
    state.tab = tab;
    if (tab === 'my') state.sort = { ...state.mySort };
    else if (tab === 'all') state.sort = { ...state.allSort };
    state.viewId = null;
    state.ticketKey = null;
    options.onTabChange?.(tab);
    renderPage();
  };
  const setMySubtab = (subtab: 'active' | 'created') => {
    if (state.mySubtab === subtab) return;
    state.mySubtab = subtab;
    state.selectedKeys = [];
    state.cursorKey = null;
    state.anchorKey = null;
    renderPage();
  };

  const showError = (message: string) => {
    const shown = elementMode ? 'Could not load tickets' : message;
    errorBanner.replaceChildren(h('span', null, shown), h('button', { class: 'trk-small-button', type: 'button', onclick: () => {
      errorBanner.hidden = true;
      void options.store.loadMeta(true).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker data.'));
      if (state.tab === 'all' || state.tab === 'my') watchQuery();
      else if (state.tab === 'board') startBoardWatch();
    } }, 'Retry'));
    errorBanner.hidden = false;
  };

  const showListError = (message: string) => {
    if (!errorHost || !root.contains(errorHost)) { showError(message); return; }
    const target = errorHost;
    const displayMessage = elementMode ? 'Could not load tickets' : message.startsWith('Could not load') ? message : `Could not load issues. ${message}`;
    target.replaceChildren(h('span', null, displayMessage), h('button', {
      class: 'trk-small-button', type: 'button', onclick: () => {
        target.hidden = true;
        void options.store.loadList(stableQuery(state), { force: true }).catch((error: unknown) =>
          showListError(error instanceof Error ? error.message : 'Could not load issues.'));
      },
    }, 'Retry'));
    target.hidden = false;
    if (skeletonHost) skeletonHost.hidden = true;
    if (listRenderHost) listRenderHost.replaceChildren();
    if (resultsHost) resultsHost.textContent = 'Issues unavailable';
  };

  const updateListLoadMore = (cache: typeof currentCache, visible = true) => {
    if (!listLoadMore) return;
    listLoadMore.hidden = !visible || !cache.nextCursor;
    listLoadMore.disabled = cache.loadingMore;
    listLoadMore.textContent = cache.loadingMore ? 'Loading…' : 'Load more';
  };

  const elementTab = (): TrackerView => (state.tab === 'my' || state.tab === 'board' ? state.tab : 'all');
  /** The saved view the element is showing, or null (the element only: the full-screen route keeps its own list). */
  const elementView = (): string | null => (elementMode && state.viewId && state.viewFilter ? state.viewId : null);
  const peekAllowed = () => trackerPeekAllowed({ element: elementMode, fullScreen, tab: state.tab, width: layoutWidth });
  const elementTabLabel = () => ({ all: 'All', my: 'My', board: 'Board' } as const)[elementTab() as 'all' | 'my' | 'board'];
  /** The element header: All, My and Board (the shared segmented control), Back while a ticket is open, New ticket, expand, and the menu. */
  const renderElementHeader = () => {
    const width = layoutWidth;
    // a ticket open beside the list (the side panel) keeps the list's header; only a ticket in place takes over the header
    const inPlace = Boolean(state.ticketKey) && !peekAllowed();
    const view = elementView();
    elementName.textContent = inPlace ? state.ticketKey ?? 'Tracker' : 'Tracker';
    elementSub.textContent = view ? (getMeta()?.views ?? []).find((item) => item.id === view)?.name ?? 'Workspace tickets' : 'Workspace tickets';
    elementSub.hidden = inPlace || width < 560;
    // the switch hides while the unfiltered All view is empty, while a saved view is open (the menu's All returns), and when the person has no access; at under 360px it moves into the menu
    const showSwitch = !inPlace && !elementDenied && !elementEmpty && !view && width >= 360;
    if (showSwitch && !elementSwitcher) {
      elementSwitcher = segmented<TrackerView>([{ value: 'all', label: 'All' }, { value: 'my', label: 'My' }, { value: 'board', label: 'Board' }], elementTab(),
        (value) => switchTab(value), 'Tickets');
      elementSwitchHost.replaceChildren(elementSwitcher);
    }
    if (elementSwitcher) for (const button of elementSwitcher.querySelectorAll<HTMLButtonElement>('button')) {
      const on = button.getAttribute('aria-label') === elementTabLabel();
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    }
    elementSwitchHost.hidden = !showSwitch;
    elementBack.hidden = !inPlace;
    // the Views button comes and goes with the saved views the person can see; it is not in the way of a ticket in place
    elementViewsButton.hidden = elementDenied || inPlace || (getMeta()?.views ?? []).length === 0;
    newButton.textContent = width >= 420 ? '+ New ticket' : '+';
    newButton.setAttribute('aria-label', 'New ticket');
    // one primary per view: while the element is empty the body's '+ New ticket' is the only one
    newButton.hidden = readOnly || elementDenied || elementEmpty;
  };

  const copyElementLink = () => {
    const path = options.elementLink?.();
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!path) return;
    if (!clipboard) toast('Clipboard access is not available.');
    else void clipboard.writeText(path).then(() => toast('Link copied')).catch(() => toast('Could not copy the link.'));
  };

  const openElementMenu = (anchor: HTMLElement) => {
    const item = (label: string, action: () => void) => h('button', {
      class: 'trk-display-option', type: 'button', role: 'menuitem', onclick: () => { closePopover(); action(); },
    }, label);
    const items: HTMLElement[] = [item('Copy link', copyElementLink)];
    if (layoutWidth < 360) {
      items.push(item('View: All', () => switchTab('all')), item('View: My', () => switchTab('my')), item('View: Board', () => switchTab('board')));
    }
    popover(anchor, h('div', { class: 'trk-element-menu-panel', role: 'menu' }, ...items), { className: 'trk trk-pop trk-element-menu', label: 'Tracker menu' });
  };

  /** The Views menu: All first (the element's tab), then the saved views the person can see. Choosing one runs it in place. */
  const openElementViews = (anchor: HTMLElement) => {
    const item = (label: string, current: boolean, action: () => void) => h('button', {
      class: 'trk-display-option', type: 'button', role: 'menuitemradio', 'aria-checked': String(current),
      onclick: () => { closePopover(); action(); },
    }, label);
    const items: HTMLElement[] = [item('All', !elementView() && state.tab === 'all', () => switchTab('all'))];
    for (const view of getMeta()?.views ?? []) items.push(item(view.name, elementView() === view.id, () => { void chooseView(view.id); }));
    popover(anchor, h('div', { class: 'trk-element-menu-panel', role: 'menu', 'aria-label': 'Views' }, ...items), { className: 'trk trk-pop trk-element-menu', label: 'Views' });
  };

  /** Runs a saved view (its filter is the list's query). A view that cannot be run is refreshed out of the menu and nothing changes. */
  const chooseView = async (id: string) => {
    try {
      const page = await options.store.runView(id, { limit: 1 });
      if (destroyed) return;
      state.viewId = id; state.viewFilter = [...page.view.filter]; state.tab = 'all'; state.sort = { ...state.allSort };
      state.ticketKey = null; state.cursorKey = null; state.selectedKeys = []; state.anchorKey = null;
      options.onTabChange?.('all', id);
      renderPage();
    } catch {
      if (!destroyed) void options.store.listViews().catch(() => undefined);
    }
  };

  /** A saved view on the element at mount: it runs again; if it was deleted or is not visible, the element shows All, quietly (the board keeps the id). */
  const restoreView = async (id: string) => {
    try {
      const page = await options.store.runView(id, { limit: 1 });
      if (destroyed || state.viewId !== id) return;
      state.viewFilter = [...page.view.filter];
      renderPage();
    } catch {
      if (destroyed || state.viewId !== id) return;
      state.viewId = null; state.viewFilter = null;
      void options.store.listViews().catch(() => undefined);
      renderPage();
    }
  };

  const renderTabs = () => {
    if (elementMode) {
      renderElementHeader();
      root.dataset.width = String(layoutWidth);
      return;
    }
    const restoreTabFocus = tabs.contains(document.activeElement);
    tabs.replaceChildren(...TABS.map((tab) => h('button', {
      class: `trk-tab${state.tab === tab.id ? ' active' : ''}`, type: 'button', role: 'tab',
      'data-tab-id': tab.id,
      'aria-selected': String(state.tab === tab.id), 'aria-label': tab.id === 'inbox' ? `${tab.label}, ${unreadCount} unread` : tab.label,
      tabindex: state.tab === tab.id ? '0' : '-1',
      onkeydown: (event: KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const currentIndex = TABS.findIndex((candidate) => candidate.id === tab.id);
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const next = TABS[(currentIndex + direction + TABS.length) % TABS.length];
        event.preventDefault();
        event.stopPropagation();
        switchTab(next.id);
        tabs.querySelector<HTMLButtonElement>(`[data-tab-id="${next.id}"]`)?.focus();
      },
      onclick: () => switchTab(tab.id),
    }, h('span', { class: 'trk-tab-glyph', 'aria-hidden': 'true' }, tab.glyph),
    h('span', { class: 'trk-tab-name trk-tab-name-full' }, tab.label), h('span', { class: 'trk-tab-name trk-tab-name-short' }, tab.shortLabel),
    tab.id === 'inbox' ? h('span', { class: 'trk-unread-count', 'aria-label': `${unreadCount} unread` }, String(unreadCount)) : null)));
    if (restoreTabFocus) tabs.querySelector<HTMLButtonElement>(`[data-tab-id="${state.tab}"]`)?.focus();
    root.dataset.width = String(layoutWidth);
    root.classList.toggle('trk-narrow-frame', layoutWidth < 720);
  };

  const renderMenu = (anchor: HTMLElement, label: string, values: readonly { value: string; label: string }[], current: string,
    choose: (value: string) => void) => {
    void openPicker<string>(anchor, { label, options: values.map((item) => ({ value: item.value, label: item.label })), value: current })
      .then((value: PickerResult<string>) => { if (typeof value === 'string') choose(value); });
  };

  const getMeta = (): TrackerMeta | undefined => meta ?? options.store.snapshot().meta;
  const listFacets = (cache: typeof currentCache): ListFacets | undefined => facetsForGroup(state.group, cache.facets);
  const stopBoardWatch = () => { stopBoard.forEach((stop) => stop()); stopBoard = []; boardCaches.clear(); };
  const showBoardError = (message: string, query?: TrackerListQuery) => {
    const host = boardErrorHost;
    if (!host) { showListError(message); return; }
    host.replaceChildren(h('span', null, message), h('button', {
      class: 'trk-small-button', type: 'button', onclick: () => {
        if (!query) { host.hidden = true; showError(message); return; }
        void options.store.loadList(query, { force: true }).catch((error: unknown) =>
          showBoardError(error instanceof Error ? error.message : 'Could not load board issues.', query));
      },
    }, 'Retry'));
    host.hidden = false;
  };

  const startWatch = () => {
    stopList?.();
    if (!meta || (state.tab !== 'all' && state.tab !== 'my') || (state.ticketKey && !peekAllowed())) return;
    const query = stableQuery(state);
    currentCache = options.store.list(query);
    stopList = options.store.watchList(query, (cache) => {
      currentCache = cache;
      try {
        if (cache.error?.code === 'invalid_filter') filterController?.setError(cache.error.message); // never clears: a typed token the bar rejected stays reported until the next keystroke
        drawRows(cache);
        publishCurrentSnapshot();
      } catch (error) {
        showListError(error instanceof Error ? error.message : 'Could not render issues.');
      }
    });
  };

  const rowButton = (text: string, label: string, action: () => void, className = 'trk-cell-button'): HTMLButtonElement =>
    h('button', { class: className, type: 'button', 'aria-label': label, onclick: (event: Event) => { event.stopPropagation(); action(); } },
      className === 'trk-avatar-button' ? h('span', { class: 'trk-avatar-mark' }, text) : text,
    );

  const recordUndo = (message: string, undo: () => Promise<unknown>) => {
    lastUndoAction = undo;
    toast(message, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
  };

  const editOne = async (ticket: TrackerTicket, field: 'state' | 'assignee' | 'priority' | 'labels' | 'due' | 'project', anchor: HTMLElement) => {
    if (readOnly) return;
    const info = getMeta();
    if (!info) return;
    try {
      if (field === 'state') {
        const picked = await openPicker<string>(anchor, { label: 'State', options: info.states.map((item) => ({ value: item.key, label: item.name })), value: ticket.state.key });
        if (typeof picked === 'string' && picked !== ticket.state.key) {
          const previous = ticket.state.key; // read before the store updates the cached ticket this row holds
          const next = await options.store.transitionTicket(ticket.key, picked);
          recordUndo('State changed', () => options.store.transitionTicket(ticket.key, previous));
          announce(`${next.key} moved to ${next.state.name}`);
        }
      } else if (field === 'assignee') {
        const picked = await openPicker<string>(anchor, { label: 'Assignee', options: info.members.map((item) => ({ value: item.name, label: item.name })), value: ticket.assignee?.name ?? null });
        if ((picked === null || typeof picked === 'string') && picked !== (ticket.assignee?.name ?? null)) {
          await options.store.updateTicket(ticket.key, { assignee: picked });
          recordUndo('Assignee changed', () => options.store.updateTicket(ticket.key, { assignee: ticket.assignee?.name ?? null }));
          announce(`${ticket.key} assigned to ${picked === null ? 'no one' : picked}`);
        }
      } else if (field === 'priority') {
        const priorities: TrackerPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];
        const picked = await openPicker<TrackerPriority>(anchor, { label: 'Priority', options: priorities.map((value) => ({ value, label: priorityLabel(value) })), value: ticket.priority });
        if (typeof picked === 'string' && picked !== ticket.priority) {
          await options.store.updateTicket(ticket.key, { priority: picked });
          recordUndo('Priority changed', () => options.store.updateTicket(ticket.key, { priority: ticket.priority }));
        }
      } else if (field === 'labels') {
        const picked = await openPicker<string>(anchor, { label: 'Labels', multi: true, selected: ticket.labels.map((label) => label.name), options: info.labels.map((item) => ({ value: item.name, label: item.name, color: item.color })) });
        if (Array.isArray(picked)) {
          const labels = picked.filter((value): value is string => typeof value === 'string');
          await options.store.updateTicket(ticket.key, { labels });
          recordUndo('Labels changed', () => options.store.updateTicket(ticket.key, { labels: ticket.labels.map((label) => label.name) }));
        }
      } else if (field === 'due') {
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const picked = await openPicker<string>(anchor, { label: 'Due date', value: ticket.due, options: [{ value: today, label: `Today · ${today}` }, { value: tomorrow, label: `Tomorrow · ${tomorrow}` }] });
        if ((picked === null || typeof picked === 'string') && picked !== ticket.due) {
          await options.store.updateTicket(ticket.key, { due: picked });
          recordUndo('Due date changed', () => options.store.updateTicket(ticket.key, { due: ticket.due }));
        }
      } else {
        const projects = [...new Map(currentCache.tickets.flatMap((row) => row.project ? [[row.project.name, row.project.name] as const] : [])).entries()]
          .map(([name, label]) => ({ value: name, label }));
        if (!projects.length) { toast('Projects are not available yet.'); return; }
        const picked = await openPicker<string>(anchor, { label: 'Project', options: projects, value: ticket.project?.name ?? null });
        if (picked !== undefined) toast('Project updates are not available in the tracker store yet.');
      }
    } catch (caught) {
      if (caught instanceof TrackerError && caught.code === 'conflict') {
        const current = caught.current ? valueFor(caught.current, field) : valueFor(ticket, field);
        toast(`Mara changed this at the same time. Current value kept: ${current}`, 5000);
      } else {
        const path = caught instanceof TrackerError ? trackerErrorField(caught.path) : null;
        if (path === field) anchor.setAttribute('aria-invalid', 'true');
        toast(caught instanceof Error ? caught.message : 'The issue could not be updated.');
      }
    }
  };

  const doBulk = async (patch: { state?: string; assignee?: string | null; priority?: TrackerPriority; labels?: string[]; due?: string | null; archived?: boolean }, anchor?: HTMLElement) => {
    if (readOnly || !state.selectedKeys.length) return;
    const count = state.selectedKeys.length; // read before the awaits: the store's update redraws the list, which may drop the selection
    try {
      let undoBatch: Awaited<ReturnType<TrackerStore['bulk']>> | undefined;
      if (patch.state) {
        // The current bulk store contract has no state field; transition one ticket at a time until that API lands.
        const before = state.selectedKeys.map((key) => [key, currentCache.tickets.find((ticket) => ticket.key === key)?.state.key] as const);
        const transitioned: string[] = [];
        try {
          for (const key of state.selectedKeys) {
            await options.store.transitionTicket(key, patch.state);
            transitioned.push(key);
          }
        } catch (error) {
          for (const [key, previousState] of before) {
            if (transitioned.includes(key) && previousState) await options.store.transitionTicket(key, previousState).catch(() => undefined);
          }
          throw error;
        }
        lastUndoAction = async () => { for (const [key, previousState] of before) if (previousState) await options.store.transitionTicket(key, previousState); };
      } else {
        undoBatch = await options.store.bulk(state.selectedKeys, patch);
        const batch = undoBatch;
        lastUndoAction = () => options.store.undo(batch);
        toast(patch.archived ? `${count} issues archived` : `${count} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      }
      if (patch.state) toast(`${count} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      state.selectedKeys = [];
      announce('Selection cleared');
      drawRows(currentCache);
      updateSelectionBar();
    } catch (caught) {
      const path = caught instanceof TrackerError ? trackerErrorField(caught.path) : null;
      if (anchor && path) anchor.setAttribute('aria-invalid', 'true');
      toast(caught instanceof Error ? caught.message : 'The selected issues could not be updated.');
    }
  };

  const bulkPicker = (anchor: HTMLElement, field: 'state' | 'assignee' | 'priority' | 'labels' | 'due') => {
    const info = getMeta();
    if (!info || !state.selectedKeys.length) return;
    if (field === 'state') renderMenu(anchor, 'State', info.states.map((item) => ({ value: item.key, label: item.name })), '', (value) => void doBulk({ state: value }, anchor));
    else if (field === 'assignee') renderMenu(anchor, 'Assignee', [{ value: '__none', label: 'No one' }, ...info.members.map((item) => ({ value: item.name, label: item.name }))], '', (value) => void doBulk({ assignee: value === '__none' ? null : value }, anchor));
    else if (field === 'priority') renderMenu(anchor, 'Priority', ['urgent', 'high', 'medium', 'low', 'none'].map((value) => ({ value, label: priorityLabel(value as TrackerPriority) })), '', (value) => void doBulk({ priority: value as TrackerPriority }, anchor));
    else if (field === 'labels') renderMenu(anchor, 'Labels', info.labels.map((item) => ({ value: item.name, label: item.name, color: item.color })), '', (value) => void doBulk({ labels: [value] }, anchor));
    else renderMenu(anchor, 'Due date', [{ value: '__none', label: 'No date' }, { value: new Date().toISOString().slice(0, 10), label: 'Today' }], '', (value) => void doBulk({ due: value === '__none' ? null : value }, anchor));
  };

  const openBulkActions = (anchor: HTMLElement) => {
    const count = state.selectedKeys.length;
    if (!count) return;
    const menu = h('div', { class: 'trk-bulk-actions-sheet', role: 'group', 'aria-label': 'Bulk actions' });
    for (const field of ['state', 'assignee', 'priority', 'labels', 'due'] as const) {
      const label = field === 'due' ? 'Due date' : `${field[0].toUpperCase()}${field.slice(1)}`;
      const action = h('button', { class: 'trk-bulk-action', type: 'button' }, label);
      action.addEventListener('click', () => bulkPicker(action, field));
      menu.appendChild(action);
    }
    menu.append(
      h('button', { class: 'trk-bulk-action', type: 'button', onclick: () => { closePopover(); void doBulk({ archived: true }); } }, 'Archive'),
      h('button', { class: 'trk-bulk-action', type: 'button', onclick: () => {
        closePopover(); state.selectedKeys = []; announce('Selection cleared'); drawRows(currentCache); updateSelectionBar();
      } }, 'Clear selection'),
    );
    popover(anchor, menu, { className: 'trk trk-pop trk-pop-sheet', label: `Actions for ${count} selected` });
  };

  const issuesForView = (cache: typeof currentCache): TrackerTicket[] => {
    const tickets = cache.tickets.map((row) => ticketFromListRow(row as unknown as TrackerRow, meta!, options.trackerId));
    if (state.tab !== 'my' || elementView()) return tickets;
    const me = getMeta()?.me.userId;
    if (!me) return [];
    if (state.mySubtab === 'created') return tickets.filter((ticket) => ticket.creator.type === 'user' && ticket.creator.id === me);
    return tickets.filter((ticket) => ticket.assignee?.userId === me && ticket.state.category !== 'completed' && ticket.state.category !== 'canceled');
  };
  const facetsForIssues = (cache: typeof currentCache, tickets: readonly TrackerTicket[]): ListFacets | undefined => {
    if (state.tab !== 'my' || state.group !== 'state' || !meta) return listFacets(cache);
    return { state: meta.states.slice().sort((a, b) => a.position - b.position).map((item) => ({
      key: item.id, label: item.name, count: tickets.filter((ticket) => ticket.state.key === item.key).length,
    })) };
  };
  const lockedFilterChips = (): FilterChip[] => state.tab === 'my'
    ? state.mySubtab === 'active'
      ? [{ field: 'assignee', value: 'me', locked: true }]
      : [{ field: 'creator', value: 'me', locked: true }]
    : [];

  const renderRows = (cache: typeof currentCache) => {
    if (!listRenderHost || !resultsHost || !skeletonHost || !errorHost) return;
    elementEmpty = false;
    elementDenied = elementMode && (cache.error?.code === 'forbidden' || options.store.snapshot().metaError?.code === 'forbidden');
    if (elementDenied) {
      // no access: no list, no switch and no New ticket; the copy says who can give access
      if (listLoadMore) listLoadMore.hidden = true;
      errorHost.hidden = true;
      skeletonHost.hidden = true;
      listRenderHost.replaceChildren(h('div', { class: 'trk-element-empty trk-element-denied' },
        h('h2', null, 'You do not have access to the tracker'),
        h('p', { class: 'trk-element-quiet' }, 'Ask a workspace admin'),
      ));
      resultsHost.textContent = '';
      return;
    }
    if (!meta) {
      updateListLoadMore(cache, false);
      skeletonHost.hidden = false;
      listRenderHost.replaceChildren();
      resultsHost.textContent = '';
      return;
    }
    const tickets = issuesForView(cache);
    const primarySort = state.sort.field === 'updatedAt' || state.sort.field === 'createdAt' || state.sort.field === 'priority' || state.sort.field === 'due' || state.sort.field === 'title' || state.sort.field === 'key'
      ? state.sort.field : 'updatedAt';
    const sortPlan: ListSortPlan = state.tab === 'my'
      ? [{ field: primarySort, direction: state.sort.direction }, ...(primarySort === 'due' ? [] : [{ field: 'due' as const, direction: 'asc' as const }])]
      : { field: primarySort, direction: state.sort.direction };
    if (cache.error?.code === 'invalid_filter') filterController?.setError(cache.error.message); // never clears: a typed token the bar rejected stays reported until the next keystroke
    if (cache.error) {
      updateListLoadMore(cache, false);
      if (cache.error.code === 'invalid_filter') {
        errorHost.hidden = true;
        listRenderHost.replaceChildren();
        resultsHost.textContent = '0 issues';
        skeletonHost.hidden = true;
        return;
      }
      showListError(cache.error.message || 'Could not load issues.');
      const searchInput = filterController?.el.querySelector<HTMLInputElement>('.trk-filter-input');
      if (searchInput) {
        if (trackerErrorField(cache.error.path) === 'search') searchInput.setAttribute('aria-invalid', 'true');
        else searchInput.removeAttribute('aria-invalid');
      }
      skeletonHost.hidden = true;
      return;
    }
    errorHost.hidden = true;
    listModel = buildListModel({
      pages: [tickets as unknown as TrackerRow[]], facets: facetsForIssues(cache, tickets), group: state.group, sort: sortPlan,
      collapsedGroups: state.collapsedGroups, cursorKey: state.cursorKey, selectedKeys: state.selectedKeys, anchorKey: state.anchorKey,
    });
    state.cursorKey = listModel.cursorKey;
    state.selectedKeys = listModel.selectedKeys;
    state.anchorKey = listModel.anchorKey;
    skeletonHost.hidden = !(cache.loading && cache.tickets.length === 0);
    const filterActive = state.filter.length > 0 || Boolean(state.queryText.trim());
    const wasEmpty = elementEmpty;
    elementEmpty = elementMode && !cache.loading && tickets.length === 0 && state.tab === 'all' && !filterActive && !elementView();
    if (elementMode && wasEmpty !== elementEmpty) updateActions(); // the header's New ticket comes and goes with the empty state
    // with a ticket open the list is one half of the split (its share of the width, as the peek layout CSS sets it), so its columns fit that half (TAB-357)
    const listShare = peekAllowed() && state.ticketKey ? (elementMode ? 0.48 : 0.6) : 1;
    const listWidth = Math.round(layoutWidth * listShare);
    const columns: Column[] = elementMode ? elementColumns(listWidth) : visibleColumns(listWidth, state.columns);
    if (elementMode && !cache.loading && tickets.length === 0) {
      listRenderHost.replaceChildren(h('div', { class: 'trk-element-empty' },
        h('h2', null, state.tab === 'my' ? (state.mySubtab === 'active' ? 'Nothing assigned to you.' : 'Nothing created by you yet.') : 'No tickets yet'),
        // only a person who can create tickets is invited to create the first one
        state.tab === 'my' ? h('p', null, 'Tickets assigned to you or created by you appear here.') : readOnly ? null : h('p', null, 'Create the first ticket to track work here.'),
        readOnly ? null : h('button', { class: 'trk-primary-button trk-element-create', type: 'button', onclick: () => openCreate() }, '+ New ticket'),
      ));
      updateListLoadMore(cache);
      resultsHost.textContent = '0 issues';
      return;
    }
    if (!cache.loading && tickets.length === 0) {
      const myEmpty = state.tab === 'my' && !filterActive && !cache.nextCursor;
      const emptyMessage = state.tab === 'my' && !filterActive && cache.nextCursor
        ? 'No matching issues on this page.'
        : myEmpty
          ? state.mySubtab === 'active' ? 'Nothing assigned to you.' : 'Nothing created by you yet.'
        : filterActive ? 'No issues match.' : 'No issues yet.';
      listRenderHost.replaceChildren(h('div', { class: 'trk-empty-grid-row', role: 'row' },
        h('div', { class: 'trk-empty-grid-cell', role: 'gridcell', 'aria-colspan': String(columns.length) },
          h('div', { class: 'trk-empty-state' },
            h('h2', null, emptyMessage),
            h('p', { class: 'trk-empty-copy' }, filterActive
              ? 'Try a different search or clear the active filters.'
              : myEmpty ? 'Issues assigned to you or created by you appear here.'
                : 'Create the first issue in this tracker.'),
            filterActive
              ? h('button', { class: 'trk-small-button', type: 'button', onclick: () => { state.filter = []; state.queryText = ''; filterController?.setChips(lockedFilterChips()); if (filterController) filterController.focusSearch(); watchQuery(); } }, 'Clear filters')
              : (!readOnly ? h('button', { class: 'trk-small-button', type: 'button', onclick: () => openCreate() }, '+ New issue') : null),
          ),
        ),
      ));
      updateListLoadMore(cache);
      resultsHost.textContent = '0 issues';
      return;
    }
    const model = listModel;
    const selected = state.selectedKeys.length;
    const header = h('div', { class: 'trk-grid-header', role: 'row', style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') } },
      ...columns.map((column) => h('div', { role: 'columnheader', class: `trk-col-${column}` }, column === 'updated' ? 'Updated' : column[0].toUpperCase() + column.slice(1))),
    );
    const rows: Node[] = elementMode ? [] : [header];
    const now = Date.now();
    for (const group of model.groups) {
      if (state.group !== 'none') {
        const groupTicket = group.rows[0] as unknown as TrackerTicket | undefined;
        const headerButton = h('button', {
          class: 'trk-group-heading', type: 'button', 'aria-expanded': String(!group.collapsed),
          onclick: () => {
            state.collapsedGroups = new Set(state.collapsedGroups);
            if (group.collapsed) state.collapsedGroups.delete(group.id);
            else state.collapsedGroups.add(group.id);
            state.cursorKey = model.cursorKey;
            drawRows(cache);
          },
        }, ...(elementMode ? [h('span', null, `${group.label} · ${group.count}`)] : [h('span', { class: 'trk-group-chevron', 'aria-hidden': 'true' }, icon('chevron', 12)),
        groupTicket && state.group === 'state' ? stateGlyph(groupTicket.state.category, groupTicket.state.key) : null,
        h('span', null, group.label), h('span', { class: 'trk-muted' }, String(group.count))]));
        rows.push(h('div', { class: 'trk-group-row', role: 'row' },
          h('div', { class: 'trk-cell trk-group-cell', role: 'gridcell', 'aria-colspan': String(columns.length) }, headerButton),
        ));
      }
      if (group.collapsed) continue;
      for (const raw of group.rows) {
        const ticket = ticketFromListRow(raw, meta, options.trackerId);
        const selectedHere = state.selectedKeys.includes(ticket.key);
        const cursor = state.cursorKey === ticket.key;
        const selectionButton = !readOnly && !elementMode ? h('button', {
          class: 'trk-row-select', type: 'button', 'aria-label': `${selectedHere ? 'Deselect' : 'Select'} ${ticket.key}`,
          'aria-pressed': String(selectedHere),
          onclick: (event: Event) => {
            event.stopPropagation();
            state.selectedKeys = toggleSelection(model, ticket.key).selectedKeys;
            state.anchorKey = ticket.key;
            announce(`${state.selectedKeys.length} selected`);
            updateSelectionBar();
            drawRows(cache);
          },
        }, selectedHere ? '✓' : '') : null;
        const cells: Node[] = [];
        for (const column of columns) {
          if (column === 'priority') cells.push(h('div', { class: 'trk-cell trk-col-priority', role: 'gridcell' },
            readOnly ? priorityGlyph(ticket.priority) : h('button', { class: 'trk-glyph-button', type: 'button', 'aria-label': `${priorityLabel(ticket.priority)} for ${ticket.key}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'priority', event.currentTarget as HTMLElement); } }, priorityGlyph(ticket.priority)),
          ));
          else if (column === 'key') cells.push(h('div', { class: 'trk-cell trk-col-key', role: 'gridcell' }, selectionButton, keyChip(ticket.key)));
          else if (column === 'state') cells.push(h('div', { class: 'trk-cell trk-col-state', role: 'gridcell' },
            readOnly ? h('span', { class: 'trk-state-value' }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name))
              : h('button', { class: 'trk-cell-button trk-state-value', type: 'button', 'aria-label': `State: ${ticket.state.name}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'state', event.currentTarget as HTMLElement); } }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name)),
          ));
          else if (column === 'title') cells.push(h('div', { class: 'trk-cell trk-col-title', role: 'gridcell' },
            h('button', { class: 'trk-title-link', type: 'button', onclick: (event: Event) => { event.stopPropagation(); openTicket(ticket.key); } }, ticket.title),
            state.queryText.trim() && ticket.snippet ? h('span', { class: 'trk-search-snippet' }, renderSnippet(ticket.snippet)) : null,
            ...(elementMode ? [] : ticket.labels.slice(0, 2).map((label) => labelChip(label.name, label.color))),
            !elementMode && ticket.subIssueCount ? h('span', { class: 'trk-sub-count', 'aria-label': `${ticket.subIssueDone ?? 0} of ${ticket.subIssueCount} sub-issues complete` }, `${ticket.subIssueDone ?? 0}/${ticket.subIssueCount}`) : null,
          ));
          else if (column === 'project') cells.push(h('div', { class: 'trk-cell trk-col-project', role: 'gridcell' }, ticket.project?.name ?? '—'));
          else if (column === 'assignee') cells.push(h('div', { class: 'trk-cell trk-col-assignee', role: 'gridcell' }, ticket.assignee
            ? (readOnly ? ticket.assignee.name : rowButton(ticket.assignee.name.slice(0, 2).toUpperCase(), `Assignee: ${ticket.assignee.name}`, () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button'))
            : (readOnly ? '—' : rowButton('—', 'Assign issue', () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button')),
          ));
          else if (column === 'due') cells.push(h('div', { class: 'trk-cell trk-col-due', role: 'gridcell' },
            readOnly ? dueChip(ticket.due, now, ticket.state.category === 'completed' || ticket.state.category === 'canceled') : rowButton(ticket.due ? formatTrackerDate(ticket.due) : '—', ticket.due ? `Due ${ticket.due}` : 'Set due date', () => void editOne(ticket, 'due', document.activeElement as HTMLElement)),
          ));
          else cells.push(h('div', { class: 'trk-cell trk-col-updated', role: 'gridcell' }, relativeTime(now, new Date(ticket.updatedAt).toISOString())));
        }
        const row = h('div', {
          class: `trk-list-row${cursor ? ' is-cursor' : ''}${selectedHere ? ' is-selected' : ''}`,
          role: 'row', tabindex: '-1', 'aria-selected': String(selectedHere), 'data-cursor': String(cursor), 'data-key': ticket.key,
          style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') },
          onclick: () => { state.cursorKey = ticket.key; openTicket(ticket.key); },
          // focusin, not focus: Tab may land on a button inside the row, and the shortcuts act on the row that holds focus
          onfocusin: () => { state.cursorKey = ticket.key; if (listModel) listModel = moveCursorTo(listModel, ticket.key); },
        }, ...cells);
        rows.push(row);
      }
    }
    listRenderHost.replaceChildren(...rows);
    listRenderHost.setAttribute('aria-rowcount', String(model.visibleRows.length));
    updateListLoadMore(cache);
    const facets = facetsForIssues(cache, tickets)?.[state.group];
    const total = state.tab === 'my' ? tickets.length : facets?.reduce((sum, facet) => sum + facet.count, 0) ?? tickets.length;
    resultsHost.textContent = cache.nextCursor ? `${total}+ issues` : `${total} ${total === 1 ? 'issue' : 'issues'}`;
    announce(selected ? `${selected} selected` : '');
  };

  const drawRows = (cache: typeof currentCache) => {
    // the rows are rebuilt on every draw: a row, or a button inside one, that had the focus gets it back (the element's side panel and its close depend on it)
    const focused = listRenderHost?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusedRow = focused?.closest<HTMLElement>('[data-key]') ?? null;
    const focusedKey = focusedRow?.dataset.key ?? null;
    const buttonIndex = focused && focusedRow && focused !== focusedRow ? [...focusedRow.querySelectorAll('button')].indexOf(focused as HTMLButtonElement) : -1;
    try { renderRows(cache); }
    catch (error) { showListError(error instanceof Error ? error.message : 'Could not render issues.'); }
    if (elementMode) renderElementHeader();
    if (focusedKey) {
      const row = [...listRenderHost?.querySelectorAll<HTMLElement>('[data-key]') ?? []].find((candidate) => candidate.getAttribute('data-key') === focusedKey);
      (buttonIndex >= 0 ? row?.querySelectorAll<HTMLElement>('button')[buttonIndex] ?? row : row)?.focus({ preventScroll: true });
    }
  };

  const publishCurrentSnapshot = () => {
    // keyed by the element's object id (windowId), so two elements on one tracker do not share a snapshot
    publishTrackerSnapshot(options.windowId ?? options.trackerId, issuesForView(currentCache));
    options.onSnapshot?.();
  };

  const makeAllIssues = () => {
    const viewCapability = typeof (options.store as TrackerStore & { views?: unknown }).views === 'function' ||
      Array.isArray((getMeta() as (TrackerMeta & { views?: unknown[] }) | undefined)?.views);
    const availableViews = (getMeta() as (TrackerMeta & { views?: Array<{ id?: string; name?: string }> }) | undefined)?.views ?? [];
    const currentViewName = availableViews.find((view) => view.id === state.viewId)?.name ?? (state.tab === 'my' ? 'My issues' : 'All issues');
    const viewMenu = viewCapability
      ? h('button', { class: 'trk-view-name', type: 'button', onclick: () => toast('Saved views are not available yet.') }, currentViewName)
      : h('span', { class: 'trk-view-name' }, currentViewName);
    const groupButton = h('button', { class: 'trk-view-button', type: 'button' }, `Group: ${GROUPS.find((item) => item.value === state.group)?.label ?? 'State'}`);
    const sortLabel = () => state.tab === 'my' && state.sort.field === 'priority' && state.sort.direction === 'asc'
      ? 'Priority ↑, then due ↑'
      : `${SORTS.find((item) => item.value === state.sort.field)?.label ?? 'Updated'} ${state.sort.direction === 'desc' ? '↓' : '↑'}`;
    const sortButton = h('button', { class: 'trk-view-button', type: 'button' }, `Sort: ${sortLabel()}`);
    const displayButton = h('button', { class: 'trk-view-button', type: 'button' }, 'Display');
    const count = h('span', { class: 'trk-results-count', 'aria-live': 'polite' });
    const selectionBar = h('div', { class: 'trk-selection-bar', hidden: true });
    const viewBar = h('div', { class: 'trk-view-bar' }, viewMenu, groupButton, sortButton, displayButton, count);
    filterController = createFilterBar({
      initial: [...lockedFilterChips(), ...parse(state.filter)], meta: getMeta(),
      onChange: (chips: readonly FilterChip[]) => {
        try {
          state.filter = build(chips.filter((chip) => !chip.locked));
          filterController?.setError(null);
          state.selectedKeys = [];
          watchQuery();
        } catch (error) {
          filterController?.setError(error instanceof Error ? error.message : 'Invalid filter.');
        }
      },
      onSearch: (query: string) => {
        state.queryText = query;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = window.setTimeout(() => watchQuery(), 180);
      },
    });
    filterController.el.classList.add('trk-filter-host');
    const search = filterController.el.querySelector<HTMLInputElement>('.trk-filter-input');
    if (search) search.value = state.queryText;
    const table = h('div', {
      class: `trk-list-grid trk-density-${state.density}`, role: 'grid',
      'aria-label': state.tab === 'my' ? 'My issues' : 'All issues',
      'aria-multiselectable': readOnly ? undefined : 'true',
    });
    const skeleton = h('div', { class: 'trk-skeleton-list', hidden: true, 'aria-hidden': 'true' }, ...Array.from({ length: 8 }, () => h('div', { class: 'trk-skeleton-row' }, h('i'), h('i'), h('i'), h('i'))));
    const error = h('div', { class: 'trk-list-error', role: 'alert', hidden: true });
    listLoadMore = h('button', {
      class: 'trk-load-more', type: 'button', hidden: true,
      onclick: () => void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showListError(error instanceof Error ? error.message : 'Could not load more issues.')),
    }, 'Load more');
    const host = h('div', { class: 'trk-list-host' }, error, skeleton, table, listLoadMore);
    listRenderHost = table;
    resultsHost = count;
    skeletonHost = skeleton;
    errorHost = error;
    groupButton.addEventListener('click', () => renderMenu(groupButton, 'Group issues by', GROUPS.map((item) => ({ value: item.value, label: item.label })), state.group, (value) => {
      state.group = value as ListGroupBy;
      groupButton.textContent = `Group: ${GROUPS.find((item) => item.value === state.group)?.label}`;
      watchQuery();
    }));
    sortButton.addEventListener('click', () => renderMenu(sortButton, 'Sort issues by', SORTS.map((item) => ({ value: item.value, label: item.label })), state.sort.field, (value) => {
      state.sort = { field: value as TrackerSortField, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' };
      if (state.tab === 'my') state.mySort = { ...state.sort };
      else state.allSort = { ...state.sort };
      sortButton.textContent = `Sort: ${sortLabel()}`;
      watchQuery();
    }));
    displayButton.addEventListener('click', () => {
      const panel = h('div', { class: 'trk-display-menu' }, h('strong', null, 'Density'));
      for (const density of ['comfortable', 'compact'] as const) panel.appendChild(h('button', { class: 'trk-display-option', type: 'button', 'aria-pressed': String(state.density === density), onclick: () => { state.density = density; table.className = `trk-list-grid trk-density-${density}`; closePopover(); } }, density[0].toUpperCase() + density.slice(1)));
      panel.appendChild(h('strong', null, 'Columns'));
      for (const column of OPTIONAL_COLUMNS) {
        const checkbox = h('input', { type: 'checkbox', checked: state.columns.has(column), 'aria-label': `${column} column`, onchange: () => { if (checkbox.checked) state.columns.add(column); else state.columns.delete(column); drawRows(currentCache); } });
        panel.appendChild(h('label', { class: 'trk-display-check check' }, checkbox, column[0].toUpperCase() + column.slice(1)));
      }
      popover(displayButton, panel, { className: 'trk trk-pop trk-display-pop', label: 'Display issues' });
    });
    const updateSelectionBar = () => {
      const selectionCount = state.selectedKeys.length;
      selectionBar.hidden = selectionCount === 0;
      viewBar.hidden = selectionCount > 0;
      if (!selectionCount) return;
      const count = h('strong', null, `${selectionCount} selected`);
      if (layoutWidth <= 600) {
        const actions = h('button', { class: 'trk-small-button trk-bulk-actions-trigger', type: 'button', 'aria-haspopup': 'dialog' }, 'Actions');
        actions.addEventListener('click', () => openBulkActions(actions));
        selectionBar.replaceChildren(count, actions);
        return;
      }
      selectionBar.replaceChildren(count,
        ...(['state', 'assignee', 'priority', 'labels', 'due'] as const).map((field) => {
          const b = h('button', { class: 'trk-small-button', type: 'button' }, field[0].toUpperCase() + field.slice(1));
          b.addEventListener('click', () => bulkPicker(b, field));
          return b;
        }),
        h('button', { class: 'trk-small-button', type: 'button', onclick: () => void doBulk({ archived: true }) }, 'Archive'),
        h('button', { class: 'trk-small-button', type: 'button', onclick: () => { state.selectedKeys = []; drawRows(currentCache); updateSelectionBar(); } }, 'Clear selection'),
      );
    };
    listRenderHost.addEventListener('click', () => updateSelectionBar());
    const viewBarHost = h('div', { class: 'trk-list-tools' }, selectionBar, viewBar);
    const subtabBar = state.tab === 'my' ? h('div', { class: 'trk-my-subtabs', role: 'tablist', 'aria-label': 'My issue views' },
      ...([['active', 'Active'], ['created', 'Created by me']] as const).map(([key, label]) => h('button', {
        class: `trk-my-subtab${state.mySubtab === key ? ' active' : ''}`, type: 'button', role: 'tab',
        'aria-selected': String(state.mySubtab === key), onclick: () => setMySubtab(key),
      }, label)),
    ) : null;
    // an element lists only: its filters, view bar and My subtabs live in full screen
    const tab = h('section', { class: `trk-all-issues${state.tab === 'my' ? ' trk-my-issues' : ''}` },
      elementMode ? null : subtabBar, elementMode ? null : viewBarHost, elementMode ? null : filterController.el, host);
    return { tab, updateSelectionBar };
  };

  let updateSelectionBar = () => {};
  const openCreate = (defaultState?: string) => {
    const info = getMeta();
    if (!info || readOnly) return;
    openNewIssueDialog({ store: options.store, meta: info, viewerId: options.viewerId, trackerId: options.trackerId,
      title: elementMode ? 'New ticket' : undefined,
      defaultState: defaultState ?? (state.group === 'state' ? state.cursorKey ? options.store.list(stableQuery(state)).tickets.find((item) => item.key === state.cursorKey)?.state.key : undefined : undefined),
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
      onCreated: (key) => { options.onCreated?.(key); startWatch(); announce(`${key} created`); },
    });
  };

  const renderProjectsPage = () => {
    const projects = (getMeta()?.projects ?? []).filter((project) => project.archivedAt == null);
    const createButton = h('button', {
      class: 'trk-small-button', type: 'button', onclick: () => openNewProject(),
    }, 'New project');
    const page = h('section', { class: 'trk-projects-page', 'aria-label': 'Projects' },
      h('header', { class: 'trk-projects-head' }, h('h1', null, 'Projects'), projects.length ? createButton : null),
      projects.length
        ? h('div', { class: 'trk-project-list' }, ...projects.map((project) => h('div', { class: 'trk-project-row' },
          h('span', null, project.name), h('span', null, `${project.ticketCount ?? 0} issues`),
        )))
        : h('div', { class: 'trk-projects-empty' },
          h('h2', null, 'Group tickets into projects with milestones.'),
          h('p', { class: 'trk-projects-copy' }, 'Bring related issues together and track their milestones.'),
          h('button', { class: 'trk-small-button', type: 'button', onclick: () => openNewProject() }, 'New project'),
        ),
    );
    content.replaceChildren(page);
    publishCurrentSnapshot();
  };

  const openNewProject = () => {
    if (readOnly) return;
    const name = h('input', { class: 'trk-new-title', type: 'text', maxlength: '120', placeholder: 'Project name', 'aria-label': 'Project name' });
    const description = h('input', { class: 'trk-project-description', type: 'text', maxlength: '300', placeholder: 'Add a short description (optional)', 'aria-label': 'Project description' });
    const error = h('p', { class: 'trk-inline-error', role: 'alert', hidden: true });
    dialog('New project', h('div', { class: 'trk-project-create' }, name, description, error), [
      { label: 'Cancel' },
      { label: 'Create project', primary: true, onClick: async () => {
        const projectName = name.value.trim();
        if (!projectName) { name.focus(); name.setAttribute('aria-invalid', 'true'); return false; }
        name.removeAttribute('aria-invalid');
        error.hidden = true;
        try {
          await options.store.createProject({ name: projectName, description: description.value.trim() || undefined, state: 'planned', ownerId: getMeta()?.me.userId ?? null });
          meta = options.store.snapshot().meta ?? meta;
          toast('Project created');
          if (state.tab === 'projects') renderProjectsPage();
          return true;
        } catch (caught) {
          error.textContent = caught instanceof Error ? caught.message : 'Could not create the project.';
          error.hidden = false;
          return false;
        }
      } },
    ], { className: 'trk trk-modal trk-project-modal' });
  };

  function openTicket(key: string) {
    setTicket(key);
  }

  const ticketPageHost = (mode: 'page' | 'peek', key: string) => {
    const host = h('div', { class: 'trk-ticket-page-host' });
    ticketPageController = mountTicketPage(host, {
      store: options.store, key, mode,
      onClose: () => setTicket(null),
      onNavigate: (next) => setTicket(next),
      me: getMeta()?.me ?? { userId: options.viewerId, canWrite: !readOnly },
    });
    return host;
  };

  const renderTicket = () => {
    const key = state.ticketKey!;
    const canPeek = peekAllowed();
    if (!canPeek) stopList?.();
    const cached = options.store.list(stableQuery(state)).tickets.find((ticket) => ticket.key === state.ticketKey);
    const ticketState = options.store.ticket(key);
    const ticket = cached ?? ticketState.ticket;
    if (!ticket && !ticketError) void options.store.loadTicket(key, true).then((detail) => {
      if (state.ticketKey === detail.ticket.key) renderPage();
    }).catch(() => { ticketError = `${state.ticketKey} doesn't exist, or you don't have access.`; renderPage(); });
    if (ticketError) {
      content.replaceChildren(h('section', { class: 'trk-ticket-stub' }, h('h1', null, ticketError), h('button', { class: 'trk-small-button', type: 'button', onclick: () => setTicket(null) }, 'Go to All issues')));
      return;
    }
    if (!ticket) {
      content.replaceChildren(h('section', { class: 'trk-ticket-loading', role: 'status' }, `Loading ${key}…`));
      return;
    }
    if (canPeek) {
      // the row the ticket was opened from keeps the focus it had (the list is redrawn beside the panel)
      const hadFocus = root.contains(document.activeElement);
      const all = makeAllIssues();
      const page = ticketPageHost('peek', ticket.key);
      content.replaceChildren(h('div', { class: 'trk-peek-layout' },
        h('div', { class: 'trk-peek-list' }, all.tab),
        h('aside', { class: 'trk-peek-panel', 'aria-label': `Ticket ${ticket.key}` }, page),
      ));
      startWatch();
      all.updateSelectionBar();
      drawRows(currentCache);
      if (hadFocus && elementMode) (root.querySelector<HTMLElement>(`[data-key="${CSS.escape(ticket.key)}"]`) ?? root).focus({ preventScroll: true });
      return;
    }
    content.replaceChildren(ticketPageHost('page', ticket.key));
  };

  const boardStates = () => (getMeta()?.states ?? []).filter((item) => item.category !== 'canceled').slice().sort((a, b) => a.position - b.position);
  const boardQuery = (item: TrackerState): TrackerListQuery => ({ filter: [`state:${item.key}`], limit: 50 });
  const refreshBoard = async () => {
    const queries = [...boardCaches.values()].map((entry) => entry.query);
    await Promise.all(queries.map((query) => options.store.loadList(query, { force: true })));
  };
  const moveBoardTicket = async (ticket: TrackerTicket, stateKey: string, anchor?: HTMLElement) => {
    if (readOnly || ticket.state.key === stateKey) return;
    const previous = ticket.state.key;
    try {
      const moved = await options.store.transitionTicket(ticket.key, stateKey);
      await refreshBoard();
      recordUndo('State changed', async () => {
        await options.store.transitionTicket(ticket.key, previous);
        await refreshBoard();
      });
      announce(`${moved.key} moved to ${moved.state.name}`);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'The issue could not be moved.');
      if (anchor) anchor.focus({ preventScroll: true });
    }
  };
  const moveBoardByStep = (ticket: TrackerTicket, direction: -1 | 1, anchor?: HTMLElement) => {
    const lanes = boardStates();
    const at = lanes.findIndex((item) => item.key === ticket.state.key);
    const target = lanes[at + direction];
    if (target) void moveBoardTicket(ticket, target.key, anchor);
  };
  const openBoardMovePicker = (ticket: TrackerTicket, anchor: HTMLElement) => {
    void openPicker<string>(anchor, {
      label: `Move ${ticket.key} to`, options: meta?.states.map((item) => ({ value: item.key, label: item.name })) ?? [], value: ticket.state.key,
    }).then((picked) => { if (typeof picked === 'string') void moveBoardTicket(ticket, picked, anchor); });
  };
  // The element's board drag. A card dropped on another lane is moved there at once (pendingMoves) and the store's answer confirms or
  // reverts it. The element is transform-scaled, so the ghost is placed in layout units (client pixels divided by the scale).
  const pendingMoves = new Map<string, { ticket: TrackerTicket; stateKey: string; settled: boolean }>();
  let boardDrag: BoardDrag | null = null;
  const renderBoardContents = () => {
    if (!boardLaneStrip || !boardLanesHost || !meta) return;
    const lanes = boardStates();
    const phone = !elementMode && (layoutWidth <= 600 || (typeof window !== 'undefined' && window.innerWidth <= 600));
    if (!lanes.some((item) => item.key === boardLaneKey)) boardLaneKey = lanes[0]?.key ?? null;
    // each lane's tickets as the store has them, with a drop in flight moved to its target lane
    const laneRows = new Map<string, TrackerTicket[]>();
    for (const item of lanes) {
      const cache = boardCaches.get(item.key)?.cache ?? options.store.list(boardQuery(item));
      laneRows.set(item.key, cache.tickets.map((row) => ticketFromListRow(row as unknown as TrackerRow, meta!, options.trackerId)));
    }
    for (const [key, move] of pendingMoves) {
      // a settled move ends when the lanes show it, or when the store holds another state (offline, the lanes may not refresh)
      const landed = (laneRows.get(move.stateKey) ?? []).some((ticket) => ticket.key === key);
      if (move.settled && (landed || options.store.ticket(key).ticket?.state.key !== move.stateKey)) { pendingMoves.delete(key); continue; }
      for (const rows of laneRows.values()) {
        const at = rows.findIndex((ticket) => ticket.key === key);
        if (at >= 0) rows.splice(at, 1);
      }
      const target = lanes.find((item) => item.key === move.stateKey);
      if (target) laneRows.get(target.key)?.push({ ...move.ticket, state: { ...move.ticket.state, id: target.id, key: target.key, name: target.name, category: target.category } });
    }
    const countFor = (item: TrackerState) => laneRows.get(item.key)?.length ?? 0;
    boardLaneStrip.hidden = !phone;
    boardLaneStrip.replaceChildren(...(phone ? lanes.map((item) => h('button', {
      class: `trk-board-state-tab${item.key === boardLaneKey ? ' active' : ''}`, type: 'button', role: 'tab',
      'aria-selected': String(item.key === boardLaneKey), 'aria-label': `${item.name}, ${countFor(item)} issues`,
      onclick: () => { boardLaneKey = item.key; renderBoardContents(); },
    }, stateGlyph(item.category, item.key), h('span', null, item.name), h('span', { class: 'trk-board-lane-count' }, String(countFor(item))))) : []));
    const visibleLanes = phone ? lanes.filter((item) => item.key === boardLaneKey) : lanes;
    boardLanesHost.classList.toggle('is-phone-lane', phone);
    if (elementMode) boardLanesHost.style.setProperty('--trk-lane-width', `${laneWidthFor(layoutWidth)}px`);
    boardLanesHost.replaceChildren(...visibleLanes.map((item) => {
      const entry = boardCaches.get(item.key);
      const cache = entry?.cache ?? options.store.list(boardQuery(item));
      const normalized = laneRows.get(item.key) ?? [];
      const sortedRows = buildListModel({
        pages: [normalized as unknown as TrackerRow[]], group: 'none', sort: { field: 'priority', direction: 'asc' },
      }).visibleRows;
      const tickets = sortedRows.map((row) => ticketFromListRow(row, meta!, options.trackerId));
      const count = `${tickets.length}${cache.nextCursor ? '+' : ''}`;
      const noun = elementMode ? 'tickets' : 'issues';
      const header = h('header', { class: 'trk-board-lane-header' },
        stateGlyph(item.category, item.key), h('h2', null, item.name), h('span', { class: 'trk-board-lane-count' }, count),
        readOnly ? null : h('button', {
          class: 'trk-board-add', type: 'button', 'aria-label': elementMode ? `New ticket in ${item.name}` : `New issue in ${item.name}`,
          onclick: () => openCreate(item.key),
        }, '+'),
      );
      const cards = tickets.map((ticket) => {
        const menuButton = readOnly ? null : h('button', {
          class: 'trk-board-menu-button', type: 'button', 'aria-label': `Actions for ${ticket.key}`, 'aria-haspopup': 'dialog',
          onclick: (event: Event) => { event.stopPropagation(); openBoardMovePicker(ticket, event.currentTarget as HTMLElement); },
        }, '⋯');
        const labels = ticket.labels.slice(0, 2).map((label) => labelChip(label.name, label.color));
        if (ticket.labels.length > 2) labels.push(h('span', { class: 'trk-board-label-count' }, `+${ticket.labels.length - 2}`));
        const title = h('button', { class: 'trk-board-card-title', type: 'button', onclick: (event: Event) => { event.stopPropagation(); openTicket(ticket.key); } }, ticket.title);
        const card = h('article', {
          class: 'trk-board-card', tabindex: '0', 'data-key': ticket.key,
          'aria-label': `${ticket.key}: ${ticket.title}`,
          onclick: (event: Event) => { if (!(event.target as HTMLElement | null)?.closest('button')) openTicket(ticket.key); },
          onkeydown: (event: KeyboardEvent) => {
            if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); moveBoardByStep(ticket, -1, event.currentTarget as HTMLElement); }
            else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); moveBoardByStep(ticket, 1, event.currentTarget as HTMLElement); }
            else if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 's' && event.target === event.currentTarget) {
              event.preventDefault(); openBoardMovePicker(ticket, event.currentTarget as HTMLElement);
            }
            else if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); openTicket(ticket.key); }
          },
        },
          elementMode
            ? (menuButton ? h('div', { class: 'trk-board-card-menu' }, menuButton) : null)
            : h('div', { class: 'trk-board-card-top' }, keyChip(ticket.key), menuButton),
          title,
          elementMode ? h('div', { class: 'trk-board-card-key' }, keyChip(ticket.key)) : null,
          h('div', { class: 'trk-board-card-meta' },
            h('span', { class: 'trk-board-priority', 'aria-label': priorityLabel(ticket.priority) }, priorityGlyph(ticket.priority)),
            ticket.assignee ? avatar({ kind: 'person', name: ticket.assignee.name }) : null,
            dueChip(ticket.due, Date.now(), ticket.state.category === 'completed' || ticket.state.category === 'canceled'),
          ),
          labels.length ? h('div', { class: 'trk-board-labels' }, ...labels) : null,
        );
        // TAB-354: the full-screen board drags too (it only ever worked in the element); a phone shows one lane at a time, so it keeps the move menu
        if (!phone) {
          card.classList.toggle('is-draggable', !readOnly);
          card.addEventListener('pointerdown', (event) => beginCardPointer(event, ticket, card));
          if (boardDrag?.active && boardDrag.ticket.key === ticket.key) card.classList.add('is-dragging');
        }
        return card;
      });
      const laneBody = h('div', { class: 'trk-board-lane-cards' }, ...cards,
        cards.length === 0 && !cache.nextCursor ? h('p', { class: 'trk-board-lane-empty' }, elementMode ? 'No tickets' : 'No issues') : null,
        cache.nextCursor ? h('button', {
          class: 'trk-load-more', type: 'button', disabled: cache.loadingMore,
          onclick: () => void options.store.loadMore(entry?.query ?? boardQuery(item)).catch((error: unknown) => showBoardError(error instanceof Error ? error.message : `Could not load more ${noun}.`, entry?.query ?? boardQuery(item))),
        }, cache.loadingMore ? 'Loading…' : 'Load more') : null,
      );
      const lane = h('section', { class: 'trk-board-lane', 'data-state': item.key, 'aria-label': `${item.name}, ${tickets.length} ${noun}` }, header, laneBody);
      lane.classList.toggle('is-drop-target', boardDrag?.active === true && boardDrag.over === item.key);
      return lane;
    }));
    if (boardErrorHost) {
      const entry = [...boardCaches.values()].find((value) => value.cache.error);
      boardErrorHost.hidden = !entry?.cache.error;
      if (entry?.cache.error) {
        boardErrorHost.replaceChildren(h('span', null, elementMode ? 'Could not load tickets' : entry.cache.error.message), h('button', {
          class: 'trk-small-button', type: 'button', onclick: () => void options.store.loadList(entry.query, { force: true }).catch((error: unknown) =>
            showBoardError(error instanceof Error ? error.message : 'Could not load board issues.', entry.query)),
        }, 'Retry'));
      } else boardErrorHost.replaceChildren();
    }
  };

  /** The lanes as the pointer sees them: each lane's box clipped to the strip that scrolls it. */
  const boardLaneRects = (): BoardLane[] => {
    if (!boardLanesHost) return [];
    const strip = boardLanesHost.getBoundingClientRect();
    return [...boardLanesHost.querySelectorAll<HTMLElement>('.trk-board-lane')].map((lane) => ({
      key: lane.dataset.state ?? '', rect: clipRect(lane.getBoundingClientRect(), strip),
    }));
  };
  const placeGhost = (drag: BoardDrag) => {
    if (!drag.ghost) return;
    const bounds = root.getBoundingClientRect();
    const originX = bounds.left + root.clientLeft * drag.scale;
    const originY = bounds.top + root.clientTop * drag.scale;
    drag.ghost.style.left = `${(drag.last.x - originX) / drag.scale - drag.grab.x}px`;
    drag.ghost.style.top = `${(drag.last.y - originY) / drag.scale - drag.grab.y}px`;
  };
  const updateDropLane = (drag: BoardDrag) => {
    const over = laneAtPoint(drag.last, boardLaneRects());
    if (over === drag.over) return;
    drag.over = over;
    for (const lane of boardLanesHost?.querySelectorAll<HTMLElement>('.trk-board-lane') ?? []) {
      lane.classList.toggle('is-drop-target', drag.active && over !== null && over !== drag.ticket.state.key && lane.dataset.state === over);
    }
  };
  /** Each frame while dragging: the strip scrolls when the pointer is at its edge, and the lane under the pointer follows the scroll. */
  const dragFrame = () => {
    const drag = boardDrag;
    if (!drag?.active) return;
    if (boardLanesHost) {
      const strip = boardLanesHost.getBoundingClientRect();
      if (drag.last.y >= strip.top && drag.last.y <= strip.bottom) {
        const delta = autoScrollDelta(drag.last.x, strip, AUTO_SCROLL_EDGE_PX);
        if (delta !== 0) boardLanesHost.scrollLeft += delta / drag.scale;
      }
    }
    updateDropLane(drag);
    drag.frame = requestAnimationFrame(dragFrame);
  };
  const startDrag = (drag: BoardDrag) => {
    if (drag.active || boardDrag !== drag || readOnly) return;
    drag.active = true;
    if (drag.timer !== undefined) clearTimeout(drag.timer);
    drag.timer = undefined;
    const ghost = drag.card.cloneNode(true) as HTMLElement;
    ghost.classList.add('trk-board-ghost');
    ghost.classList.remove('is-dragging');
    ghost.removeAttribute('tabindex');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${drag.card.getBoundingClientRect().width / drag.scale}px`;
    root.appendChild(ghost);
    drag.ghost = ghost;
    drag.card.classList.add('is-dragging');
    root.classList.add('is-dragging');
    window.addEventListener('keydown', onDragKey, true);
    window.addEventListener('touchmove', onDragTouchMove, { passive: false });
    placeGhost(drag);
    updateDropLane(drag);
    drag.frame = requestAnimationFrame(dragFrame);
  };
  /** The click that the release of a drag makes (on the lane or the card) must not also open the card; it is the only click in the lanes that is blocked. */
  const suppressDragClick = () => {
    const done = () => {
      window.removeEventListener('click', block, true);
      window.removeEventListener('pointerdown', done, true);
    };
    const block = (event: Event) => {
      done();
      if (!boardLanesHost?.contains(event.target as Node)) return;
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener('click', block, true);
    window.addEventListener('pointerdown', done, true);
    window.setTimeout(done, 400);
  };
  const endDrag = (suppressClick = false) => {
    const drag = boardDrag;
    boardDrag = null;
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('pointercancel', onDragCancel);
    window.removeEventListener('keydown', onDragKey, true);
    window.removeEventListener('touchmove', onDragTouchMove);
    if (!drag) return;
    if (drag.timer !== undefined) clearTimeout(drag.timer);
    if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
    drag.ghost?.remove();
    drag.card.classList.remove('is-dragging');
    root.classList.remove('is-dragging');
    for (const lane of boardLanesHost?.querySelectorAll('.trk-board-lane.is-drop-target') ?? []) lane.classList.remove('is-drop-target');
    if (suppressClick && drag.active) suppressDragClick();
  };
  function onDragPointerMove(event: PointerEvent) {
    const drag = boardDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.last = { x: event.clientX, y: event.clientY };
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) <= DRAG_THRESHOLD_PX) return;
      // a touch that moves before its long press is a scroll of the lanes, not a drag
      if (drag.pointerType === 'touch') { endDrag(); return; }
      startDrag(drag);
    }
    placeGhost(drag);
    updateDropLane(drag);
  }
  function onDragPointerUp(event: PointerEvent) {
    const drag = boardDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) { endDrag(); return; } // a press without a drag is a click on the card
    const target = laneAtPoint({ x: event.clientX, y: event.clientY }, boardLaneRects());
    const ticket = drag.ticket;
    endDrag(true);
    // releasing over the lane it came from, or outside every lane, cancels
    if (target && target !== ticket.state.key) void dropTicket(ticket, target);
  }
  function onDragCancel(event: PointerEvent) {
    if (boardDrag && event.pointerId === boardDrag.pointerId) endDrag();
  }
  function onDragKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !boardDrag?.active) return;
    event.preventDefault();
    event.stopPropagation();
    endDrag(true);
  }
  function onDragTouchMove(event: TouchEvent) {
    if (boardDrag?.active) event.preventDefault();
  }
  const beginCardPointer = (event: PointerEvent, ticket: TrackerTicket, card: HTMLElement) => {
    // a press on the card is the card's: it never reaches the wrapper (which would pan the board) and never starts a canvas gesture
    if ((event.target as HTMLElement | null)?.closest('.trk-board-menu-button')) return;
    if (event.pointerType !== 'touch') options.onPointerPress?.();
    event.stopPropagation();
    if (event.button !== 0 || boardDrag || readOnly || destroyed) return;
    const rect = card.getBoundingClientRect();
    const scale = scaleOf(root.getBoundingClientRect(), root.offsetWidth);
    const drag: BoardDrag = {
      pointerId: event.pointerId, pointerType: event.pointerType, ticket, card,
      start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY },
      grab: { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }, scale,
      ghost: null, active: false, over: null, timer: undefined, frame: undefined,
    };
    boardDrag = drag;
    if (event.pointerType === 'touch') drag.timer = window.setTimeout(() => { if (boardDrag === drag) startDrag(drag); }, LONG_PRESS_MS);
    window.addEventListener('pointermove', onDragPointerMove);
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('pointercancel', onDragCancel);
  };
  /** A drop: the card moves to the lane at once, then the store confirms it (one undo) or the move is reverted with a message. */
  const dropTicket = async (ticket: TrackerTicket, stateKey: string) => {
    const from = ticket.state.key;
    if (readOnly || !meta?.states.some((item) => item.key === stateKey)) return;
    const move = { ticket, stateKey, settled: false };
    pendingMoves.set(ticket.key, move);
    renderBoardContents();
    let moved: TrackerTicket;
    try {
      moved = await options.store.transitionTicket(ticket.key, stateKey);
    } catch {
      pendingMoves.delete(ticket.key);
      renderBoardContents();
      toast('Could not move the ticket.');
      return;
    }
    move.settled = true;
    recordUndo('State changed', async () => {
      await options.store.transitionTicket(ticket.key, from);
      await refreshBoard();
    });
    announce(`${moved.key} moved to ${moved.state.name}`);
    // the lanes reload first, so the card does not flash back to its old lane; the copy in the lanes ends once they show the move
    await refreshBoard().catch(() => undefined);
    renderBoardContents();
  };
  const startBoardWatch = () => {
    stopList?.();
    stopBoardWatch();
    if (state.tab !== 'board' || !meta) return;
    for (const item of boardStates()) {
      const query = boardQuery(item);
      boardCaches.set(item.key, { state: item, query, cache: options.store.list(query) });
      stopBoard.push(options.store.watchList(query, (cache) => {
        boardCaches.set(item.key, { state: item, query, cache });
        try { renderBoardContents(); }
        catch (error) { showBoardError(error instanceof Error ? error.message : 'Could not render board issues.', query); }
      }));
    }
    renderBoardContents();
  };
  const renderBoardPage = () => {
    boardErrorHost = h('div', { class: 'trk-board-error', role: 'alert', hidden: true });
    boardLaneStrip = h('nav', { class: 'trk-board-state-strip', role: 'tablist', 'aria-label': 'Board states' });
    boardLanesHost = h('div', { class: 'trk-board-lanes' });
    // an element has no view bar or state strip: its lanes scroll sideways in the element's own header-less body
    const board = elementMode
      ? h('section', { class: 'trk-board-view trk-board-element', 'aria-label': 'Tracker board' }, boardErrorHost, boardLanesHost)
      : h('section', { class: 'trk-board-view', 'aria-label': 'Tracker board' },
        h('header', { class: 'trk-board-viewbar' }, h('strong', null, 'Board')),
        boardErrorHost, boardLaneStrip, boardLanesHost,
      );
    content.replaceChildren(board);
    startBoardWatch();
  };

  function renderPage() {
    if (destroyed) return;
    endDrag();
    stopBoardWatch();
    // the element's empty flag reads the All view only; the board has its own lanes
    if (elementMode && state.tab === 'board') elementEmpty = false;
    destroyInbox();
    destroyTicketPage();
    renderTabs();
    updateActions();
    if (state.ticketKey) { renderTicket(); return; }
    if (state.tab === 'all' || state.tab === 'my') {
      const all = makeAllIssues();
      updateSelectionBar = all.updateSelectionBar;
      content.replaceChildren(all.tab);
      startWatch();
      all.updateSelectionBar();
      drawRows(currentCache);
      return;
    }
    stopList?.();
    listRenderHost = null;
    listLoadMore = null;
    filterController = null;
    if (state.tab === 'inbox') {
      const host = h('div', { class: 'trk-inbox-host' });
      content.replaceChildren(host);
      inboxController = mountInbox(host, {
        api: options.api,
        onOpenTicket: (key) => openTicket(key),
        onUnreadChange: (count) => {
          unreadCount = Math.max(0, Math.floor(count));
          renderTabs();
        },
      });
      publishCurrentSnapshot();
      return;
    }
    if (state.tab === 'board') {
      renderBoardPage();
      publishCurrentSnapshot();
      return;
    }
    renderProjectsPage();
  }

  function watchQuery() {
    if ((state.tab !== 'all' && state.tab !== 'my') || (state.ticketKey && !peekAllowed()) || destroyed) return;
    startWatch();
  }

  function setFullscreen(value: boolean) {
    fullScreen = value;
    if (value) layoutWidth = window.innerWidth;
    else if (options.layoutWidth !== undefined) layoutWidth = options.layoutWidth;
    root.dataset.fullscreen = String(value);
    fullscreenStrip.hidden = !value;
    if (!elementMode) {
      fullscreenButton.textContent = value ? '↙' : '↗';
      fullscreenButton.setAttribute('aria-label', value ? 'Back to board' : 'Open full screen');
    }
    renderPage();
    options.onFullscreenChange?.(value);
  }

  function setTicket(key: string | null) {
    // a side panel closes back to its row, so the focus that was in the panel goes to the row it came from
    const closingPeek = key === null && state.ticketKey && peekAllowed() ? state.ticketKey : null;
    state.ticketKey = key;
    ticketError = '';
    options.onTicketChange?.(key);
    renderPage();
    if (closingPeek) (root.querySelector<HTMLElement>(`[data-key="${CSS.escape(closingPeek)}"]`) ?? root).focus({ preventScroll: true });
  }

  const openCommand = () => {
    const items = buildCommandItems();
    openCommandBox(commandButton, {
      items,
      searchTickets: async (query): Promise<CommandItem[]> => {
        const cache = await options.store.loadList({ q: query, limit: 10 });
        return cache.tickets.map((ticket) => ({ id: `ticket:${ticket.key}`, kind: 'ticket', label: `${ticket.key} ${ticket.title}`, key: ticket.key, hint: ticket.state.name, snippet: ticket.snippet }));
      },
      onSelect: (item) => {
        if (item.kind === 'tab') switchTab(item.id.slice(4) as TrackerView);
        else if (item.kind === 'ticket' && item.key) openTicket(item.key);
      },
    });
  };

  const showShortcuts = () => {
    const body = h('div', { class: 'trk-shortcuts' }, ...SHORTCUTS.map((row) => h('div', { class: 'trk-shortcut-row' }, h('kbd', null, row.keys), h('span', null, row.description))));
    dialog('Keyboard shortcuts', body, [], { className: 'trk trk-modal trk-shortcuts-back' });
  };

  const dispatch = (action: TrackerAction) => {
    if (action.type === 'sequence-pending') pendingSequence = { key: action.key, expiresAt: action.expiresAt };
    else if (action.type === 'switch-tab') switchTab(action.tab);
    else if (action.type === 'command-box') openCommand();
    else if (action.type === 'create') openCreate();
    else if (action.type === 'expand') setFullscreen(!fullScreen);
    else if (action.type === 'open-filter') filterController?.open();
    else if (action.type === 'focus-search') filterController?.focusSearch();
    else if (action.type === 'shortcut-sheet') showShortcuts();
    else if (action.type === 'move-cursor' && listModel) {
      listModel = moveCursor(listModel, action.delta);
      if (action.extend && listModel.cursorKey) listModel = extendSelection(listModel, listModel.cursorKey);
      state.cursorKey = listModel.cursorKey; state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      drawRows(currentCache); updateSelectionBar();
      const row = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(state.cursorKey ?? '')}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
      const ticket = listModel.visibleRows.find((item) => item.key === state.cursorKey);
      announce(ticket ? `${ticket.key}, ${ticket.title}` : 'No issue selected');
    } else if (action.type === 'move-to-edge' && listModel?.visibleRows.length) {
      const row = action.edge === 'first' ? listModel.visibleRows[0] : listModel.visibleRows.at(-1)!;
      state.cursorKey = row.key; listModel = moveCursorTo(listModel, row.key); drawRows(currentCache);
    } else if (action.type === 'page') {
      if (action.direction > 0) void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showListError(error instanceof Error ? error.message : 'Could not load more issues.'));
      else listRenderHost?.scrollTo({ top: 0 });
    } else if (action.type === 'toggle-selection' && listModel) {
      listModel = toggleSelection(listModel); state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      updateSelectionBar(); drawRows(currentCache); announce(`${state.selectedKeys.length} selected`);
    } else if (action.type === 'select-all' && listModel) {
      listModel = selectAll(listModel); state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      updateSelectionBar(); drawRows(currentCache); announce(`${state.selectedKeys.length} selected`);
    } else if (action.type === 'group' && listModel && listModel.groups.length) {
      const group = listModel.groups.find((candidate) => candidate.rows.some((row) => row.key === state.cursorKey)) ?? listModel.groups[0];
      if (group) {
        state.collapsedGroups = new Set(state.collapsedGroups);
        if (action.direction < 0) state.collapsedGroups.add(group.id);
        else state.collapsedGroups.delete(group.id);
        drawRows(currentCache);
      }
    } else if ((action.type === 'open-ticket' || action.type === 'peek') && state.cursorKey) openTicket(state.cursorKey);
    else if ((action.type === 'copy-link' || action.type === 'copy-key') && state.cursorKey) {
      const path = buildTrackerPath({ kind: 'ticket', key: state.cursorKey });
      const value = action.type === 'copy-key' ? state.cursorKey : `${location.origin}${path ?? '/t/' + encodeURIComponent(state.cursorKey)}`;
      const clipboard = navigator.clipboard;
      if (!clipboard) toast('Clipboard access is not available.');
      else void clipboard.writeText(value).then(() => toast(action.type === 'copy-key' ? 'Ticket key copied' : 'Ticket link copied'))
        .catch(() => toast('Could not copy the ticket link.'));
    }
    else if (action.type === 'open-picker' && listModel && state.cursorKey) {
      const ticket = currentCache.tickets.find((item) => item.key === state.cursorKey);
      const anchor = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(state.cursorKey)}"]`);
      if (ticket && anchor) void editOne(ticket, action.field, anchor);
    } else if (action.type === 'archive') {
      if (!state.selectedKeys.length && state.cursorKey) state.selectedKeys = [state.cursorKey];
      void doBulk({ archived: true });
    }
    else if (action.type === 'undo' && lastUndoAction) void runUndo();
    else if (action.type === 'redo') toast('Redo is not available yet.');
    else if (action.type === 'escape') {
      const layer = action.layer;
      if (layer === 'picker') closePopover();
      else if (layer === 'filter') filterController?.close();
      else if (layer === 'ticket') setTicket(null);
      else if (layer === 'fullscreen') setFullscreen(false);
      else if (layer === 'work') options.onWorkExit?.();
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (!active()) return;
    const target = event.target as HTMLElement | null;
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    if (!fullScreen && !root.contains(target) && !target?.closest('.trk-pop')) return;
    if (state.tab === 'my' && !isTextTarget(event.target) && !isNativeActivationTarget(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      setMySubtab(event.key === '[' ? 'active' : 'created');
      return;
    }
    // Escape in the filter field with text in it clears the text first (the field's own handler); the next one leaves
    if (event.key === 'Escape' && target instanceof HTMLInputElement && target.classList.contains('trk-filter-input') && target.value && !filterController?.suggestionsOpen()) return;
    const layers: KeyboardLayer[] = [];
    if (!fullScreen) layers.push('work');
    if (fullScreen) layers.push('fullscreen');
    if (state.ticketKey) layers.push('ticket');
    if (filterController?.suggestionsOpen()) layers.push('filter');
    if (document.querySelector('.trk-pop')) layers.push('picker');
    const focusOwner = isTextTarget(event.target) ? 'text' : target?.closest('.trk-pop') ? 'picker' : 'tracker';
    const gridFocus = Boolean(target?.closest('.trk-list-grid'));
    const resolved = resolveKey({ active: true, focusOwner, gridFocus, pickerOpen: document.querySelector('.trk-pop') !== null, layers, pendingSequence }, event);
    pendingSequence = resolved.pendingSequence ?? null;
    if (resolved.action) dispatch(resolved.action);
  };
  document.addEventListener('keydown', onKey, true);
  stopKeyListener = () => document.removeEventListener('keydown', onKey, true);

  commandButton.addEventListener('click', openCommand);
  newButton.addEventListener('click', () => openCreate());
  fullscreenButton.addEventListener('click', () => {
    if (elementMode && options.onOpenFullScreen) options.onOpenFullScreen();
    else setFullscreen(!fullScreen);
  });
  elementMenuButton.addEventListener('click', () => openElementMenu(elementMenuButton));
  elementViewsButton.addEventListener('click', () => openElementViews(elementViewsButton));
  stopStore = options.store.subscribe((snapshot) => {
    meta = snapshot.meta ?? meta;
    if (snapshot.metaError) showError(snapshot.metaError.message);
    updateActions();
    if (elementMode) renderElementHeader();
    if (snapshot.meta && (state.tab === 'all' || state.tab === 'my') && !state.ticketKey && !stopList) startWatch();
    if (snapshot.meta && state.tab === 'board' && !state.ticketKey && stopBoard.length === 0) startBoardWatch();
    if (!snapshot.metaLoading && !meta && !snapshot.metaError) showError('Tracker information could not be loaded.');
  });
  const onOnline = () => updateActions();
  const onWindowResize = () => {
    if (!fullScreen) return;
    layoutWidth = window.innerWidth;
    if (state.ticketKey) renderPage();
    else if (state.tab === 'board') renderBoardContents();
    else { renderTabs(); drawRows(currentCache); }
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  window.addEventListener('resize', onWindowResize);
  void options.store.loadMeta().then((loaded) => {
    meta = loaded;
    updateActions();
    if (elementMode) void options.store.listViews().catch(() => undefined);
    if (elementMode && state.viewId) void restoreView(state.viewId);
    else if (state.tab === 'all' || state.tab === 'my') startWatch();
    else if (state.tab === 'board') startBoardWatch();
  }).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker information.'));
  renderPage();

  return {
    el: root,
    focus() { root.focus({ preventScroll: true }); },
    setFullscreen,
    refreshAccess() { if (!destroyed) updateActions(); },
    setTicket,
    updateLayout(width) { layoutWidth = width; if (state.ticketKey) renderPage(); else if (state.tab === 'board') renderBoardContents(); else { renderTabs(); drawRows(currentCache); } },
    state,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener('focusout', rescueFocus, true);
      endDrag(); stopList?.(); stopBoardWatch(); stopStore?.(); stopKeyListener?.();
      destroyInbox(); destroyTicketPage();
      if (debounce !== undefined) clearTimeout(debounce);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOnline);
      window.removeEventListener('resize', onWindowResize);
      window.visualViewport?.removeEventListener('resize', publishKeyboard);
      window.visualViewport?.removeEventListener('scroll', publishKeyboard);
      root.remove();
    },
  };
}
