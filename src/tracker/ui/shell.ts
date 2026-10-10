import './tracker.css';
import { closePopover, dialog, popover, toast } from '../../ui/common';
import { h } from '../../ui/dom';
import { TrackerError, type TrackerFacets, type TrackerListQuery, type TrackerMeta, type TrackerPriority, type TrackerSortField, type TrackerTicket, type TrackerView } from '../../tracker-types';
import type { TrackerStore } from '../../tracker-data';
import { build, parse, type FilterChip } from './filter';
import { createFilterBar, type FilterBarController } from './filter-bar';
import { keyChip, labelChip, relativeTime, dueChip } from './primitives';
import { priorityGlyph, priorityLabel, stateGlyph } from './glyphs';
import { buildListModel, moveCursor, moveCursorTo, selectAll, toggleSelection, extendSelection, type ListFacets, type ListGroupBy, type ListRenderModel, type TrackerRow } from './list-model';
import { buildCommandItems, openCommandBox, type CommandItem } from './command-box';
import { resolveKey, SHORTCUTS, type KeyboardLayer, type TrackerAction } from './keys';
import { openPicker, type PickerResult } from './picker';
import { openNewIssueDialog } from './new-issue';
import { publishTrackerSnapshot } from './frame-snapshot';

const TABS: ReadonlyArray<{ id: TrackerView; label: string; glyph: string }> = [
  { id: 'inbox', label: 'Inbox', glyph: '◉' },
  { id: 'my', label: 'My issues', glyph: '◎' },
  { id: 'all', label: 'All issues', glyph: '≡' },
  { id: 'board', label: 'Board', glyph: '▦' },
  { id: 'projects', label: 'Projects', glyph: '▤' },
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
const REQUIRED_COLUMNS = ['priority', 'key', 'state', 'title', 'assignee'] as const;
const OPTIONAL_COLUMNS = ['project', 'due', 'updated'] as const;
type Column = typeof REQUIRED_COLUMNS[number] | typeof OPTIONAL_COLUMNS[number];
type TrackerSort = { field: TrackerSortField; direction: 'asc' | 'desc' };

export interface TrackerViewerState {
  tab: TrackerView;
  viewId: string | null;
  filter: string[];
  queryText: string;
  group: ListGroupBy;
  sort: TrackerSort;
  density: 'comfortable' | 'compact';
  columns: Set<Column>;
  collapsedGroups: Set<string>;
  cursorKey: string | null;
  selectedKeys: string[];
  anchorKey: string | null;
  scrollTop: number;
  ticketKey: string | null;
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
    tab: defaultTab, viewId: null, filter: [], queryText: '', group: 'state', sort: { field: 'updatedAt', direction: 'desc' },
    density: 'comfortable', columns: new Set<Column>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]), collapsedGroups: new Set(),
    cursorKey: null, selectedKeys: [], anchorKey: null, scrollTop: 0, ticketKey: null,
  };
  byViewer.set(stateKey, state);
  return state;
}

export function visibleColumns(width: number, chosen: ReadonlySet<Column>): Column[] {
  const columns: Column[] = [...REQUIRED_COLUMNS];
  if (width >= 800 && chosen.has('project')) columns.push('project');
  if (width >= 920 && chosen.has('due')) columns.push('due');
  if (width >= 1080 && chosen.has('updated')) columns.push('updated');
  return columns;
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
  viewerId: string;
  trackerId: string;
  windowId?: string;
  initialTab?: TrackerView;
  initialViewId?: string;
  initialTicketKey?: string;
  fullScreen?: boolean;
  boardName?: string;
  layoutWidth?: number;
  readOnly?: boolean;
  onFullscreenChange?: (fullScreen: boolean) => void;
  onTicketChange?: (key: string | null) => void;
  onTabChange?: (tab: TrackerView, viewId?: string) => void;
  onWorkExit?: () => void;
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
  destroy(): void;
  state: TrackerViewerState;
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable || Boolean(element.closest('[contenteditable="true"]')));
}

