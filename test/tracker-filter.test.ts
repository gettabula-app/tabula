import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFilterBar } from '../src/tracker/ui/filter-bar';
import { build, FilterTokenError, filterChipLabel, parse, type FilterChip } from '../src/tracker/ui/filter';
import { createTrackerVisualSeed } from '../src/tracker/ui/visual-seed';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';
import { FakeElement } from './fake-dom';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

describe('tracker filter token bridge', () => {
  it('round-trips the data layer grammar, including negation and comma-separated any-of values', () => {
    const tokens = [
      'assignee:me', 'assignee:none', 'assignee:Maya Chen', 'state:in_review', 'state:Done,in_progress',
      '-state:Done,in_progress', 'label:Accessibility,Bug', 'due:overdue', 'due:today', 'due:this-week', 'due:before-2026-12-31',
      'due:after-2026-01-10', 'has:relation', 'is:blocking',
      'creator:me,agent,integration,import,system', 'priority:urgent,high', 'category:started,completed',
      'project:none,Roadmap', 'milestone:V1,none', 'created:after-2026-01-10', 'created:before-2026-01-10',
      'updated:after-2026-01-10', 'updated:before-2026-01-10', 'parent:TAB-123', '-blocks:TAB-42',
      'blocked-by:TAB-42', 'relates:TAB-42', 'duplicates:TAB-42', 'duplicated-by:TAB-42', 'design system debt',
    ];
    const chips = parse(tokens);
    expect(build(chips)).toEqual(tokens);
    expect(parse(build(chips))).toEqual(chips);
    expect(filterChipLabel({ field: 'state', value: 'Done', not: true })).toBe('not state: Done');
  });

  it('rejects fields and values the tracker data layer and server do not support', () => {
    for (const token of [
      'unknown:value', 'state:', 'due:before-2026-02-30', 'created:after-2026-1-01', 'updated:before-2026-02-30',
      'has:comment', 'is:open', 'priority:urgent,other', 'category:planned', 'parent:tab-abc', 'blocks:',
      'assignee:', 'state:done,', 'state:one,two,three,four,five,six,seven,eight,nine,ten,eleven,twelve,thirteen,fourteen,fifteen,sixteen,seventeen,eighteen,nineteen,twenty,twenty-one',
    ]) {
      let caught: unknown;
      try { parse([token]); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(FilterTokenError);
      expect((caught as FilterTokenError).token).toBe(token);
    }
    expect(parseFilterLabels()).toEqual(['assignee: Me', 'not state: Done']);
  });

  it('handles empty filters and free-text chips', () => {
    expect(parse([])).toEqual([]);
    expect(build([])).toEqual([]);
    expect(filterChipLabel({ field: 'text', value: 'title phrase' })).toBe('title phrase');
    expect(() => build([{ field: 'text', value: '  ' }])).toThrow(FilterTokenError);
  });
});

function parseFilterLabels(): string[] {
  return [
    filterChipLabel({ field: 'assignee', value: 'me' }),
    filterChipLabel({ field: 'state', value: 'Done', not: true }),
  ];
}

describe('tracker one-row filter bar', () => {
  it('suggests fields and values, commits a filter chip, and keeps the active filter labelled', () => {
    browser = installTrackerUiBrowser();
    const changes: FilterChip[][] = [];
    const searches: string[] = [];
    const bar = createFilterBar({ meta: createTrackerVisualSeed().meta, onChange: (chips) => changes.push([...chips]), onSearch: (query) => searches.push(query) });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;

    bar.open();
    input.value = 'sta';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toContain('state:');
    const tab = uiEvent('keydown', { key: 'Tab' });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(input.value).toBe('state:');

    input.value = 'state:In';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(input.value).toBe('state:In progress');
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips()).toEqual([{ field: 'state', value: 'In progress' }]);
    expect(bar.el.textContent).toContain('state: In progress');
    expect(changes).toHaveLength(1);
    input.value = 'due:';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toContain('due: This week');
    expect(searches).toEqual(['', '', '', '', '', '']);
  });

  it('suggests negated fields and comma any-of values for the expanded server grammar', () => {
    browser = installTrackerUiBrowser();
    const bar = createFilterBar({ meta: {
      ...createTrackerVisualSeed().meta!,
      projects: [{ id: 'project-roadmap', name: 'Roadmap' }],
      milestones: [{ id: 'milestone-v1', projectId: 'project-roadmap', name: 'V1', due: null }],
    } });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;
    input.value = '-pri';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toContain('not priority:');
    input.value = '-priority:urgent,hi';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toContain('not priority: High');
    input.value = 'project:';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toContain('project: Roadmap');
    input.value = 'milestone:';
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(bar.el.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toContain('milestone: V1');
  });

  it('locks view filters, removes the last editable chip with Backspace, and displays invalid_filter inline', () => {
    browser = installTrackerUiBrowser();
    const bar = createFilterBar({ initial: [
      { field: 'assignee', value: 'me', locked: true }, { field: 'state', value: 'in_progress' }, { field: 'has', value: 'link' },
    ] });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;
    input.dispatchEvent(uiEvent('keydown', { key: 'Backspace' }));
    expect(bar.getChips().map((chip) => chip.value)).toEqual(['me', 'in_progress']);
    expect(bar.el.querySelectorAll('.trk-filter-chip button')).toHaveLength(1);

    input.value = 'priority:urgent,other';
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips()).toHaveLength(2);
    expect(bar.el.querySelector('[aria-live="polite"]')?.textContent).toBe('Invalid filter: priority:urgent,other');
    bar.setError('Unsupported filter priority:high.');
    expect(bar.el.querySelector('[aria-live="polite"]')?.textContent).toBe('Unsupported filter priority:high.');
    expect(bar.el.querySelector('.trk-filter-error')?.getAttribute('aria-live')).toBe('polite');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(bar.suggestionsOpen()).toBe(false);
  });

  it('uses the same input for free-text search and hides suggestions on Escape', () => {
    browser = installTrackerUiBrowser();
    const searches: string[] = [];
    const bar = createFilterBar({ onSearch: (query) => searches.push(query) });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const input = bar.el.querySelector('.trk-filter-input') as unknown as FakeElement;
    input.value = 'layout';
    input.dispatchEvent(uiEvent('input'));
    expect(searches).toEqual(['layout']);
    expect(input.getAttribute('placeholder')).toBe('Filter or search');
    expect(bar.suggestionsOpen()).toBe(false);
    input.value = 'sta';
    input.dispatchEvent(uiEvent('input'));
    expect(bar.suggestionsOpen()).toBe(true);
    input.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(bar.suggestionsOpen()).toBe(false);
    expect(bar.el.querySelector('.trk-filter-editor')).toBeNull();
  });
});
