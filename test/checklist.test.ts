import { describe, expect, it } from 'vitest';
import {
  addItem, checklistForWrite, checklistProgress, cleanChecklist, cleanItemText, editItem, moveItem, parsePastedItems, progressLabel,
  removeItem, toggleItem, withNewIds,
} from '../src/checklist';
import { LIMITS, checklistProblem } from '../shared/containers';
import type { ChecklistItem } from '../src/types';

// docs/kanban.md and po/specs/12-kanban-checklist.md (TAB-372): the pure rules for a card's checklist. Pasted text, the
// text and list the app keeps, the progress labels, and the list operations, which return the same array when nothing changes.

const EMOJI = '\u{1F600}';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const item = (id: string, text: string, done = false): ChecklistItem => ({ id, text, done });
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

describe('cleanItemText', () => {
  it.each([
    ['plain text is kept', 'buy paint', 'buy paint'],
    ['line breaks flatten to one space', 'a\nb\r\nc\rd', 'a b c d'],
    ['runs of white space collapse and the ends are trimmed', '  a \t\t b  ', 'a b'],
    ['other control characters become spaces, as the validator needs', 'a\u0007b\u001bc\u007fd\u0085e', 'a b c d e'],
    ['the Unicode line and paragraph separators become spaces', 'a b c', 'a b c'],
    ['blank text is empty', ' \n\t ', ''],
    ['text is never cut below the limit', 'x'.repeat(LIMITS.checklistText), 'x'.repeat(LIMITS.checklistText)],
  ])('%s', (_name, input, expected) => {
    expect(cleanItemText(input)).toBe(expected);
  });

  it('cuts at 200 code points, keeping whole characters, and trims the cut end', () => {
    expect([...cleanItemText(EMOJI.repeat(250))]).toHaveLength(LIMITS.checklistText);
    expect(cleanItemText(`${'x'.repeat(199)}${EMOJI}${EMOJI}`)).toBe(`${'x'.repeat(199)}${EMOJI}`);
    const cut = cleanItemText('a '.repeat(150));
    expect(cut.endsWith(' ')).toBe(false);
    expect(cut).toHaveLength(199);
  });

  it('is empty for something that is not text', () => {
    expect(cleanItemText(42)).toBe('');
    expect(cleanItemText(undefined)).toBe('');
  });
});

describe('cleanChecklist', () => {
  it.each([
    ['not a list', 'x'],
    ['no value', undefined],
    ['an empty list', []],
    ['only items with nothing in them', [null, 'x', [1], { text: '' }, { text: '   ' }]],
  ])('is undefined for %s', (_name, value) => {
    expect(cleanChecklist(value)).toBeUndefined();
  });

  it('drops non-objects and empty items and keeps the order of the rest', () => {
    expect(cleanChecklist([null, { id: 'a', text: 'one' }, 3, { id: 'b', text: '  ' }, { id: 'c', text: 'two', done: 1 }])).toEqual([
      item('a', 'one'), item('c', 'two'),
    ]);
  });

  it('keeps id, text and done only, and reads done as true only for true', () => {
    expect(cleanChecklist([{ id: 'x1', text: 't', done: true, owner: 'me', extra: 1 }])).toEqual([item('x1', 't', true)]);
    expect(cleanChecklist([{ id: 'x2', text: 't', done: 'yes' }])).toEqual([item('x2', 't', false)]);
  });

  it.each([
    ['a missing id', { text: 'a' }],
    ['a malformed id', { id: 'bad id!', text: 'a' }],
    ['an id over 64 characters', { id: 'x'.repeat(65), text: 'a' }],
    ['a non-string id', { id: 7, text: 'a' }],
  ])('regenerates %s', (_name, raw) => {
    const [out] = cleanChecklist([raw]) ?? [];
    expect(out.id).toMatch(ID_SHAPE);
    expect(out.id).not.toBe((raw as { id?: unknown }).id);
  });

  it('keeps the first of a repeated id and regenerates the others, so the ids are unique', () => {
    const out = cleanChecklist([{ id: 'dup', text: 'c' }, { id: 'dup', text: 'd' }, { id: 'ok', text: 'e' }]) ?? [];
    expect(out.map((i) => i.text)).toEqual(['c', 'd', 'e']);
    expect(out[0].id).toBe('dup');
    expect(out[1].id).not.toBe('dup');
    expect(new Set(out.map((i) => i.id)).size).toBe(3);
  });

  it('drops items with a bad or repeated id instead when told to (the render path)', () => {
    const out = cleanChecklist([{ id: 'bad id!', text: 'a' }, { id: 'ok', text: 'b' }, { id: 'ok', text: 'c' }], { badIds: 'drop' });
    expect(out).toEqual([item('ok', 'b')]);
  });

  it('is idempotent for valid input, so a render or a reload does not change it', () => {
    const once = cleanChecklist([item('a1', ' one\n two ', true), item('b2', 'three')]);
    expect(cleanChecklist(once)).toEqual(once);
    expect(once).toEqual([item('a1', 'one two', true), item('b2', 'three')]);
  });

  it('keeps the first 50 items', () => {
    const many = Array.from({ length: 60 }, (_, k) => item(`i${k}`, `n${k}`));
    const out = cleanChecklist(many) ?? [];
    expect(out).toHaveLength(LIMITS.checklistItems);
    expect(out[49].text).toBe('n49');
  });

  it('cuts from the end to the byte limit, and what is kept passes the shared validator', () => {
    const big = Array.from({ length: 50 }, (_, k) => item(`b${k}`, EMOJI.repeat(LIMITS.checklistText)));
    const out = cleanChecklist(big) ?? [];
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(50);
    expect(bytes(out)).toBeLessThanOrEqual(LIMITS.checklistBytes);
    expect(bytes([...out, big[out.length]])).toBeGreaterThan(LIMITS.checklistBytes);
    expect(checklistProblem(out)).toBeNull();
  });
});

