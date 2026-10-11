import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrackerStore } from '../src/tracker-data';
import { createMockTrackerApi } from '../src/tracker-mock';
import { mountTrackerShell } from '../src/tracker/ui/shell';
import { createTrackerVisualSeed } from '../src/tracker/ui/visual-seed';
import { openNewIssueDialog } from '../src/tracker/ui/new-issue';
import { FakeElement, flush } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

describe('tracker accessibility semantics', () => {
  it('uses roving focus for the main tablist and keeps grid controls inside gridcells', async () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const api = createMockTrackerApi(seed);
    const store = createTrackerStore(api, { isVisible: () => false });
    const shell = mountTrackerShell(browser.mount() as unknown as HTMLElement, {
      store, api, viewerId: 'a11y-viewer', trackerId: 'tracker-demo', initialTab: 'all',
    });
    await store.loadMeta();
    await store.loadList({ filter: [], limit: 50, includeFacets: true, group: 'state', sort: { field: 'updatedAt', direction: 'desc' } });
    await flush(40);

    const tablist = (shell.el as unknown as FakeElement).querySelector('[role="tablist"]')!;
    const allTab = tablist.querySelector('[data-tab-id="all"]')!;
    expect(allTab.getAttribute('tabindex')).toBe('0');
    expect(tablist.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    allTab.focus();
    allTab.dispatchEvent(uiEvent('keydown', { key: 'ArrowRight' }));
    expect((shell.el as unknown as FakeElement).querySelector('[data-tab-id="board"]')?.getAttribute('tabindex')).toBe('0');
    expect((browser.document.activeElement as unknown as FakeElement).dataset.tabId).toBe('board');

    shell.destroy();
    const secondShell = mountTrackerShell(browser.mount() as unknown as HTMLElement, {
      store, api, viewerId: 'a11y-grid-viewer', trackerId: 'tracker-demo', initialTab: 'all',
    });
    await store.loadMeta();
    await store.loadList({ filter: [], limit: 50, includeFacets: true, group: 'state', sort: { field: 'updatedAt', direction: 'desc' } });
    await flush(40);
    const grid = (secondShell.el as unknown as FakeElement).querySelector('[role="grid"]')!;
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
    const select = grid.querySelector('.trk-row-select')!;
    expect(select.closest('[role="gridcell"]')).not.toBeNull();
    expect(select.closest('[role="row"]')).not.toBeNull();
    const loadMore = (secondShell.el as unknown as FakeElement).querySelector('.trk-load-more')!;
    expect((loadMore.parentNode as unknown as FakeElement).classList.contains('trk-list-host')).toBe(true);
    expect(grid.querySelector('.trk-load-more')).toBeNull();

    secondShell.destroy();
    store.destroy();
  });

  it('names New issue property buttons by property and value', () => {
    browser = installTrackerUiBrowser();
    const seed = createTrackerVisualSeed();
    const store = createTrackerStore(createMockTrackerApi(seed), { isVisible: () => false });
    const modal = openNewIssueDialog({ store, meta: seed.meta!, viewerId: 'a11y-draft', trackerId: 'a11y-tracker' });
    const buttons = (modal.box as unknown as FakeElement).querySelectorAll('.trk-new-properties button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^State: /),
      'Priority: No priority',
      expect.stringMatching(/^Assignee: /),
      'Labels: No labels',
      'Project: No project',
      'Due date: No due date',
    ]);
    modal.close();
    store.destroy();
  });
});
