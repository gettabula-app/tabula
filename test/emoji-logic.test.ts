import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS } from '../src/emoji-data';
import { addRecent, moveGridFocus, parseRecent, searchEmoji } from '../src/ui/emoji-logic';

const items = [
  { e: '😀', n: 'Happy face', k: 'smile warm' },
  { e: '🚀', n: 'Rocket', k: 'space launch' },
  { e: '🌱', n: 'Seedling', k: 'plant grow' },
  { e: '☕', n: 'Café cup', k: 'drink coffee' },
];

describe('emoji search', () => {
  it('matches names and keywords', () => {
    expect(searchEmoji(items, 'rocket')).toEqual([items[1]]);
    expect(searchEmoji(items, 'coffee')).toEqual([items[3]]);
  });

  it('requires every query word to match', () => {
    expect(searchEmoji(items, 'space launch')).toEqual([items[1]]);
    expect(searchEmoji(items, 'space plant')).toEqual([]);
  });

  it('ignores case and diacritics', () => {
    expect(searchEmoji(items, 'CAFE')).toEqual([items[3]]);
  });

  it('returns every item for an empty query and none for a miss', () => {
    expect(searchEmoji(items, '  ')).toEqual(items);
    expect(searchEmoji(items, 'not found')).toEqual([]);
  });
});

describe('emoji recents', () => {
  const all = EMOJI_GROUPS.flatMap((group) => group.items);

  it('deduplicates while preserving the most recent order and caps at 16', () => {
    const emojis = all.slice(0, 18).map((item) => item.e);
    expect(parseRecent(JSON.stringify([emojis[0], emojis[1], emojis[0], ...emojis.slice(2)]), all)).toEqual(emojis.slice(0, 16));
    expect(addRecent(emojis.slice(1, 17), emojis[0], all)).toEqual(emojis.slice(0, 16));
  });

  it('rejects strings that are not present in the emoji data and malformed storage', () => {
    expect(parseRecent(JSON.stringify(['not emoji', 'garbage', '😀', 12]), all)).toEqual(['😀']);
    expect(parseRecent('{', all)).toEqual([]);
    expect(parseRecent(JSON.stringify({ emoji: '😀' }), all)).toEqual([]);
  });
});

describe('emoji grid movement', () => {
  it('moves across rows, wraps left and right, and returns to search above the first row', () => {
    expect(moveGridFocus(5, 'ArrowRight', 16, 6)).toBe(6);
    expect(moveGridFocus(6, 'ArrowLeft', 16, 6)).toBe(5);
    expect(moveGridFocus(0, 'ArrowLeft', 16, 6)).toBe(15);
    expect(moveGridFocus(15, 'ArrowRight', 16, 6)).toBe(0);
    expect(moveGridFocus(0, 'ArrowUp', 16, 6)).toBeNull();
    expect(moveGridFocus(7, 'ArrowUp', 16, 6)).toBe(1);
    expect(moveGridFocus(2, 'ArrowDown', 16, 6)).toBe(8);
  });

  it('moves to the start and end of the current row', () => {
    expect(moveGridFocus(8, 'Home', 16, 6)).toBe(6);
    expect(moveGridFocus(8, 'End', 16, 6)).toBe(11);
    expect(moveGridFocus(14, 'End', 16, 6)).toBe(15);
  });
});

describe('emoji catalog', () => {
  const all = EMOJI_GROUPS.flatMap((group) => group.items);

  it('contains about 300 unique, single-grapheme emoji sequences', () => {
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    expect(all.length).toBeGreaterThanOrEqual(300);
    expect(all.length).toBeLessThan(400);
    expect(new Set(all.map((item) => item.e)).size).toBe(all.length);
    for (const item of all) {
      const segments = Array.from(segmenter.segment(item.e), ({ segment }) => segment);
      expect(segments, item.n).toEqual([item.e]);
      expect(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(item.e) || /^\p{Nd}\uFE0F?\u20E3$/u.test(item.e), item.n).toBe(true);
    }
  });
});
