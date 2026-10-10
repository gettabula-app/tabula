import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFilterBar } from '../src/tracker/ui/filter-bar';
import { build, FilterTokenError, filterChipLabel, parse, type FilterChip } from '../src/tracker/ui/filter';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';
import { FakeElement } from './fake-dom';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; vi.useRealTimers(); });

describe('tracker filter token bridge', () => {
  it('round-trips every architecture grammar token and free text', () => {
    const tokens = [
      'assignee:me', 'assignee:Maya Chen', 'state:in_review', 'label:Accessibility',
      'due:overdue', 'due:today', 'due:before-2026-12-31', 'has:link', 'is:archived',
      'created:after-2026-01-10', 'project:Roadmap', 'milestone:m1', 'design system debt',
    ];
    const chips = parse(tokens);
    expect(build(chips)).toEqual(tokens);
    expect(parse(build(chips))).toEqual(chips);
  });

  it('rejects invented server filters, unsupported operators, and invalid calendar dates', () => {
    for (const token of [
      'unknown:value', 'state:', 'due:before-2026-02-30', 'created:after-2026-1-01', 'has:comment', 'is:open',
      'state:is-not:done', 'creator:Maya', 'due:this-week', 'has:pr', 'relation:blocked', 'assignee:',
    ]) {
      let caught: unknown;
      try { parse([token]); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(FilterTokenError);
      expect((caught as FilterTokenError).token).toBe(token);
    }
  });

  it('handles empty filters, free text, and chip labels', () => {
    expect(parse([])).toEqual([]);
    expect(build([])).toEqual([]);
    expect(filterChipLabel({ field: 'assignee', value: 'me' })).toBe('Assignee · Me');
    expect(filterChipLabel({ field: 'is', value: 'archived' })).toBe('Include archived');
    expect(filterChipLabel({ field: 'text', value: 'title phrase' })).toBe('title phrase');
    expect(() => build([{ field: 'text', value: '  ' }])).toThrow(FilterTokenError);
  });
});

describe('tracker keyboard filter bar', () => {
  it('opens, types a field, tabs to its value, and commits a server token on Enter', () => {
    browser = installTrackerUiBrowser();
    const changes: FilterChip[][] = [];
    const bar = createFilterBar({ onChange: (chips) => changes.push([...chips]) });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    bar.open();
    const field = bar.el.querySelector('.trk-filter-field') as unknown as FakeElement;
    const value = bar.el.querySelector('.trk-filter-value') as unknown as FakeElement;
    field.value = 'due';
    const tab = uiEvent('keydown', { key: 'Tab' });
    field.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(browser.document.activeElement).toBe(value);
    value.value = 'overdue';
    value.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips()).toEqual([{ field: 'due', value: 'overdue' }]);
    expect(bar.el.textContent).toContain('Due overdue');
    expect(changes).toHaveLength(1);
  });

  it('adds fixed grammar fields, rejects unsupported values, and removes the last chip with Backspace', () => {
    browser = installTrackerUiBrowser();
    const bar = createFilterBar({ initial: [{ field: 'state', value: 'in_progress' }, { field: 'has', value: 'link' }] });
    browser.mount().appendChild(bar.el as unknown as FakeElement);
    const field = bar.el.querySelector('.trk-filter-field') as unknown as FakeElement;
    const value = bar.el.querySelector('.trk-filter-value') as unknown as FakeElement;
    field.value = 'is';
    field.dispatchEvent(uiEvent('keydown', { key: 'Tab' }));
    expect(value.value).toBe('archived');
    value.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    expect(bar.getChips().at(-1)).toEqual({ field: 'is', value: 'archived' });
    field.value = 'relation';
    field.dispatchEvent(uiEvent('keydown', { key: 'Tab' }));
    expect(browser.document.activeElement).toBe(field);
    const search = bar.el.querySelector('.trk-search-input') as unknown as FakeElement;
    search.dispatchEvent(uiEvent('keydown', { key: 'Backspace' }));
    expect(bar.getChips()).toHaveLength(2);
    expect(bar.getChips().map((chip) => build([chip])[0])).toEqual(['state:in_progress', 'has:link']);
  });

  it('keeps the search box at the end and calls back when its query changes', () => {
    browser = installTrackerUiBrowser();
    const searches: string[] = [];
    const bar = createFilterBar({ onSearch: (query) => searches.push(query) });
    const editor = bar.el.querySelector('.trk-filter-editor')!;
    const search = bar.el.querySelector('.trk-filter-search-wrap')!;
    expect(editor.nextSibling).toBe(search);
    const query = bar.el.querySelector('.trk-search-input') as unknown as FakeElement;
    query.value = 'layout';
    query.dispatchEvent(uiEvent('input'));
    expect(searches).toEqual(['layout']);
  });
});