describe('checklistForWrite (an explicit write is refused, never cut)', () => {
  it('stores the list with its text flattened to one line', () => {
    expect(checklistForWrite([{ id: 'a', text: 'x\ny', done: true }])).toEqual([item('a', 'x y', true)]);
  });

  it.each([
    ['a 51st item', Array.from({ length: 51 }, (_, k) => ({ id: `i${k}`, text: 'a' }))],
    ['an item over 200 code points', [{ id: 'a', text: EMOJI.repeat(201) }]],
    ['an empty item', [{ id: 'a', text: '   ' }]],
    ['an unknown key', [{ id: 'a', text: 'a', owner: 'me' }]],
    ['a repeated id', [{ id: 'a', text: 'a' }, { id: 'a', text: 'b' }]],
    ['a missing id', [{ text: 'a' }]],
    ['a done that is not true or false', [{ id: 'a', text: 'a', done: 'yes' }]],
    ['an item that is not an object', ['a']],
    ['a list over 12,000 bytes', Array.from({ length: 50 }, (_, k) => ({ id: `b${k}`, text: EMOJI.repeat(LIMITS.checklistText) }))],
    ['not a list', { id: 'a', text: 'a' }],
  ])('refuses %s', (_name, value) => {
    expect(checklistForWrite(value)).toBeNull();
  });

  it('accepts exactly 50 items and exactly 200 code points', () => {
    expect(checklistForWrite(Array.from({ length: 50 }, (_, k) => ({ id: `i${k}`, text: 'a' })))).toHaveLength(50);
    expect(checklistForWrite([{ id: 'a', text: EMOJI.repeat(200) }])).toHaveLength(1);
  });
});

describe('checklistProgress and progressLabel', () => {
  it('counts the ticked items out of all of them', () => {
    expect(checklistProgress({ checklist: [item('a', 'a', true), item('b', 'b'), item('c', 'c', true)] })).toEqual({ done: 2, total: 3 });
  });

  it.each([
    ['no card', undefined],
    ['no checklist', {}],
    ['an empty checklist', { checklist: [] }],
  ])('is 0 of 0 for %s', (_name, card) => {
    expect(checklistProgress(card)).toEqual({ done: 0, total: 0 });
  });

  it.each([
    [{ done: 2, total: 5 }, { text: '2/5', srText: '2 of 5 checklist items done', complete: false }],
    [{ done: 5, total: 5 }, { text: '5/5 done', srText: '5 of 5 checklist items done', complete: true }],
    [{ done: 0, total: 1 }, { text: '0/1', srText: '0 of 1 checklist items done', complete: false }],
    [{ done: 0, total: 0 }, null],
  ])('reads %j as %j', (p, label) => {
    expect(progressLabel(p)).toEqual(label);
  });
});

