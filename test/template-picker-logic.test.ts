import { describe, expect, it } from 'vitest';
import { countTemplatePickerEntries, filterTemplatePickerEntries, type TemplatePickerEntry } from '../src/ui/template-picker-logic';

const entries: TemplatePickerEntry[] = [
  { id: 'retro-1', name: 'Sprint retro', description: 'Review last sprint', category: 'Retrospective', source: 'builtin' },
  { id: 'retro-2', name: 'Team check-in', description: 'A short weekly review', category: 'Retrospective', source: 'builtin' },
  { id: 'plan-1', name: 'Roadmap', description: 'Plan milestones', category: 'Planning', source: 'builtin' },
  { id: 'mine-1', name: 'My ideas', description: 'Collect ideas', category: 'Ideation', source: 'mine' },
  { id: 'shared-1', name: 'Shared retro', description: 'Decide what to improve', category: 'Retrospective', source: 'shared' },
];

describe('template picker filters and counts', () => {
  it('searches name, description and category without changing the active category filter', () => {
    expect(filterTemplatePickerEntries(entries, '  RETRO  ', { kind: 'all' }).map((entry) => entry.id))
      .toEqual(['retro-1', 'retro-2', 'shared-1']);
    expect(filterTemplatePickerEntries(entries, 'milestone', { kind: 'category', category: 'Planning' }).map((entry) => entry.id))
      .toEqual(['plan-1']);
    expect(filterTemplatePickerEntries(entries, 'plan', { kind: 'mine' })).toEqual([]);
  });

  it('counts all templates, categories, own templates and shared templates', () => {
    const counts = countTemplatePickerEntries(entries);
    expect(counts.all).toBe(5);
    expect(counts.categories.get('Retrospective')).toBe(3);
    expect(counts.categories.get('Planning')).toBe(1);
    expect(counts.mine).toBe(1);
    expect(counts.shared).toBe(1);
  });
});
