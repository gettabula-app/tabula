import { describe, expect, it } from 'vitest';
import { queryTokens, searchSets, type SearchSet } from '../src/icon-search';

const set = (prefix: string, names: string[], aliases: [string, number][] = [], categories?: Record<string, number[]>): SearchSet => ({ prefix, names, aliases, categories });

describe('queryTokens', () => {
  it('lower-cases and splits on anything that is not a letter or digit', () => {
    expect(queryTokens('  Arrow-Left  2x ')).toEqual(['arrow', 'left', '2x']);
    expect(queryTokens('')).toEqual([]);
    expect(queryTokens(' -- ')).toEqual([]);
  });
});

describe('searchSets', () => {
  it('ranks a whole word over the start of a word over a substring', () => {
    const s = set('a', ['car', 'carpet', 'scar', 'oscar-night', 'car-wash']);
    expect(searchSets([s], 'car', { limit: 10 })).toEqual(['a:car', 'a:car-wash', 'a:carpet', 'a:scar', 'a:oscar-night']);
  });

  it('puts the shorter name first when the match is equal', () => {
    const s = set('a', ['arrow-left-long', 'arrow-left', 'arrow-left-x']);
    expect(searchSets([s], 'arrow left', { limit: 10 })).toEqual(['a:arrow-left', 'a:arrow-left-x', 'a:arrow-left-long']);
  });

  it('needs every word to match, in any order', () => {
    const s = set('a', ['arrow-left', 'left', 'arrow', 'left-arrow-big']);
    expect(searchSets([s], 'left arrow', { limit: 10 })).toEqual(['a:arrow-left', 'a:left-arrow-big']);
  });

  it('finds an icon by its alias and returns the canonical name, once', () => {
    const s = set('a', ['settings', 'cog-wheel'], [['gear', 0], ['gears', 0], ['cog', 1]]);
    expect(searchSets([s], 'gear', { limit: 10 })).toEqual(['a:settings']);
    expect(searchSets([s], 'cog', { limit: 10 })).toEqual(['a:cog-wheel']);
  });

  it('lists an icon found by both its name and an alias once, ranked by the name', () => {
    const s = set('a', ['home', 'house-home'], [['home-alias', 0], ['homey', 1]]);
    expect(searchSets([s], 'home', { limit: 10 })).toEqual(['a:home', 'a:house-home']);
  });

  it('ranks a name match over an alias match over a category match', () => {
    const s = set('a', ['pen-tool', 'draw-pad', 'palette'], [['pen', 1]], { Pens: [2] });
    expect(searchSets([s], 'pen', { limit: 10 })).toEqual(['a:pen-tool', 'a:draw-pad', 'a:palette']);
  });

  it('matches category names when the other words match the name', () => {
    const s = set('a', ['home', 'arrow-up', 'arrow-left'], [], { Navigation: [0, 1] });
    expect(searchSets([s], 'navigation', { limit: 10 })).toEqual(['a:home', 'a:arrow-up']);
    expect(searchSets([s], 'navigation arrow', { limit: 10 })).toEqual(['a:arrow-up']);
  });

  it('breaks ties in favour of the set earlier in the list', () => {
    const first = set('first', ['star']);
    const second = set('second', ['star']);
    expect(searchSets([first, second], 'star', { limit: 10 })).toEqual(['first:star', 'second:star']);
    expect(searchSets([second, first], 'star', { limit: 10 })).toEqual(['second:star', 'first:star']);
  });

  it('keeps at most perSet results from one set and at most limit overall', () => {
    const a = set('a', ['x-1', 'x-2', 'x-3', 'x-4']);
    const b = set('b', ['x-5', 'x-6']);
    expect(searchSets([a, b], 'x', { limit: 10, perSet: 2 })).toEqual(['a:x-1', 'a:x-2', 'b:x-5', 'b:x-6']);
    expect(searchSets([a, b], 'x', { limit: 3 })).toEqual(['a:x-1', 'a:x-2', 'a:x-3']);
  });

  it('keeps the best results of a set when it caps it', () => {
    const a = set('a', ['xx-big', 'x', 'x-y']);
    expect(searchSets([a], 'x', { limit: 10, perSet: 2 })).toEqual(['a:x', 'a:x-y']);
  });

  it('returns nothing for an empty query, an empty set list or no match', () => {
    const s = set('a', ['star']);
    expect(searchSets([s], '', { limit: 10 })).toEqual([]);
    expect(searchSets([s], '  ', { limit: 10 })).toEqual([]);
    expect(searchSets([], 'star', { limit: 10 })).toEqual([]);
    expect(searchSets([s], 'moon', { limit: 10 })).toEqual([]);
    expect(searchSets([s], 'star', { limit: 0 })).toEqual([]);
  });

  it('is fast enough over a large corpus to run on every keystroke', () => {
    const big = Array.from({ length: 20 }, (_, k) => set(`s${k}`, Array.from({ length: 15_000 }, (_, i) => `icon-${i}-${k}-thing`), [], undefined));
    const t0 = performance.now();
    const found = searchSets(big, 'icon 77', { limit: 48, perSet: 8 });
    expect(found).toHaveLength(48);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
