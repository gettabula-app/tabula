import { TrackerError } from '../../tracker-types';

// The server filter grammar as the UI models it (chips). Owned by the tracker UI so the data layer stays untouched.
export type TrackerFilterField =
  | 'assignee' | 'state' | 'label' | 'creator' | 'priority' | 'category' | 'project' | 'milestone'
  | 'due' | 'created' | 'updated' | 'has' | 'is' | 'parent' | 'blocks' | 'blocked-by' | 'relates' | 'duplicates' | 'duplicated-by';
export interface TrackerFilterToken { field: TrackerFilterField; value: string; not: boolean }

const TRACKER_FILTER_FIELDS = new Set<TrackerFilterField>([
  'assignee', 'state', 'label', 'creator', 'priority', 'category', 'project', 'milestone',
  'due', 'created', 'updated', 'has', 'is', 'parent', 'blocks', 'blocked-by', 'relates', 'duplicates', 'duplicated-by',
]);
const LIST_FILTER_FIELDS = new Set<TrackerFilterField>(['assignee', 'state', 'label', 'creator', 'priority', 'category', 'project', 'milestone']);
const PRIORITIES = new Set(['none', 'urgent', 'high', 'medium', 'low']);
const CATEGORIES = new Set(['backlog', 'unstarted', 'started', 'completed', 'canceled']);

function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Parses one server filter token; a leading `-` negates, commas mean any of. Throws invalid_filter. */
export function parseFilterToken(source: string): TrackerFilterToken {
  const token = source.trim();
  const not = token.startsWith('-');
  const body = not ? token.slice(1) : token;
  const separator = body.indexOf(':');
  const field = separator > 0 ? body.slice(0, separator).toLowerCase() : '';
  const value = separator > 0 ? body.slice(separator + 1).trim() : '';
  const values = LIST_FILTER_FIELDS.has(field as TrackerFilterField) ? value.split(',').map((item) => item.trim()) : [value];
  const invalid = (): never => { throw new TrackerError('invalid_filter', `Invalid filter: ${source}`, { path: source }); };
  if (separator < 1 || !TRACKER_FILTER_FIELDS.has(field as TrackerFilterField) || !value || values.length > 20 || values.some((item) => !item)) invalid();
  const f = field as TrackerFilterField;
  if (f === 'due') {
    for (const item of values) {
      const normalized = item.toLowerCase();
      if (['none', 'overdue', 'today', 'this-week'].includes(normalized)) continue;
      if (normalized.startsWith('before-') && isValidDate(item.slice(7))) continue;
      if (normalized.startsWith('after-') && isValidDate(item.slice(6))) continue;
      invalid();
    }
  } else if ((f === 'created' || f === 'updated') && values.some((item) => {
    const normalized = item.toLowerCase();
    return !(normalized.startsWith('after-') || normalized.startsWith('before-')) || !isValidDate(item.slice(item.indexOf('-') + 1));
  })) invalid();
  else if (f === 'priority' && values.some((item) => !PRIORITIES.has(item.toLowerCase()))) invalid();
  else if (f === 'category' && values.some((item) => !CATEGORIES.has(item.toLowerCase()))) invalid();
  else if (f === 'has' && values.some((item) => !['link', 'relation', 'parent', 'sub'].includes(item.toLowerCase()))) invalid();
  else if (f === 'is' && values.some((item) => !['archived', 'blocked', 'blocking'].includes(item.toLowerCase()))) invalid();
  else if (['parent', 'blocks', 'blocked-by', 'relates', 'duplicates', 'duplicated-by'].includes(f) && !/^[a-z]{2,5}-\d+$/i.test(value)) invalid();
  return { field: f, value, not };
}

export function parseFilterTokens(input: readonly string[]): TrackerFilterToken[] {
  return input.map(parseFilterToken);
}

/** Formats validated chips as the repeated filter parameters the tracker API accepts. */
export function formatFilterTokens(input: readonly TrackerFilterToken[]): string[] {
  return input.map((item) => {
    const token = `${item.not ? '-' : ''}${item.field}:${item.value}`;
    parseFilterToken(token);
    return token;
  });
}
