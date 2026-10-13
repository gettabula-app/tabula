import { describe, expect, it } from 'vitest';
import { MAX_MENTIONS } from '../src/ui/chat-logic';
import {
  choosePerson, commentSegments, editableText, knownPeople, offerable, mentionCandidates, mentionCount, mentionedIds, mentionState, plainText, storedText, withinLimit,
} from '../src/ui/comment-mentions-logic';

const ANA = { id: 'u-ana', name: 'Ana Lima' };
const BEN = { id: 'u-ben', name: 'Ben' };
const CARA = { id: 'u-cara', name: 'Cara' };
const ME = { id: 'u-me', name: 'Me Myself' };
const PEOPLE = [ANA, BEN, CARA, ME];

describe('the people a comment can name', () => {
  it('takes the comment authors and the people here, the one here now winning over an older name', () => {
    const threads = [
      { authorId: 'u-ana', authorName: 'Anna', replies: [{ authorId: 'u-ben', authorName: 'Ben' }] },
      { authorId: 'guest_1', authorName: 'Guest', replies: [] },
    ];
    expect(knownPeople(threads, [{ id: 'u-ana', name: 'Ana Lima' }, { id: 'u-me', name: 'Me Myself' }])).toEqual([
      { id: 'u-ana', name: 'Ana Lima' },
      { id: 'u-ben', name: 'Ben' },
      { id: 'guest_1', name: 'Guest' },
      { id: 'u-me', name: 'Me Myself' },
    ]);
  });

  it('skips a person with no id or a blank name', () => {
    expect(knownPeople([{ authorId: 'u1', authorName: '  ', replies: [] }], [{ id: '', name: 'X' }])).toEqual([]);
  });
});

describe('tokenising a comment for display', () => {
  it('shows a known token as the name, and a stray token as someone', () => {
    const segs = commentSegments('Ask @{u-ana} and @{u-gone} about it', PEOPLE);
    expect(segs).toEqual([
      { type: 'text', text: 'Ask ' },
      { type: 'mention', id: 'u-ana', name: 'Ana Lima' },
      { type: 'text', text: ' and ' },
      { type: 'mention', id: 'u-gone', name: null },
      { type: 'text', text: ' about it' },
    ]);
    expect(plainText('Ask @{u-ana} and @{u-gone}', PEOPLE)).toBe('Ask @Ana Lima and @someone');
  });

  it('keeps links as text and leaves text without tokens unchanged', () => {
    expect(commentSegments('see https://example.com/a', PEOPLE)).toEqual([{ type: 'text', text: 'see ' }, { type: 'link', url: 'https://example.com/a' }]);
    expect(plainText('just words', PEOPLE)).toBe('just words');
  });

  it('does not read a token that is not in the id alphabet', () => {
    expect(mentionedIds('@{bad id} @{u-ana}')).toEqual(['u-ana']);
  });
});

describe('the @ list', () => {
  it('finds the `@` word at the caret and offers the people who match, not oneself', () => {
    expect(mentionState('hi @an', 6, PEOPLE, ME.id, [])).toEqual({ start: 3, query: 'an', options: [ANA] });
    expect(mentionState('hi @', 4, PEOPLE, ME.id, [])?.options.map((p) => p.id)).toEqual(['u-ana', 'u-ben', 'u-cara']);
    expect(mentionState('mail a@b', 8, PEOPLE, ME.id, [])).toBeNull();
    expect(mentionState('hi @an', 3, PEOPLE, ME.id, [])).toBeNull();
  });

  it('offers nothing once the text already names MAX_MENTIONS people', () => {
    expect(MAX_MENTIONS).toBe(10);
    const many = Array.from({ length: MAX_MENTIONS }, (_, i) => ({ id: `u${i}`, name: `Person${i}` }));
    const text = many.map((p) => `@{${p.id}}`).join(' ');
    const others = [{ id: 'u-extra', name: 'Extra' }];
    expect(mentionCount(text, [])).toBe(MAX_MENTIONS);
    expect(mentionCandidates(others, '', ME.id, text, [])).toEqual([]);
    const nine = many.slice(0, MAX_MENTIONS - 1).map((p) => `@{${p.id}}`).join(' ');
    expect(mentionCandidates(others, '', ME.id, nine, [])).toEqual(others);
  });

  it('counts picked names that are still in the text, once per person', () => {
    expect(mentionCount('@Ana Lima and @Ana Lima again, @Ben', [ANA, BEN])).toBe(2);
    expect(mentionCount('@Ana Lima', [])).toBe(0);
  });
});

describe('choosing a person', () => {
  it('replaces the @ word with @Name and a space, moves the caret after it, and remembers the pick once', () => {
    const first = choosePerson('hey @a', 6, ANA, []);
    expect(first).toEqual({ text: 'hey @Ana Lima ', caret: 14, picked: [ANA] });
    const again = choosePerson('hey @Ana Lima and @B', 20, BEN, [ANA]);
    expect(again).toEqual({ text: 'hey @Ana Lima and @Ben ', caret: 23, picked: [ANA, BEN] });
    expect(choosePerson('hey @Ana', 8, ANA, [ANA])?.picked).toEqual([ANA]);
  });

  it('does nothing without an @ word at the caret', () => {
    expect(choosePerson('plain', 5, ANA, [])).toBeNull();
  });

  it('stores the picked names as tokens, and leaves a typed name that was not picked as text', () => {
    expect(storedText('Ask @Ana Lima and @Ben too', [ANA])).toBe('Ask @{u-ana} and @Ben too');
    expect(storedText('  @Ben  ', [BEN])).toBe('@{u-ben}');
  });

  it('keeps a stored text within the comment limit by its own length', () => {
    expect(withinLimit('x'.repeat(4000))).toBe(true);
    expect(withinLimit('x'.repeat(4001))).toBe(false);
    const tokened = storedText('@Cara', [{ id: 'u'.repeat(64), name: 'Cara' }]);
    expect(tokened).toBe(`@{${'u'.repeat(64)}}`);
    expect(tokened.length).toBe(67);
  });
});

describe('edit field and guests', () => {
  const ben = { id: 'u-ben', name: 'Ben' };
  it('shows a known token as a name, keeps an unknown token, and saving restores the tokens', () => {
    const { text, picked } = editableText('hi @{u-ben} and @{u-gone}', [ben]);
    expect(text).toBe('hi @Ben and @{u-gone}');
    expect(storedText(text, picked)).toBe('hi @{u-ben} and @{u-gone}');
  });
  it('does not offer guests', () => {
    expect(offerable([ben, { id: 'guest_1', name: 'Visitor' }])).toEqual([ben]);
  });
});
