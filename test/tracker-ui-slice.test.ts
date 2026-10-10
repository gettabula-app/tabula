import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerError } from '../src/tracker-types';
import { createMockTrackerApi } from '../src/tracker-mock';
import { createTrackerStore } from '../src/tracker-data';
import { trackerPresentation, wheelDisposition } from '../src/tracker/ui/frame';
import { visibleColumns, facetsForGroup, trackerViewerState, mountTrackerShell } from '../src/tracker/ui/shell';
import { markdownInlineTokens, renderSafeMarkdown } from '../src/tracker/ui/new-issue';
import { ticketChip, ticketChipValue } from '../src/tracker/ui/ticket-chip';
import { buildListModel, selectAll, setGroupCollapsed, type TrackerRow } from '../src/tracker/ui/list-model';
import * as listModelModule from '../src/tracker/ui/list-model';
import { createTrackerVisualSeed } from '../src/tracker/ui/visual-seed';
import { installTrackerUiBrowser } from './tracker-ui-test-helpers';
import { FakeElement, FakeEvent, flush } from './fake-dom';
import { openNewIssueDialog } from '../src/tracker/ui/new-issue';
import { renderSnippet } from '../src/tracker/ui/snippet';
import { trackerErrorField } from '../src/tracker/ui/error-path';
import type { TrackerTicket } from '../src/tracker-types';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tracker shell slice', () => {
  it('keeps navigation state per viewer and per frame window', () => {
    const store = createTrackerStore(createMockTrackerApi(createTrackerVisualSeed()), { isVisible: () => false });
    const first = trackerViewerState(store, 'viewer-a', 'frame-a', 'inbox');
    first.tab = 'all';
    first.filter.push('state:done');
    expect(trackerViewerState(store, 'viewer-a', 'frame-a', 'projects')).toBe(first);
    expect(trackerViewerState(store, 'viewer-a', 'frame-b', 'projects')).toMatchObject({ tab: 'projects', filter: [] });
    expect(trackerViewerState(store, 'viewer-b', 'frame-a', 'my')).toMatchObject({ tab: 'my', filter: [] });
    store.destroy();
  });

  it('switches tabs and renders the mock All issues list through the shared shell', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    const store = createTrackerStore(api, { isVisible: () => false });
    const mount = browser.mount() as unknown as HTMLElement;
    const shell = mountTrackerShell(mount, { store, api, viewerId: 'visual-user', trackerId: 'tracker-demo', windowId: 'frame-1', initialTab: 'all' });
    await store.loadMeta();
    await store.loadList({ filter: [], limit: 50, includeFacets: true, group: 'state', sort: { field: 'updatedAt', direction: 'desc' } });
    expect(shell.el.querySelectorAll('.trk-list-row').length).toBe(seed.tickets?.length);
    const inbox = shell.el.querySelectorAll<HTMLButtonElement>('.trk-tab')[0];
    inbox.click();
    expect(shell.state.tab).toBe('inbox');
    expect(shell.el.querySelector('.trk-inbox')).not.toBeNull();
    await flush();
    expect(shell.el.textContent).toContain('Nothing needs you.');
    expect(shell.el.querySelector('.trk-unread-count')?.textContent).toBe('0');
    shell.el.querySelectorAll<HTMLButtonElement>('.trk-tab')[2].click();
    expect(shell.state.tab).toBe('all');
    shell.destroy();
    store.destroy();
  });

  it('renders the compact real-server ticket projection and groups it without facets', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const ticket = seed.tickets![0];
    const listProjection = {
      id: ticket.id, key: ticket.key, title: ticket.title,
      state: { key: ticket.state.key, name: ticket.state.name, category: ticket.state.category },
      assignee: ticket.assignee, project: null, due: ticket.due, archivedAt: null,
      updatedAt: ticket.updatedAt, updatedSeq: ticket.updatedSeq, snippet: null,
      commentCount: 0, subIssueCount: 0, subIssueDone: 0, blocked: false, prs: null,
    } as unknown as TrackerTicket;
    const api = createMockTrackerApi(seed);
    vi.spyOn(api, 'listTickets').mockResolvedValue({ tickets: [listProjection], nextCursor: null });
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, { store, api, viewerId: 'real-list-viewer', trackerId: 'real-list-tracker', initialTab: 'all' });
    await store.loadMeta();
    await flush(40);
    const row = shell.el.querySelector<HTMLElement>('.trk-list-row');
    expect(row?.getAttribute('data-key')).toBe(ticket.key);
    expect(shell.el.querySelector('.trk-group-heading')?.textContent).toContain(ticket.state.name);
    expect(shell.el.querySelector('.trk-results-count')?.textContent).toBe('1 issue');
    shell.destroy();
    store.destroy();
  });

  it('shows a retryable list alert for request failures and retries the server query', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const ticket = seed.tickets![0];
    const api = createMockTrackerApi(seed);
    const listTickets = vi.spyOn(api, 'listTickets')
      .mockRejectedValueOnce(new TrackerError('network', 'Relay request failed'))
      .mockRejectedValueOnce(new TrackerError('network', 'Relay request failed'))
      .mockResolvedValue({ tickets: [ticket], nextCursor: null });
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, { store, api, viewerId: 'list-error-viewer', trackerId: 'list-error-tracker', initialTab: 'all' });
    await store.loadMeta();
    await flush(40);
    const alert = shell.el.querySelector('.trk-list-error') as unknown as FakeElement | null;
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.hasAttribute('hidden')).toBe(false);
    expect(alert?.textContent).toContain('Could not load issues.');
    alert?.querySelector<FakeElement>('button')?.click();
    await flush(40);
    expect(listTickets).toHaveBeenCalledTimes(3);
    expect(shell.el.querySelector('.trk-list-row')?.getAttribute('data-key')).toBe(ticket.key);
    shell.destroy();
    store.destroy();
  });

  it('catches row-render exceptions and shows an actionable list error', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const ticket = seed.tickets![0];
    const api = createMockTrackerApi(seed);
    const build = listModelModule.buildListModel;
    let failed = false;
    vi.spyOn(listModelModule, 'buildListModel').mockImplementation((options) => {
      if (!failed && options.pages.some((page) => page.some((row) => row.key === ticket.key))) {
        failed = true;
        throw new Error('List rendering failed');
      }
      return build(options);
    });
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, { store, api, viewerId: 'render-error-viewer', trackerId: 'render-error-tracker', initialTab: 'all' });
    await store.loadMeta();
    await flush(40);
    const alert = shell.el.querySelector('.trk-list-error') as unknown as FakeElement | null;
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('List rendering failed');
    expect(alert?.querySelector<FakeElement>('button')?.textContent).toBe('Retry');
    shell.el.querySelector<HTMLButtonElement>('.trk-list-error button')?.click();
    await flush(40);
    expect(shell.el.querySelector('.trk-list-row')?.getAttribute('data-key')).toBe(ticket.key);
    shell.destroy();
    store.destroy();
  });

  it('uses server facets when present and client groups, and hides optional columns from the right', () => {
    const facets = facetsForGroup('state', { states: [{ id: 'todo', name: 'To do', count: 8 }] });
    expect(facets?.state).toEqual([{ key: 'todo', label: 'To do', count: 8 }]);
    const tickets = createTrackerVisualSeed().tickets!;
    const model = buildListModel({ pages: [tickets as unknown as TrackerRow[]], group: 'project' });
    expect(model.groups.map((group) => group.label)).toContain('Foundation');
    const multiLabelTicket = { ...tickets[0], labels: [...tickets[0].labels, { id: 'label-extra', name: 'Extra', color: null }] };
    const labels = buildListModel({ pages: [[multiLabelTicket as unknown as TrackerRow]], group: 'label' });
    expect(labels.groups.find((group) => group.label === 'Extra')?.rows.map((row) => row.key)).toContain(multiLabelTicket.key);
    expect(selectAll(labels).selectedKeys).toEqual([multiLabelTicket.key]);
    expect(visibleColumns(700, new Set(['priority', 'key', 'state', 'title', 'assignee', 'project', 'due', 'updated']))).toEqual(['priority', 'key', 'state', 'title', 'assignee']);
    expect(visibleColumns(1440, new Set(['priority', 'key', 'state', 'title', 'assignee', 'project', 'due', 'updated']))).toHaveLength(8);
    expect(setGroupCollapsed(model, model.groups[0].id, true).visibleRows.length).toBeLessThan(model.visibleRows.length);
  });

  it('loads a second mock page and supports archive undo from the store contract', async () => {
    const seed = createTrackerVisualSeed();
    const base = seed.tickets![0];
    const tickets = [...seed.tickets!, ...Array.from({ length: 45 }, (_, index) => ({ ...base, id: `extra-${index}`, key: `TAB-${500 + index}`, updatedSeq: index + 20 }))];
    const store = createTrackerStore(createMockTrackerApi({ ...seed, tickets }), { isVisible: () => false });
    await store.loadMeta();
    const query = { limit: 50, group: null };
    const firstPage = await store.loadList(query);
    expect(firstPage.tickets).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await store.loadMore(query);
    expect(secondPage.tickets).toHaveLength(tickets.length);
    const key = tickets[0].key;
    const undo = await store.bulk([key], { archived: true });
    expect(store.ticket(key).ticket?.archivedAt).not.toBeNull();
    await store.undo(undo);
    expect(store.ticket(key).ticket?.archivedAt).toBeNull();
    store.destroy();
  });

  it('keeps the server current value on a conflict and rolls optimistic edits back on error', async () => {
    const seed = createTrackerVisualSeed();
    const current = seed.tickets![0];
    const api = createMockTrackerApi(seed);
    vi.spyOn(api, 'patchTicket').mockRejectedValueOnce(new TrackerError('conflict', 'conflict', { current }));
    const store = createTrackerStore(api, { isVisible: () => false });
    await store.loadMeta();
    await store.loadList({ limit: 50, group: null });
    await expect(store.updateTicket(current.key, { priority: 'urgent' })).rejects.toMatchObject({ code: 'conflict' });
    expect(store.ticket(current.key).ticket?.priority).toBe(current.priority);
    store.destroy();
  });

  it('shows the current server value in the inline conflict toast', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const original = seed.tickets![0];
    const current = { ...original, priority: 'low' as const, updatedSeq: original.updatedSeq + 1 };
    const api = createMockTrackerApi(seed);
    vi.spyOn(api, 'patchTicket').mockRejectedValueOnce(new TrackerError('conflict', 'conflict', { current }));
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, { store, api, viewerId: 'conflict-viewer', trackerId: 'tracker-demo', initialTab: 'all' });
    await store.loadMeta();
    await store.loadList({ limit: 50, group: 'state' });
    await flush();
    shell.el.querySelector<HTMLButtonElement>('.trk-glyph-button')!.click();
    const high = browser.document.querySelectorAll<FakeElement>('.trk-picker-option').find((item) => item.textContent === 'High priority');
    expect(high).toBeDefined();
    high!.click();
    await flush(40);
    expect(store.ticket(original.key).ticket?.priority).toBe('low');
    expect(browser.document.querySelector('.toast')?.textContent).toContain('Mara changed this at the same time. Current value kept: Low');
    shell.destroy();
    store.destroy();
  });

  it('shows the selection bulk bar and undoes an archived mock ticket', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, { store, api, viewerId: 'bulk-viewer', trackerId: 'tracker-demo', initialTab: 'all' });
    await store.loadMeta();
    await store.loadList({ limit: 50, group: 'state' });
    await flush();
    const key = seed.tickets![0].key;
    shell.el.querySelector<HTMLButtonElement>('.trk-row-select')!.click();
    expect(shell.el.querySelector('.trk-selection-bar')?.hasAttribute('hidden')).toBe(false);
    const archive = Array.from(shell.el.querySelectorAll<HTMLButtonElement>('.trk-selection-bar button')).find((button) => button.textContent === 'Archive');
    archive!.click();
    await flush(40);
    expect(store.ticket(key).ticket?.archivedAt).not.toBeNull();
    browser.document.querySelector<FakeElement>('.toast-action')!.click();
    await flush(40);
    expect(store.ticket(key).ticket?.archivedAt).toBeNull();
    shell.destroy();
    store.destroy();
  });
});

