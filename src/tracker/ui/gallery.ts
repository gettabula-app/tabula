import { h } from '../../ui/dom';
import { actorBadgeGlyph, actorLabel, priorityGlyph, priorityLabel, prStateGlyph, prStateLabel, stateGlyph, stateLabel } from './glyphs';
import { buildListModel, type TrackerRow } from './list-model';
import { openPicker, type PickerOption } from './picker';
import { avatar, countBadge, dueChip, keyChip, labelChip, relativeTime } from './primitives';
import { createFilterBar } from './filter-bar';
import type { TrackerInboxItem, TrackerNotificationKind, TrackerNotificationPrefs } from '../../tracker-types';
import { createMockTrackerApi } from '../../tracker-mock';
import { mountInbox } from './inbox';

const FIXED_NOW = Date.UTC(2026, 9, 10, 12);
const rows: TrackerRow[] = [
  { key: 'TAB-101', title: 'Keep list cursor when a page arrives', state: { id: 'started', key: 'in_progress', name: 'In progress' }, priority: 'high', assignee: { userId: 'maya', name: 'Maya Chen' }, project: { id: 'tracker', name: 'Tracker UI' }, due: '2026-10-09', updatedAt: FIXED_NOW - 60 * 60_000 },
  { key: 'TAB-102', title: 'Review keyboard shortcut map', state: { id: 'review', key: 'in_review', name: 'In review' }, priority: 'medium', assignee: { userId: 'jon', name: 'Jon Bell' }, project: { id: 'tracker', name: 'Tracker UI' }, due: '2026-10-12', updatedAt: FIXED_NOW - 5 * 60_000 },
  { key: 'TAB-103', title: 'Document the saved view grammar', state: { id: 'todo', key: 'todo', name: 'To do' }, priority: 'low', assignee: null, project: null, due: null, updatedAt: FIXED_NOW - 30 * 60_000 },
];

/** Static, data-free gallery used only by the visual-check build mode. */
export function mountTrackerGallery(container: HTMLElement = document.body): HTMLElement {
  const inboxState = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('inbox');
  if (inboxState) return mountInboxGallery(container, inboxState);
  const root = h('main', { class: 'trk trk-gallery', 'aria-label': 'Tracker UI foundation gallery' });
  const header = h('header', { class: 'trk-gallery-head' },
    h('div', null, h('p', { class: 'trk-kicker' }, 'Tracker foundation'), h('h1', null, 'Issue list, at a glance')),
    h('div', { class: 'trk-chip-gallery' },
      keyChip('TAB-123'), labelChip('Accessibility'), countBadge(12), avatar({ kind: 'person', name: 'Maya Chen' }),
      avatar({ kind: 'agent' }), avatar({ kind: 'github' }), avatar({ kind: 'import' }),
    ),
  );

  const stateItems = (['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const).map((category) => ({
    category,
    key: category === 'started' ? 'in_review' : category === 'completed' ? 'done' : category === 'canceled' ? 'cancelled' : category === 'unstarted' ? 'todo' : 'backlog',
  }));
  const states = h('div', { class: 'trk-glyph-gallery', 'aria-label': 'Ticket states' },
    ...stateItems.map(({ category, key }) => h('span', { class: 'trk-glyph-item' }, stateGlyph(category, key), h('span', null, stateLabel(category, key)))),
  );
  const priorities = h('div', { class: 'trk-glyph-gallery', 'aria-label': 'Ticket priorities' },
    ...(['none', 'low', 'medium', 'high', 'urgent'] as const).map((priority) => h('span', { class: 'trk-glyph-item' }, priorityGlyph(priority), h('span', null, priorityLabel(priority)))),
  );
  const sources = h('div', { class: 'trk-glyph-gallery', 'aria-label': 'Non-person actors' },
    ...(['agent', 'github', 'import'] as const).map((kind) => h('span', { class: 'trk-glyph-item' }, actorBadgeGlyph(kind), h('span', null, actorLabel(kind)))),
  );
  const pullRequests = h('div', { class: 'trk-glyph-gallery', 'aria-label': 'Pull request states' },
    ...(['draft', 'open', 'merged', 'closed'] as const).map((state) => h('span', { class: 'trk-glyph-item' }, prStateGlyph(state), h('span', null, prStateLabel(state)))),
  );
  const glyphSection = h('section', { class: 'trk-gallery-section' },
    h('h2', null, 'State, priority, and pull request glyphs'), states, priorities, sources, pullRequests,
  );

  const filter = createFilterBar({
    initial: [{ field: 'state', value: 'in_progress' }, { field: 'assignee', value: 'me' }],
  });
  const filterSection = h('section', { class: 'trk-gallery-section' },
    h('h2', null, 'Filter and search'), filter.el,
  );

  const pickerButton = h('button', { class: 'trk-gallery-picker-button', type: 'button', 'aria-expanded': 'false' }, 'Choose state');
  const pickerOptions: PickerOption<string>[] = [
    { value: 'todo', label: 'To do' }, { value: 'in_progress', label: 'In progress' },
    { value: 'in_review', label: 'In review' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' },
  ];
  const pickerSection = h('section', { class: 'trk-gallery-section' },
    h('h2', null, 'Picker and ticket properties'), pickerButton,
    h('div', { class: 'trk-chip-gallery' },
      h('button', { class: 'trk-selection-toggle', type: 'button', 'aria-pressed': 'true' }, 'Following'),
      h('button', { class: 'trk-selection-toggle', type: 'button', role: 'checkbox', 'aria-checked': 'mixed', 'aria-label': 'Select visible issues' }, 'Select visible'),
      dueChip('2026-10-09', FIXED_NOW), dueChip('2026-10-12', FIXED_NOW),
      relativeTime(FIXED_NOW, new Date(FIXED_NOW - 5 * 60_000).toISOString()),
    ),
  );

  const listModel = buildListModel({
    pages: [rows],
    group: 'state',
    facets: { state: [
      { key: 'started', label: 'In progress', count: 1 }, { key: 'review', label: 'In review', count: 1 },
      { key: 'todo', label: 'To do', count: 1 },
    ] },
    cursorKey: 'TAB-102', selectedKeys: ['TAB-101'],
  });
  const groups = listModel.groups.map((group) => h('section', { class: 'trk-list-group', 'aria-label': `${group.label}, ${group.count} issues` },
    h('div', { class: 'trk-list-group-head' }, h('span', null, group.label), countBadge(group.count)),
    ...group.rows.map((row) => h('button', {
      class: 'trk-list-row', type: 'button', role: 'row', 'aria-selected': String(listModel.selectedKeys.includes(row.key)),
      'data-cursor': String(listModel.cursorKey === row.key),
    }, keyChip(row.key), h('span', { class: 'trk-list-title' }, row.title ?? row.key), priorityGlyph(row.priority ?? 'none'))),
  ));
  const list = h('div', { class: 'trk-list-demo', role: 'grid', 'aria-label': 'Example tracker issues' }, ...groups);
  const listSection = h('section', { class: 'trk-gallery-section' }, h('h2', null, 'Grouped issue list'), list);
  const grid = h('div', { class: 'trk-gallery-grid' },
    h('div', { class: 'trk-gallery-column' }, glyphSection, pickerSection),
    h('div', { class: 'trk-gallery-column' }, filterSection, listSection),
  );
  root.append(header, grid);
  container.replaceChildren(root);
  void openPicker(pickerButton, { label: 'State', options: pickerOptions, value: 'in_progress' });
  return root;
}

