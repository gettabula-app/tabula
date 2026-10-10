/*
 * This bridge follows docs/tracker-architecture.md §5 exactly. The UX draft also asks for creator, state category,
 * priority, updated ranges, due:none/this-week/range, PR filters, relation/parent filters, and is/is-not/any-of/none-of
 * operators; the server grammar has no tokens for those yet. Assignee "No one" is also not expressible. They must not
 * be emitted as guessed server syntax.
 */

export type FilterField = 'assignee' | 'state' | 'label' | 'due' | 'has' | 'is' | 'created' | 'project' | 'milestone';
export type FilterChip = { field: FilterField | 'text'; value: string };

const FIELDS = new Set<FilterField>(['assignee', 'state', 'label', 'due', 'has', 'is', 'created', 'project', 'milestone']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FilterTokenError extends Error {
  constructor(public readonly token: string) {
    super(`Invalid tracker filter: ${token}`);
    this.name = 'FilterTokenError';
  }
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function splitToken(token: string): FilterChip {
  const text = token.trim();
  if (!text) throw new FilterTokenError(token);
  const colon = text.indexOf(':');
  if (colon < 0) return { field: 'text', value: text };
  const field = text.slice(0, colon).toLowerCase();
  const value = text.slice(colon + 1);
  if (!FIELDS.has(field as FilterField) || !value || value.includes(':')) throw new FilterTokenError(token);
  const f = field as FilterField;
  const valueLower = value.toLowerCase();
  if (f === 'assignee' && valueLower !== 'me' && !value.trim()) throw new FilterTokenError(token);
  if (f === 'due' && valueLower !== 'overdue' && valueLower !== 'today' && !/^before-\d{4}-\d{2}-\d{2}$/.test(value)) throw new FilterTokenError(token);
  if (f === 'due' && valueLower.startsWith('before-') && !validDate(value.slice('before-'.length))) throw new FilterTokenError(token);
  if (f === 'created' && (!value.startsWith('after-') || !validDate(value.slice('after-'.length)))) throw new FilterTokenError(token);
  if (f === 'has' && valueLower !== 'link') throw new FilterTokenError(token);
  if (f === 'is' && valueLower !== 'archived') throw new FilterTokenError(token);
  if (['state', 'label', 'project', 'milestone', 'assignee'].includes(f) && !value.trim()) throw new FilterTokenError(token);
  return { field: f, value };
}

/** Parses each supplied search token into a filter chip or one free-text chip. Invalid tokens fail with their source text. */
export function parse(tokens: readonly string[]): FilterChip[] {
  return tokens.map(splitToken);
}

/** Serializes chips into server-compatible tokens plus free text, in their current visual order. */
export function build(chips: readonly FilterChip[]): string[] {
  return chips.map((chip) => {
    if (!chip.value.trim()) throw new FilterTokenError(chip.field === 'text' ? chip.value : `${chip.field}:`);
    if (chip.field === 'text') {
      if (chip.value.includes('\n')) throw new FilterTokenError(chip.value);
      return chip.value;
    }
    if (!FIELDS.has(chip.field)) throw new FilterTokenError(`${chip.field}:${chip.value}`);
    const token = `${chip.field}:${chip.value}`;
    splitToken(token);
    return token;
  });
}

export function filterChipLabel(chip: FilterChip): string {
  if (chip.field === 'text') return chip.value;
  const names: Record<FilterField, string> = {
    assignee: 'Assignee', state: 'State', label: 'Label', due: 'Due', has: 'Has', is: 'Include', created: 'Created',
    project: 'Project', milestone: 'Milestone',
  };
  const value = chip.value === 'me' ? 'Me' : chip.value;
  if (chip.field === 'has') return 'Has link';
  if (chip.field === 'is') return 'Include archived';
  if (chip.field === 'due' && chip.value === 'overdue') return 'Due overdue';
  if (chip.field === 'due' && chip.value === 'today') return 'Due today';
  if (chip.field === 'due' && chip.value.startsWith('before-')) return `Due before ${chip.value.slice(7)}`;
  if (chip.field === 'created' && chip.value.startsWith('after-')) return `Created after ${chip.value.slice(6)}`;
  return `${names[chip.field]} · ${value}`;
}