describe('new issue dialog', () => {
  it('keeps an offline draft in memory and disables create with the ticket-number reason', () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const store = createTrackerStore(createMockTrackerApi(seed), { isVisible: () => false });
    const options = { store, meta: seed.meta!, viewerId: 'draft-viewer', trackerId: 'draft-tracker', offline: true };
    const first = openNewIssueDialog(options);
    const box = first.box as unknown as FakeElement;
    const title = box.querySelector<FakeElement>('.trk-new-title')!;
    title.value = 'Keep my offline draft';
    title.dispatchEvent(new FakeEvent('input'));
    expect(first.box.querySelector<HTMLButtonElement>('.trk-primary-button')!.disabled).toBe(true);
    expect(first.box.textContent).toContain('Needs a connection to get a ticket number.');
    first.close();
    const reopened = openNewIssueDialog(options);
    expect(reopened.box.querySelector<HTMLInputElement>('.trk-new-title')!.value).toBe('Keep my offline draft');
    reopened.close();
    store.destroy();
  });

  it('creates a ticket from the shared store after a title is entered', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    const create = vi.spyOn(api, 'createTicket');
    const store = createTrackerStore(api, { isVisible: () => false });
    const modal = openNewIssueDialog({ store, meta: seed.meta!, viewerId: 'create-viewer', trackerId: 'create-tracker' });
    const modalBox = modal.box as unknown as FakeElement;
    const title = modalBox.querySelector<FakeElement>('.trk-new-title')!;
    title.value = 'New issue through the shell store';
    title.dispatchEvent(new FakeEvent('input'));
    modalBox.querySelector<FakeElement>('.trk-primary-button')!.click();
    await flush(40);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'New issue through the shell store', state: 'todo' }));
    expect(modal.box.isConnected).toBe(false);
    store.destroy();
  });

  it('maps an unprefixed create error path to its issue field', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    vi.spyOn(api, 'createTicket').mockRejectedValueOnce(new TrackerError('invalid_input', 'Choose valid labels.', { path: 'labels' }));
    const store = createTrackerStore(api, { isVisible: () => false });
    const modal = openNewIssueDialog({ store, meta: seed.meta!, viewerId: 'path-viewer', trackerId: 'path-tracker' });
    const modalBox = modal.box as unknown as FakeElement;
    const title = modalBox.querySelector('.trk-new-title')!;
    title.value = 'Issue with invalid labels';
    title.dispatchEvent(new FakeEvent('input'));
    modalBox.querySelector('.trk-primary-button')!.click();
    await flush(40);
    expect(modalBox.querySelectorAll('.trk-new-properties button')[3].getAttribute('aria-invalid')).toBe('true');
    modal.close();
    store.destroy();
  });

  it('keeps a failed create visible, preserves the draft, and focuses the server field path', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    vi.spyOn(api, 'createTicket').mockRejectedValueOnce(new TrackerError('invalid_input', 'Unknown label: UI', { path: 'labels[0]' }));
    const store = createTrackerStore(api, { isVisible: () => false });
    const modal = openNewIssueDialog({ store, meta: seed.meta!, viewerId: 'invalid-label-viewer', trackerId: 'invalid-label-tracker' });
    const box = modal.box as unknown as FakeElement;
    const title = box.querySelector<FakeElement>('.trk-new-title')!;
    title.value = 'Keep this failed draft';
    title.dispatchEvent(new FakeEvent('input'));
    box.querySelector<FakeElement>('.trk-primary-button')!.click();
    await flush(40);
    expect(box.querySelector('.trk-inline-error')?.getAttribute('role')).toBe('alert');
    expect(box.querySelector('.trk-inline-error')?.textContent).toContain('Unknown label: UI');
    expect(box.isConnected).toBe(true);
    expect(title.value).toBe('Keep this failed draft');
    const labels = box.querySelectorAll<FakeElement>('.trk-new-properties button')[3];
    expect(labels.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(labels);
    modal.close();
    store.destroy();
  });
});

