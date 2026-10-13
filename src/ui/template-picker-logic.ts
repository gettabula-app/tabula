export interface TemplatePickerEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  source: 'builtin' | 'mine' | 'shared';
}

export type TemplatePickerFilter =
  | { kind: 'all' }
  | { kind: 'category'; category: string }
  | { kind: 'mine' }
  | { kind: 'shared' };

export interface TemplatePickerCounts {
  all: number;
  categories: Map<string, number>;
  mine: number;
  shared: number;
}

/** Filters by category or ownership and searches the visible template fields. */
export function filterTemplatePickerEntries<T extends TemplatePickerEntry>(
  entries: readonly T[],
  query: string,
  filter: TemplatePickerFilter,
): T[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const inFilter = filter.kind === 'all'
      || (filter.kind === 'category' && entry.category === filter.category)
      || (filter.kind === 'mine' && entry.source === 'mine')
      || (filter.kind === 'shared' && entry.source === 'shared');
    if (!inFilter) return false;
    return !needle || `${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(needle);
  });
}

/** Counts all available templates for the category rail. */
export function countTemplatePickerEntries(entries: readonly TemplatePickerEntry[]): TemplatePickerCounts {
  const categories = new Map<string, number>();
  let mine = 0;
  let shared = 0;
  for (const entry of entries) {
    categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    if (entry.source === 'mine') mine++;
    else if (entry.source === 'shared') shared++;
  }
  return { all: entries.length, categories, mine, shared };
}
