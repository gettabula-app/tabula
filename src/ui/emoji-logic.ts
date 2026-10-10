import type { EmojiItem } from '../emoji-data';

export const RECENT_LIMIT = 16;

const folded = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function searchEmoji(items: readonly EmojiItem[], query: string): EmojiItem[] {
  const words = folded(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((item) => {
    const haystack = folded(`${item.n} ${item.k}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function parseRecent(raw: string | null, items: readonly EmojiItem[]): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const valid = new Set(items.map((item) => item.e));
  const seen = new Set<string>();
  const recent: string[] = [];
  for (const emoji of value) {
    if (typeof emoji !== 'string' || !valid.has(emoji) || seen.has(emoji)) continue;
    seen.add(emoji);
    recent.push(emoji);
    if (recent.length === RECENT_LIMIT) break;
  }
  return recent;
}

export function addRecent(recent: readonly string[], emoji: string, items: readonly EmojiItem[]): string[] {
  const valid = new Set(items.map((item) => item.e));
  if (!valid.has(emoji)) return parseRecent(JSON.stringify(recent), items);
  return [emoji, ...parseRecent(JSON.stringify(recent), items).filter((item) => item !== emoji)].slice(0, RECENT_LIMIT);
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** Returns the next row-major cell, or null when Up leaves the first row for the search field. */
export function moveGridFocus(index: number, key: GridKey, count: number, columns: number): number | null {
  if (count <= 0 || columns <= 0 || index < 0 || index >= count) return null;
  const rowStart = Math.floor(index / columns) * columns;
  const rowEnd = Math.min(rowStart + columns - 1, count - 1);
  if (key === 'ArrowLeft') return index === rowStart ? (rowStart === 0 ? count - 1 : rowStart - 1) : index - 1;
  if (key === 'ArrowRight') return index === count - 1 ? 0 : index + 1;
  if (key === 'ArrowUp') return index < columns ? null : index - columns;
  if (key === 'ArrowDown') return Math.min(index + columns, count - 1);
  if (key === 'Home') return rowStart;
  return rowEnd;
}