describe('frame interaction thresholds', () => {
  it('selects snapshot or work presentation from focus, screen width, zoom, and phone mode', () => {
    expect(trackerPresentation(0.39, 900, true)).toBe('snapshot');
    expect(trackerPresentation(0.4, 559, true)).toBe('snapshot');
    expect(trackerPresentation(0.4, 560, true)).toBe('work');
    expect(trackerPresentation(1.4, 1200, true)).toBe('work');
    expect(trackerPresentation(1, 1440, true, true)).toBe('snapshot');
    expect(trackerPresentation(1, 1440, false)).toBe('snapshot');
  });

  it('lets list scroll through, pans at either end, and always zooms for a modified wheel', () => {
    expect(wheelDisposition({ modified: false, deltaY: 10, scrollTop: 4, scrollHeight: 100, clientHeight: 20 })).toBe('list');
    expect(wheelDisposition({ modified: false, deltaY: 10, scrollTop: 80, scrollHeight: 100, clientHeight: 20 })).toBe('pan');
    expect(wheelDisposition({ modified: false, deltaY: -10, scrollTop: 0, scrollHeight: 100, clientHeight: 20 })).toBe('pan');
    expect(wheelDisposition({ modified: true, deltaY: 10, scrollTop: 0, scrollHeight: 100, clientHeight: 20 })).toBe('zoom');
  });
});