const INBOX_KINDS: TrackerNotificationKind[] = [
  'assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity',
];
const INBOX_PREFS: TrackerNotificationPrefs = {
  kinds: INBOX_KINDS,
  prefs: {
    assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
    relation_changed: 'app', integration_activity: 'app',
  },
};

function galleryInboxItem(index: number, kind: TrackerNotificationKind, createdAt: number, read: boolean): TrackerInboxItem {
  const detail: TrackerInboxItem['detail'] = kind === 'status_changed' ? { state: 'In review' }
    : kind === 'relation_changed' ? { key: 'TAB-142', relation: 'blocked_by' }
      : kind === 'integration_activity' ? { text: 'Pull request 482 was merged into main.' }
        : kind === 'due_soon' ? { dueDate: '2026-10-12' } : null;
  const actors = ['Maya Chen', 'Jon Bell', 'Sam Rivera'];
  const key = `TAB-${121 + index}`;
  return {
    id: `gallery-notice-${index + 1}`,
    kind,
    createdAt,
    readAt: read ? createdAt + 30_000 : null,
    ticket: {
      key,
      title: index === 0 ? 'Keep the inbox cursor on its notice after a refresh' : `Review tracker follow-up ${index + 1}`,
      state: { name: index % 2 ? 'In progress' : 'In review', category: index % 2 ? 'started' : 'started' },
      assignee: { name: 'Maya Chen' },
      priority: index === 1 ? 'urgent' : index === 4 ? 'high' : 'none',
    },
    actor: index % 3 ? { name: actors[index % actors.length] } : null,
    preview: kind === 'commented' || kind === 'mentioned' ? 'The new behavior looks good; I left one small follow-up.' : null,
    detail,
  };
}

function mountInboxGallery(container: HTMLElement, state: string): HTMLElement {
  const now = FIXED_NOW;
  const kinds = state === 'long-list' ? Array.from({ length: 48 }, (_, index) => INBOX_KINDS[index % INBOX_KINDS.length]) : INBOX_KINDS;
  const seed = kinds.map((kind, index) => galleryInboxItem(
    index,
    kind,
    now - (index < 4 ? index * 37 : 26 * 60 + index * 17) * 60_000,
    index % 2 === 1,
  ));
  const root = h('main', { class: 'trk trk-gallery trk-inbox-gallery', 'aria-label': 'Tracker inbox gallery', 'data-inbox-gallery-state': state },
    h('header', { class: 'trk-gallery-head' },
      h('div', null, h('p', { class: 'trk-kicker' }, 'Tracker UI'), h('h1', null, state === 'prefs' ? 'Notification settings' : 'Inbox')),
    ),
    h('div', { class: 'trk-inbox-gallery-host' }),
  );
  const host = root.querySelector<HTMLElement>('.trk-inbox-gallery-host')!;
  const api = createMockTrackerApi({ inbox: state === 'empty' ? [] : seed, now: () => now, notificationPrefs: INBOX_PREFS });
  if (state === 'loading') api.inbox = async () => new Promise(() => undefined);
  if (state === 'error') api.inbox = async () => { throw new Error('Gallery inbox load failure'); };
  container.replaceChildren(root);
  mountInbox(host, { api, now: () => now, onOpenTicket: () => undefined, onUnreadChange: () => undefined });
  if (['populated', 'long-list', 'narrow', 'prefs'].includes(state)) {
    root.querySelector<HTMLButtonElement>('.trk-inbox-show-read')?.click();
  }
  if (state === 'prefs') root.querySelector<HTMLButtonElement>('[aria-controls^="trk-inbox-prefs-"]')?.click();
  return root;
}