describe('parsePastedItems', () => {
  it.each([
    ['a list with markers and boxes', '- [ ] a\n- [x] b\n* c\n1. d', [['a', false], ['b', true], ['c', false], ['d', false]]],
    ['the other markers and a capital X', '1) e\n+ f\n[X] g\n[ ] h', [['e', false], ['f', false], ['g', true], ['h', false]]],
    ['blank lines and surrounding spaces', '\n\n   \n  - i  \n\n', [['i', false]]],
    ['CRLF and CR line ends', 'a\r\nb\rc', [['a', false], ['b', false], ['c', false]]],
    ['a line that is only a marker or a box', '-\n*\n[ ]\n1.\n[x]', []],
    ['a number that is not a list marker', '2024 was good\n3.5 litres', [['2024 was good', false], ['3.5 litres', false]]],
    ['a tick with a control character inside', '- [x] done\u0007thing', [['done thing', true]]],
    ['plain lines with indentation', '  indented item', [['indented item', false]]],
  ])('reads %s', (_name, text, expected) => {
    const { items, dropped } = parsePastedItems(text, LIMITS.checklistItems);
    expect(items).toEqual(expected.map(([t, d]) => ({ text: t, done: d })));
    expect(dropped).toBe(0);
  });

  it('keeps the room it is given and counts what it leaves out', () => {
    const lines = Array.from({ length: 63 }, (_, k) => `line ${k + 1}`).join('\n');
    const { items, dropped } = parsePastedItems(lines, LIMITS.checklistItems);
    expect(items).toHaveLength(50);
    expect(items[0].text).toBe('line 1');
    expect(dropped).toBe(13);
  });

  it.each([
    ['no room at all', 0, 3],
    ['room for one', 1, 2],
    ['room for all', 3, 0],
  ])('with %s', (_name, room, dropped) => {
    expect(parsePastedItems('a\nb\nc', room).dropped).toBe(dropped);
  });

  it('does not count blank lines as left out', () => {
    expect(parsePastedItems('a\n\n\nb', 1)).toEqual({ items: [{ text: 'a', done: false }], dropped: 1 });
  });

  it('stops at the byte room it is given', () => {
    const lines = [EMOJI.repeat(LIMITS.checklistText), EMOJI.repeat(LIMITS.checklistText), EMOJI.repeat(LIMITS.checklistText)].join('\n');
    const { items, dropped } = parsePastedItems(lines, LIMITS.checklistItems, 2000);
    expect(items).toHaveLength(2);
    expect(dropped).toBe(1);
  });

  it('never makes a list the validator would refuse', () => {
    const lines = Array.from({ length: 60 }, () => EMOJI.repeat(LIMITS.checklistText)).join('\n');
    const { items } = parsePastedItems(lines, LIMITS.checklistItems);
    expect(checklistProblem(withNewIds(items))).toBeNull();
  });
});

describe('withNewIds', () => {
  it('gives each item a fresh id, unique in the list, and keeps its text and tick', () => {
    const out = withNewIds([{ text: 'a', done: false }, { text: 'b', done: true }, { text: 'c', done: true }]);
    expect(out.map((i) => [i.text, i.done])).toEqual([['a', false], ['b', true], ['c', true]]);
    expect(out.every((i) => ID_SHAPE.test(i.id))).toBe(true);
    expect(new Set(out.map((i) => i.id)).size).toBe(3);
  });
});

describe('list operations', () => {
  const list = () => [item('a', 'one'), item('b', 'two', true), item('c', 'three')];

  it('addItem appends a cleaned item with a fresh id, not ticked', () => {
    const before = list();
    const next = addItem(before, '  four\n  ') ?? [];
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({ text: 'four', done: false });
    expect(ID_SHAPE.test(next[3].id)).toBe(true);
    expect(before).toHaveLength(3);
  });

  it('addItem refuses blank text, a full list and a list over the byte limit', () => {
    expect(addItem(list(), '  \n ')).toBeNull();
    expect(addItem(Array.from({ length: LIMITS.checklistItems }, (_, k) => item(`i${k}`, 'x')), 'one more')).toBeNull();
    let full = [] as ChecklistItem[];
    for (let k = 0; ; k++) {
      const next = addItem(full, EMOJI.repeat(LIMITS.checklistText));
      if (!next) break;
      full = next;
      if (k > 60) throw new Error('the byte limit never stopped the list');
    }
    expect(bytes(full)).toBeLessThanOrEqual(LIMITS.checklistBytes);
    expect(full.length).toBeGreaterThan(10);
  });

  it('toggleItem flips one tick, and returns the same list for an unknown id', () => {
    const before = list();
    const next = toggleItem(before, 'a');
    expect(next.map((i) => i.done)).toEqual([true, true, false]);
    expect(before[0].done).toBe(false);
    expect(toggleItem(before, 'zzz')).toBe(before);
  });

  it('editItem replaces the text, and returns the same list when nothing changes', () => {
    const before = list();
    expect(editItem(before, 'c', ' four ')?.[2].text).toBe('four');
    expect(editItem(before, 'c', 'three')).toBe(before);
    expect(editItem(before, 'zzz', 'x')).toBe(before);
    expect(editItem(before, 'c', '  ')).toBeNull();
  });

  it.each([
    ['up one', 'b', -1, ['b', 'a', 'c']],
    ['down one', 'b', 1, ['a', 'c', 'b']],
    ['up past the top is clamped to the top', 'c', -9, ['c', 'a', 'b']],
    ['down past the bottom is clamped to the bottom', 'a', 9, ['b', 'c', 'a']],
  ])('moveItem moves %s', (_name, id, delta, order) => {
    expect(moveItem(list(), id, delta).map((i) => i.id)).toEqual(order);
  });

  it('moveItem returns the same list when the item is already at that end, or the move is zero or unknown', () => {
    const before = list();
    expect(moveItem(before, 'a', -1)).toBe(before);
    expect(moveItem(before, 'c', 1)).toBe(before);
    expect(moveItem(before, 'b', 0)).toBe(before);
    expect(moveItem(before, 'zzz', 1)).toBe(before);
  });

  it('removeItem drops one item, and returns the same list for an unknown id', () => {
    const before = list();
    expect(removeItem(before, 'b').map((i) => i.id)).toEqual(['a', 'c']);
    expect(removeItem(before, 'zzz')).toBe(before);
    expect(before).toHaveLength(3);
  });
});