describe('safe Markdown preview and ticket chips', () => {
  it('renders only the supported Markdown subset and rejects active script and javascript links', () => {
    browser = installTrackerUiBrowser();
    const input = '**safe** <script>alert(1)</script> [bad](javascript:alert(1)) [good](https://example.com)';
    const tokens = markdownInlineTokens(input);
    expect(tokens.some((token) => token.type === 'link' && token.href?.startsWith('javascript:'))).toBe(false);
    expect(tokens.some((token) => token.type === 'link' && token.href === 'https://example.com')).toBe(true);
    const preview = renderSafeMarkdown(input);
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelectorAll('a')).toHaveLength(1);
    expect(preview.textContent).toContain('<script>alert(1)</script>');
  });

  it('builds a one-line state chip with a canonical path ticket link', () => {
    const ticket = createTrackerVisualSeed().tickets![0] as TrackerTicket;
    expect(ticketChipValue(ticket)).toMatchObject({ key: ticket.key, title: ticket.title, href: `/t/${ticket.key}` });
    browser = installTrackerUiBrowser();
    const chip = ticketChip(ticket);
    expect(chip.tagName.toLowerCase()).toBe('a');
    expect(chip.getAttribute('href')).toBe(`/t/${ticket.key}`);
    expect(chip.getAttribute('aria-label')).toContain(ticket.state.name);
  });
});