function stableQuery(state: TrackerViewerState): TrackerListQuery {
  const supportedGroup = ['state', 'assignee', 'label'].includes(state.group) ? state.group : null;
  return {
    filter: [...state.filter], q: state.queryText.trim() || undefined, limit: 50, includeFacets: true, group: supportedGroup,
    sort: { ...state.sort },
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

export function renderTicketPage(key: string, title: string, onBack?: () => void): HTMLElement {
  return h('section', { class: 'trk-ticket-stub', 'aria-label': `Ticket ${key}` },
    h('button', { class: 'trk-ticket-back', type: 'button', onclick: onBack }, '← All issues'),
    h('h1', null, key),
    h('p', null, title),
    h('p', { class: 'trk-muted' }, 'Ticket page — next tracker slice'),
  );
}

export function mountTrackerShell(parent: HTMLElement, options: TrackerShellOptions): TrackerShellController {
  const state = trackerViewerState(options.store, options.viewerId, options.windowId ?? options.trackerId, options.initialTab);
  state.viewId = options.initialViewId ?? state.viewId;
  state.ticketKey = options.initialTicketKey ?? state.ticketKey;
  let fullScreen = options.fullScreen === true;
  let meta = options.store.snapshot().meta;
  let readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
  let currentCache = options.store.list(stableQuery(state));
  let listModel: ListRenderModel | null = null;
  let stopList: (() => void) | null = null;
  let stopStore: (() => void) | null = null;
  let stopKeyListener: (() => void) | null = null;
  let debounce: number | undefined;
  let listRenderHost: HTMLElement | null = null;
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
  const fullscreenStrip = h('div', { class: 'trk-fullscreen-strip', hidden: !fullScreen },
    h('span', { class: 'trk-board-name' }, options.boardName ?? 'Tracker'),
    h('button', { class: 'trk-small-button', type: 'button', onclick: () => setFullscreen(false) }, 'Back to board'),
  );
  const tabs = h('nav', { class: 'trk-tabs', role: 'tablist', 'aria-label': 'Tracker sections' });
  const commandButton = h('button', { class: 'trk-command-trigger', type: 'button', 'aria-label': 'Open command box, Command or Control K' }, '⌘K');
  const newButton = h('button', { class: 'trk-primary-button trk-new-trigger', type: 'button' }, '+ New issue');
  const fullscreenButton = h('button', { class: 'trk-icon-button', type: 'button', 'aria-label': fullScreen ? 'Back to board' : 'Open full screen' }, fullScreen ? '↙' : '↗');
  const offlineLine = h('div', { class: 'trk-offline-line', role: 'status', hidden: typeof navigator === 'undefined' || navigator.onLine !== false },
    h('span', null, 'Offline. Changes are saved here and will sync.'),
    h('span', { class: 'trk-offline-create-reason' }, 'Needs a connection to get a ticket number.'),
  );
  const errorBanner = h('div', { class: 'trk-error-banner', role: 'alert', hidden: true });
  const content = h('div', { class: 'trk-content' });
  const live = h('div', { class: 'trk-live-region', 'aria-live': 'polite', 'aria-atomic': 'true' });
  root.append(fullscreenStrip, h('header', { class: 'trk-header' }, tabs,
    h('div', { class: 'trk-header-actions' }, commandButton, newButton, fullscreenButton)),
  offlineLine, errorBanner, content, live);
  parent.appendChild(root);
  root.dataset.width = String(layoutWidth);

  const announce = (message: string) => { live.textContent = message; };
  const runUndo = async () => {
    const undo = lastUndoAction;
    if (!undo) return;
    lastUndoAction = null;
    try { await undo(); announce('Change undone'); toast('Change undone'); }
    catch { toast('The change could not be undone.'); }
  };
  const active = () => !destroyed && (options.active?.() ?? (root === document.activeElement || root.contains(document.activeElement) || fullScreen));
  const updateActions = () => {
    readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
    newButton.hidden = readOnly;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    offlineLine.hidden = !offline;
    newButton.disabled = offline;
    if (offline) newButton.setAttribute('aria-description', 'Needs a connection to get a ticket number.');
    else newButton.removeAttribute('aria-description');
  };

  const showError = (message: string) => {
    errorBanner.replaceChildren(h('span', null, message), h('button', { class: 'trk-small-button', type: 'button', onclick: () => {
      errorBanner.hidden = true;
      void options.store.loadMeta(true).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker data.'));
      if (state.tab === 'all') watchQuery();
    } }, 'Retry'));
    errorBanner.hidden = false;
  };

  const renderTabs = () => {
    tabs.replaceChildren(...TABS.map((tab) => h('button', {
      class: `trk-tab${state.tab === tab.id ? ' active' : ''}`, type: 'button', role: 'tab',
      'aria-selected': String(state.tab === tab.id), 'aria-label': tab.label,
      onclick: () => { state.tab = tab.id; state.viewId = null; state.ticketKey = null; options.onTabChange?.(tab.id); renderPage(); },
    }, h('span', { class: 'trk-tab-glyph', 'aria-hidden': 'true' }, tab.glyph), h('span', { class: 'trk-tab-name' }, tab.label))));
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

  const startWatch = () => {
    stopList?.();
    if (!meta || state.tab !== 'all' || state.ticketKey) return;
    const query = stableQuery(state);
    currentCache = options.store.list(query);
    stopList = options.store.watchList(query, (cache) => {
      currentCache = cache;
      drawRows(cache);
      publishCurrentSnapshot();
      if (cache.error) showError(cache.error.message);
    });
  };

  const rowButton = (text: string, label: string, action: () => void, className = 'trk-cell-button'): HTMLButtonElement =>
    h('button', { class: className, type: 'button', 'aria-label': label, onclick: (event: Event) => { event.stopPropagation(); action(); } }, text);

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
        const picked = await openPicker<string>(anchor, { label: 'State', options: info.states.map((item) => ({ value: item.id, label: item.name })), value: ticket.state.id });
        if (typeof picked === 'string' && picked !== ticket.state.id) {
          const next = await options.store.transitionTicket(ticket.key, picked);
          recordUndo('State changed', () => options.store.transitionTicket(ticket.key, ticket.state.id));
          announce(`${next.key} moved to ${next.state.name}`);
        }
      } else if (field === 'assignee') {
        const picked = await openPicker<string>(anchor, { label: 'Assignee', options: info.members.map((item) => ({ value: item.userId, label: item.name })), value: ticket.assignee?.userId ?? null });
        if ((picked === null || typeof picked === 'string') && picked !== (ticket.assignee?.userId ?? null)) {
          await options.store.updateTicket(ticket.key, { assignee: picked });
          recordUndo('Assignee changed', () => options.store.updateTicket(ticket.key, { assignee: ticket.assignee?.userId ?? null }));
          announce(`${ticket.key} assigned to ${picked === null ? 'no one' : info.members.find((member) => member.userId === picked)?.name ?? picked}`);
        }
      } else if (field === 'priority') {
        const priorities: TrackerPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];
        const picked = await openPicker<TrackerPriority>(anchor, { label: 'Priority', options: priorities.map((value) => ({ value, label: priorityLabel(value) })), value: ticket.priority });
        if (typeof picked === 'string' && picked !== ticket.priority) {
          await options.store.updateTicket(ticket.key, { priority: picked });
          recordUndo('Priority changed', () => options.store.updateTicket(ticket.key, { priority: ticket.priority }));
        }
      } else if (field === 'labels') {
        const picked = await openPicker<string>(anchor, { label: 'Labels', multi: true, selected: ticket.labels.map((label) => label.id), options: info.labels.map((item) => ({ value: item.id, label: item.name })) });
        if (Array.isArray(picked)) {
          const labels = picked.filter((value): value is string => typeof value === 'string');
          await options.store.updateTicket(ticket.key, { labels });
          recordUndo('Labels changed', () => options.store.updateTicket(ticket.key, { labels: ticket.labels.map((label) => label.id) }));
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
        const projects = [...new Map(currentCache.tickets.flatMap((row) => row.project ? [[row.project.id, row.project.name] as const] : [])).entries()]
          .map(([id, name]) => ({ value: id, label: name }));
        if (!projects.length) { toast('Projects are not available yet.'); return; }
        const picked = await openPicker<string>(anchor, { label: 'Project', options: projects, value: ticket.project?.id ?? null });
        if (picked !== undefined) toast('Project updates are not available in the tracker store yet.');
      }
    } catch (caught) {
      if (caught instanceof TrackerError && caught.code === 'conflict') {
        const current = caught.current ? valueFor(caught.current, field) : valueFor(ticket, field);
        toast(`Mara changed this at the same time. Current value kept: ${current}`, 5000);
      } else toast(caught instanceof Error ? caught.message : 'The issue could not be updated.');
    }
  };

  const doBulk = async (patch: { state?: string; assignee?: string | null; priority?: TrackerPriority; labels?: string[]; due?: string | null; archived?: boolean }) => {
    if (readOnly || !state.selectedKeys.length) return;
    try {
      let undoBatch: Awaited<ReturnType<TrackerStore['bulk']>> | undefined;
      if (patch.state) {
        // The current bulk store contract has no state field; transition one ticket at a time until that API lands.
        const before = state.selectedKeys.map((key) => [key, currentCache.tickets.find((ticket) => ticket.key === key)?.state.id] as const);
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
        const count = state.selectedKeys.length;
        toast(patch.archived ? `${count} issues archived` : `${count} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      }
      if (patch.state) toast(`${state.selectedKeys.length} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      state.selectedKeys = [];
      announce('Selection cleared');
      drawRows(currentCache);
      updateSelectionBar();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'The selected issues could not be updated.');
    }
  };

  const bulkPicker = (anchor: HTMLElement, field: 'state' | 'assignee' | 'priority' | 'labels' | 'due') => {
    const info = getMeta();
    if (!info || !state.selectedKeys.length) return;
    if (field === 'state') renderMenu(anchor, 'State', info.states.map((item) => ({ value: item.id, label: item.name })), '', (value) => void doBulk({ state: value }));
    else if (field === 'assignee') renderMenu(anchor, 'Assignee', [{ value: '__none', label: 'No one' }, ...info.members.map((item) => ({ value: item.userId, label: item.name }))], '', (value) => void doBulk({ assignee: value === '__none' ? null : value }));
    else if (field === 'priority') renderMenu(anchor, 'Priority', ['urgent', 'high', 'medium', 'low', 'none'].map((value) => ({ value, label: priorityLabel(value as TrackerPriority) })), '', (value) => void doBulk({ priority: value as TrackerPriority }));
    else if (field === 'labels') renderMenu(anchor, 'Labels', info.labels.map((item) => ({ value: item.id, label: item.name })), '', (value) => void doBulk({ labels: [value] }));
    else renderMenu(anchor, 'Due date', [{ value: '__none', label: 'No date' }, { value: new Date().toISOString().slice(0, 10), label: 'Today' }], '', (value) => void doBulk({ due: value === '__none' ? null : value }));
  };

  const drawRows = (cache: typeof currentCache) => {
    if (!listRenderHost || !resultsHost || !skeletonHost || !errorHost) return;
    if (!meta) {
      skeletonHost.hidden = false;
      listRenderHost.replaceChildren();
      resultsHost.textContent = '';
      return;
    }
    listModel = buildListModel({
      pages: [cache.tickets as unknown as TrackerRow[]], facets: listFacets(cache), group: state.group,
      sort: { field: state.sort.field === 'updatedAt' || state.sort.field === 'createdAt' || state.sort.field === 'priority' || state.sort.field === 'due' || state.sort.field === 'title' || state.sort.field === 'key' ? state.sort.field : 'updatedAt', direction: state.sort.direction },
      collapsedGroups: state.collapsedGroups, cursorKey: state.cursorKey, selectedKeys: state.selectedKeys, anchorKey: state.anchorKey,
    });
    state.cursorKey = listModel.cursorKey;
    state.selectedKeys = listModel.selectedKeys;
    state.anchorKey = listModel.anchorKey;
    skeletonHost.hidden = !(cache.loading && cache.tickets.length === 0);
    errorHost.hidden = !cache.error;
    if (cache.error) errorHost.textContent = cache.error.message;
    const filterActive = state.filter.length > 0 || Boolean(state.queryText.trim());
    if (!cache.loading && cache.tickets.length === 0) {
      listRenderHost.replaceChildren(h('div', { class: 'trk-empty-state' },
        h('h2', null, filterActive ? 'No issues match.' : 'No issues yet.'),
        filterActive
          ? h('button', { class: 'trk-small-button', type: 'button', onclick: () => { state.filter = []; state.queryText = ''; filterController?.setChips([]); if (filterController) filterController.focusSearch(); watchQuery(); } }, 'Clear filters')
          : (!readOnly ? h('button', { class: 'trk-primary-button', type: 'button', onclick: () => openCreate() }, '+ New issue') : null),
      ));
      resultsHost.textContent = '0 issues';
      return;
    }
    const columns = visibleColumns(layoutWidth, state.columns);
    const model = listModel;
    const selected = state.selectedKeys.length;
    const header = h('div', { class: 'trk-grid-header', role: 'row', style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') } },
      ...columns.map((column) => h('div', { role: 'columnheader', class: `trk-col-${column}` }, column === 'updated' ? 'Updated' : column[0].toUpperCase() + column.slice(1))),
    );
    const rows: Node[] = [header];
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
        }, groupTicket && state.group === 'state' ? stateGlyph(groupTicket.state.category, groupTicket.state.key) : null,
        h('span', null, group.label), h('span', { class: 'trk-muted' }, String(group.count)));
        rows.push(h('div', { class: 'trk-group-row', role: 'rowheader' }, headerButton));
      }
      if (group.collapsed) continue;
      for (const raw of group.rows) {
        const ticket = raw as unknown as TrackerTicket;
        const selectedHere = state.selectedKeys.includes(ticket.key);
        const cursor = state.cursorKey === ticket.key;
        const cells: Node[] = [];
        for (const column of columns) {
          if (column === 'priority') cells.push(h('div', { class: 'trk-cell trk-col-priority', role: 'gridcell' },
            readOnly ? priorityGlyph(ticket.priority) : h('button', { class: 'trk-glyph-button', type: 'button', 'aria-label': `${priorityLabel(ticket.priority)} for ${ticket.key}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'priority', event.currentTarget as HTMLElement); } }, priorityGlyph(ticket.priority)),
          ));
          else if (column === 'key') cells.push(h('div', { class: 'trk-cell trk-col-key', role: 'gridcell' }, keyChip(ticket.key)));
          else if (column === 'state') cells.push(h('div', { class: 'trk-cell trk-col-state', role: 'gridcell' },
            readOnly ? h('span', { class: 'trk-state-value' }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name))
              : h('button', { class: 'trk-cell-button trk-state-value', type: 'button', 'aria-label': `State: ${ticket.state.name}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'state', event.currentTarget as HTMLElement); } }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name)),
          ));
          else if (column === 'title') cells.push(h('div', { class: 'trk-cell trk-col-title', role: 'gridcell' },
            h('button', { class: 'trk-title-link', type: 'button', onclick: (event: Event) => { event.stopPropagation(); openTicket(ticket.key); } }, ticket.title),
            ...ticket.labels.slice(0, 2).map((label) => labelChip(label.name, label.color)),
            ticket.subIssueCount ? h('span', { class: 'trk-sub-count', 'aria-label': `${ticket.subIssueDone ?? 0} of ${ticket.subIssueCount} sub-issues complete` }, `${ticket.subIssueDone ?? 0}/${ticket.subIssueCount}`) : null,
          ));
          else if (column === 'project') cells.push(h('div', { class: 'trk-cell trk-col-project', role: 'gridcell' }, ticket.project?.name ?? '—'));
          else if (column === 'assignee') cells.push(h('div', { class: 'trk-cell trk-col-assignee', role: 'gridcell' }, ticket.assignee
            ? (readOnly ? ticket.assignee.name : rowButton(ticket.assignee.name.slice(0, 2).toUpperCase(), `Assignee: ${ticket.assignee.name}`, () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button'))
            : (readOnly ? '—' : rowButton('—', 'Assign issue', () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button')),
          ));
          else if (column === 'due') cells.push(h('div', { class: 'trk-cell trk-col-due', role: 'gridcell' },
            readOnly ? dueChip(ticket.due, now) : rowButton(ticket.due ?? '—', ticket.due ? `Due ${ticket.due}` : 'Set due date', () => void editOne(ticket, 'due', document.activeElement as HTMLElement)),
          ));
          else cells.push(h('div', { class: 'trk-cell trk-col-updated', role: 'gridcell' }, relativeTime(now, new Date(ticket.updatedAt).toISOString())));
        }
        const row = h('div', {
          class: `trk-list-row${cursor ? ' is-cursor' : ''}${selectedHere ? ' is-selected' : ''}`,
          role: 'row', tabindex: '-1', 'aria-selected': String(selectedHere), 'data-cursor': String(cursor), 'data-key': ticket.key,
          style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') },
          onclick: () => { state.cursorKey = ticket.key; openTicket(ticket.key); },
          onfocus: () => { state.cursorKey = ticket.key; },
        }, ...cells);
        if (!readOnly) {
          const select = h('button', { class: 'trk-row-select', type: 'button', 'aria-label': `${selectedHere ? 'Deselect' : 'Select'} ${ticket.key}`, 'aria-pressed': String(selectedHere), onclick: (event: Event) => { event.stopPropagation(); state.selectedKeys = toggleSelection(model, ticket.key).selectedKeys; state.anchorKey = ticket.key; announce(`${state.selectedKeys.length} selected`); updateSelectionBar(); drawRows(cache); } }, selectedHere ? '✓' : '');
          row.prepend(select);
        }
        rows.push(row);
      }
    }
    listRenderHost.replaceChildren(...rows);
    listRenderHost.setAttribute('aria-rowcount', String(model.visibleRows.length));
    if (cache.nextCursor) listRenderHost.appendChild(h('button', { class: 'trk-load-more', type: 'button', disabled: cache.loadingMore, onclick: () => void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load more issues.')) }, cache.loadingMore ? 'Loading…' : 'Load more'));
    const facets = facetsForGroup(state.group, cache.facets)?.[state.group];
    const total = facets?.reduce((sum, facet) => sum + facet.count, 0) ?? cache.tickets.length;
    resultsHost.textContent = cache.nextCursor ? `${total}+ issues` : `${total} ${total === 1 ? 'issue' : 'issues'}`;
    announce(selected ? `${selected} selected` : '');
  };

  const publishCurrentSnapshot = () => {
    const tickets = currentCache.tickets.slice(0, 12);
    const facets = facetsForGroup(state.group, currentCache.facets)?.[state.group];
    const count = facets?.reduce((sum, facet) => sum + facet.count, 0) ?? currentCache.tickets.length;
    publishTrackerSnapshot(options.trackerId, state.tab, tickets, count);
    options.onSnapshot?.();
  };

  const makeAllIssues = () => {
    const viewCapability = typeof (options.store as TrackerStore & { views?: unknown }).views === 'function' ||
      Array.isArray((getMeta() as (TrackerMeta & { views?: unknown[] }) | undefined)?.views);
    const availableViews = (getMeta() as (TrackerMeta & { views?: Array<{ id?: string; name?: string }> }) | undefined)?.views ?? [];
    const currentViewName = availableViews.find((view) => view.id === state.viewId)?.name ?? 'All issues';
    const viewMenu = viewCapability
      ? h('button', { class: 'trk-view-name', type: 'button', onclick: () => toast('Saved views are not available yet.') }, currentViewName)
      : h('span', { class: 'trk-view-name' }, currentViewName);
    const groupButton = h('button', { class: 'trk-view-button', type: 'button' }, `Group: ${GROUPS.find((item) => item.value === state.group)?.label ?? 'State'}`);
    const sortButton = h('button', { class: 'trk-view-button', type: 'button' }, `Sort: ${SORTS.find((item) => item.value === state.sort.field)?.label ?? 'Updated'} ${state.sort.direction === 'desc' ? '↓' : '↑'}`);
    const displayButton = h('button', { class: 'trk-view-button', type: 'button' }, 'Display');
    const count = h('span', { class: 'trk-results-count', 'aria-live': 'polite' });
    const selectionBar = h('div', { class: 'trk-selection-bar', hidden: true });
    const viewBar = h('div', { class: 'trk-view-bar' }, viewMenu, groupButton, sortButton, displayButton, count);
    filterController = createFilterBar({
      initial: parse(state.filter),
      onChange: (chips: readonly FilterChip[]) => {
        try { state.filter = build(chips); state.selectedKeys = []; watchQuery(); }
        catch (error) { showError(error instanceof Error ? error.message : 'Invalid filter.'); }
      },
      onSearch: (query: string) => {
        state.queryText = query;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = window.setTimeout(() => watchQuery(), 180);
      },
    });
    filterController.el.classList.add('trk-filter-host');
    const search = filterController.el.querySelector<HTMLInputElement>('.trk-search-input');
    if (search) search.value = state.queryText;
    const filterChips = (state.filter.length ? parse(state.filter).map((chip) => chip.value).join(' ') : '');
    if (filterChips) filterController.setChips(parse(state.filter));
    const table = h('div', { class: `trk-list-grid trk-density-${state.density}`, role: 'grid', 'aria-label': 'All issues' });
    const skeleton = h('div', { class: 'trk-skeleton-list', hidden: true, 'aria-hidden': 'true' }, ...Array.from({ length: 8 }, () => h('div', { class: 'trk-skeleton-row' }, h('i'), h('i'), h('i'), h('i'))));
    const error = h('div', { class: 'trk-list-error', role: 'alert', hidden: true });
    const host = h('div', { class: 'trk-list-host' }, error, skeleton, table);
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
      sortButton.textContent = `Sort: ${SORTS.find((item) => item.value === state.sort.field)?.label} ${state.sort.direction === 'desc' ? '↓' : '↑'}`;
      watchQuery();
    }));
    displayButton.addEventListener('click', () => {
      const panel = h('div', { class: 'trk-display-menu' }, h('strong', null, 'Density'));
      for (const density of ['comfortable', 'compact'] as const) panel.appendChild(h('button', { class: 'trk-display-option', type: 'button', 'aria-pressed': String(state.density === density), onclick: () => { state.density = density; table.className = `trk-list-grid trk-density-${density}`; closePopover(); } }, density[0].toUpperCase() + density.slice(1)));
      panel.appendChild(h('strong', null, 'Columns'));
      for (const column of OPTIONAL_COLUMNS) {
        const checkbox = h('input', { type: 'checkbox', checked: state.columns.has(column), 'aria-label': `${column} column`, onchange: () => { if (checkbox.checked) state.columns.add(column); else state.columns.delete(column); drawRows(currentCache); } });
        panel.appendChild(h('label', { class: 'trk-display-check' }, checkbox, column[0].toUpperCase() + column.slice(1)));
      }
      popover(displayButton, panel, { className: 'trk trk-pop trk-display-pop', label: 'Display issues' });
    });
    const updateSelectionBar = () => {
      const selectionCount = state.selectedKeys.length;
      selectionBar.hidden = selectionCount === 0;
      viewBar.hidden = selectionCount > 0;
      if (!selectionCount) return;
      selectionBar.replaceChildren(h('strong', null, `${selectionCount} selected`),
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
    const tab = h('section', { class: 'trk-all-issues' }, viewBarHost, filterController.el, host);
    return { tab, updateSelectionBar };
  };

  let updateSelectionBar = () => {};
  const openCreate = () => {
    const info = getMeta();
    if (!info || readOnly) return;
    openNewIssueDialog({ store: options.store, meta: info, viewerId: options.viewerId, trackerId: options.trackerId,
      defaultState: state.group === 'state' ? state.cursorKey ? options.store.list(stableQuery(state)).tickets.find((item) => item.key === state.cursorKey)?.state.id : undefined : undefined,
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
      onCreated: (key) => { options.onCreated?.(key); startWatch(); announce(`${key} created`); },
    });
  };

  function openTicket(key: string) {
    state.ticketKey = key;
    ticketError = '';
    options.onTicketChange?.(key);
    renderPage();
  }

  const renderTicket = () => {
    const cached = options.store.list(stableQuery(state)).tickets.find((ticket) => ticket.key === state.ticketKey);
    const ticketState = options.store.ticket(state.ticketKey ?? '');
    const ticket = cached ?? ticketState.ticket;
    if (!ticket && !ticketError) void options.store.loadTicket(state.ticketKey!, true).then((detail) => {
      if (state.ticketKey === detail.ticket.key) renderPage();
    }).catch(() => { ticketError = `${state.ticketKey} doesn't exist, or you don't have access.`; renderPage(); });
    content.replaceChildren(ticketError
      ? h('section', { class: 'trk-ticket-stub' }, h('h1', null, ticketError), h('button', { class: 'trk-small-button', type: 'button', onclick: () => setTicket(null) }, 'Go to All issues'))
      : ticket ? renderTicketPage(ticket.key, ticket.title, () => setTicket(null))
        : h('section', { class: 'trk-ticket-loading', role: 'status' }, `Loading ${state.ticketKey}…`));
  };

  function renderPage() {
    if (destroyed) return;
    renderTabs();
    updateActions();
    if (state.ticketKey) { stopList?.(); renderTicket(); return; }
    if (state.tab === 'all') {
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
    filterController = null;
    const selected = TABS.find((tab) => tab.id === state.tab)!;
    content.replaceChildren(h('section', { class: 'trk-coming-next' }, h('h1', null, selected.label), h('p', null, 'Not available yet.')));
    publishCurrentSnapshot();
  }

  function watchQuery() {
    if (state.tab !== 'all' || state.ticketKey || destroyed) return;
    startWatch();
  }

  function setFullscreen(value: boolean) {
    fullScreen = value;
    if (value) layoutWidth = window.innerWidth;
    else if (options.layoutWidth !== undefined) layoutWidth = options.layoutWidth;
    root.dataset.fullscreen = String(value);
    fullscreenStrip.hidden = !value;
    fullscreenButton.textContent = value ? '↙' : '↗';
    fullscreenButton.setAttribute('aria-label', value ? 'Back to board' : 'Open full screen');
    renderTabs();
    options.onFullscreenChange?.(value);
  }

  function setTicket(key: string | null) {
    state.ticketKey = key;
    if (!key) { ticketError = ''; options.onTicketChange?.(null); }
    renderPage();
  }

  const openCommand = () => {
    const items = buildCommandItems();
    openCommandBox(commandButton, {
      items,
      searchTickets: async (query): Promise<CommandItem[]> => {
        const cache = await options.store.loadList({ q: query, limit: 10, group: null });
        return cache.tickets.map((ticket) => ({ id: `ticket:${ticket.key}`, kind: 'ticket', label: `${ticket.key} ${ticket.title}`, key: ticket.key, hint: ticket.state.name }));
      },
      onSelect: (item) => {
        if (item.kind === 'tab') { state.tab = item.id.slice(4) as TrackerView; state.ticketKey = null; options.onTabChange?.(state.tab); renderPage(); }
        else if (item.kind === 'ticket' && item.key) openTicket(item.key);
      },
    });
  };

  const showShortcuts = () => {
    const body = h('div', { class: 'trk-shortcuts' }, ...SHORTCUTS.map((row) => h('div', { class: 'trk-shortcut-row' }, h('kbd', null, row.keys), h('span', null, row.description))));
    dialog('Keyboard shortcuts', body, [], { className: 'trk-shortcuts-back' });
  };

  const dispatch = (action: TrackerAction) => {
    if (action.type === 'sequence-pending') pendingSequence = { key: action.key, expiresAt: action.expiresAt };
    else if (action.type === 'switch-tab') { state.tab = action.tab; state.viewId = null; state.ticketKey = null; options.onTabChange?.(action.tab); renderPage(); }
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
      if (action.direction > 0) void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load more issues.'));
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
      const value = action.type === 'copy-key' ? state.cursorKey : `${location.origin}${location.pathname}#/t/${encodeURIComponent(state.cursorKey)}`;
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
    if (target?.closest('[role="dialog"][aria-modal="true"]')) return;
    if (!fullScreen && !root.contains(target) && !target?.closest('.trk-pop')) return;
    const layers: KeyboardLayer[] = [];
    if (!fullScreen) layers.push('work');
    if (fullScreen) layers.push('fullscreen');
    if (state.ticketKey) layers.push('ticket');
    if (filterController && !filterController.el.querySelector('.trk-filter-editor')?.hasAttribute('hidden')) layers.push('filter');
    if (document.querySelector('.trk-pop')) layers.push('picker');
    const focusOwner = isTextTarget(event.target) ? 'text' : target?.closest('.trk-pop') ? 'picker' : 'tracker';
    const resolved = resolveKey({ active: true, focusOwner, pickerOpen: document.querySelector('.trk-pop') !== null, layers, pendingSequence }, event);
    pendingSequence = resolved.pendingSequence ?? null;
    if (resolved.action) dispatch(resolved.action);
  };
  document.addEventListener('keydown', onKey, true);
  stopKeyListener = () => document.removeEventListener('keydown', onKey, true);

  commandButton.addEventListener('click', openCommand);
  newButton.addEventListener('click', openCreate);
  fullscreenButton.addEventListener('click', () => setFullscreen(!fullScreen));
  stopStore = options.store.subscribe((snapshot) => {
    meta = snapshot.meta ?? meta;
    if (snapshot.metaError) showError(snapshot.metaError.message);
    updateActions();
    if (snapshot.meta && state.tab === 'all' && !state.ticketKey && !stopList) startWatch();
    if (!snapshot.metaLoading && !meta && !snapshot.metaError) showError('Tracker information could not be loaded.');
  });
  const onOnline = () => updateActions();
  const onWindowResize = () => {
    if (!fullScreen) return;
    layoutWidth = window.innerWidth;
    renderTabs();
    drawRows(currentCache);
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  window.addEventListener('resize', onWindowResize);
  void options.store.loadMeta().then((loaded) => {
    meta = loaded;
    updateActions();
    if (state.tab === 'all') startWatch();
  }).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker information.'));
  renderPage();
  if (state.ticketKey) renderTicket();

  return {
    el: root,
    focus() { root.focus({ preventScroll: true }); },
    setFullscreen,
    setTicket,
    updateLayout(width) { layoutWidth = width; renderTabs(); drawRows(currentCache); },
    state,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopList?.(); stopStore?.(); stopKeyListener?.();
      if (debounce !== undefined) clearTimeout(debounce);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOnline);
      window.removeEventListener('resize', onWindowResize);
      root.remove();
    },
  };
}