describe('safe snippets and tracker error paths', () => {
  it('renders only balanced exact marks and keeps hostile or malformed text inert', () => {
    browser = installTrackerUiBrowser();
    const samples = [
      '<mark><img src=x onerror=alert(1)> title</mark>',
      'stray </mark> and <mark>unfinished',
      '',
      '<mark>outer <mark>nested</mark></mark>',
    ];
    const fragments = samples.map(renderSnippet);
    for (const fragment of fragments) expect(fragment.querySelector('img')).toBeNull();
    expect(fragments[0].querySelectorAll('mark')).toHaveLength(1);
    expect(fragments[1].textContent).toBe('stray </mark> and <mark>unfinished');
    expect(fragments[2].childNodes).toHaveLength(0);
    expect(fragments[3].querySelector('img')).toBeNull();
  });

  it('normalizes REST validation paths for the matching tracker controls', () => {
    expect(trackerErrorField('labels')).toBe('labels');
    expect(trackerErrorField('patch.labels')).toBe('labels');
    expect(trackerErrorField('patch.labels[0]')).toBe('labels');
    expect(trackerErrorField('assigneeId')).toBe('assignee');
    expect(trackerErrorField('query')).toBe('search');
    expect(trackerErrorField(undefined)).toBeNull();
  });
});
