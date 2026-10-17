import { describe, expect, it } from 'vitest';
import { cardContentHeight, objectMarkup, type MarkupCtx } from '../src/markup';
import type { BaseObj, ChecklistItem } from '../src/types';

// docs/kanban.md, Visual design: a card with a checklist shows its progress in a row under its details (TAB-372). A card with
// no items draws none of it and keeps its height.

const items = (done: number, total: number): ChecklistItem[] =>
  Array.from({ length: total }, (_, i) => ({ id: `i${i}`, text: `item ${i}`, done: i < done }));

const card = (extra: Partial<BaseObj> = {}): BaseObj => ({
  id: 'c', type: 'card', x: 0, y: 0, w: 264, h: 0, rotation: 0, z: 'a0', text: 'Paint the hall', ...extra,
} as BaseObj);

const draw = (o: BaseObj, extra: Partial<MarkupCtx> = {}) => objectMarkup(o, { get: () => undefined, ...extra });
const outsideVars = (svg: string) => svg.replace(/var\([^)]*\)/g, '');
const HEX = /#[\da-f]{3,8}\b|rgba?\(|\b(?:white|black)\b/i;

// The row at width 264: the count is 3 characters, so the bar starts at 12 + 19 + 21 + 8 = 60 and runs to 264 - 12 = 252.
const BAR_X = 60;
const BAR_W = 192;

describe('the checklist progress on the card face', () => {
  it('grows the stored height by exactly the progress row with items, and not with none or an empty list', () => {
    const plain = card({ due: '2026-10-20', ownerName: 'Ann' });
    const base = cardContentHeight(plain, 264);
    expect(cardContentHeight(card(), 264)).toBe(34);
    expect(cardContentHeight(card({ checklist: items(2, 5) }), 264)).toBe(34 + 22);
    expect(cardContentHeight(card({ checklist: items(0, 1) }), 264)).toBe(34 + 22);
    expect(cardContentHeight(card({ checklist: [] }), 264)).toBe(34);
    expect(cardContentHeight(card({ checklist: items(2, 5) }), 264)).toBe(cardContentHeight(card(), 264) + 22);
    expect(cardContentHeight({ ...plain, checklist: items(1, 2) }, 264)).toBe(base + 22);
    expect(cardContentHeight({ ...plain, checklist: [] }, 264)).toBe(base);
  });

  it('draws 2 of 5 as 2/5, with its tooltip and a bar filled to 2/5 of the rest of the row', () => {
    const svg = draw(card({ checklist: items(2, 5) }));
    expect(svg).toContain('class="k-checklist"');
    expect(svg).toContain('>2/5</text>');
    expect(svg).toContain('<title>Checklist: 2 of 5 done</title>');
    expect(svg).toMatch(new RegExp(`<rect x="${BAR_X}" y="[\\d.]+" width="${BAR_W}" height="3" rx="1.5"`));
    expect(svg).toMatch(new RegExp(`<rect x="${BAR_X}" y="[\\d.]+" width="${BAR_W * 2 / 5}" height="3" rx="1.5"`));
    expect(svg).toContain('M3.8 7.2');
  });

  it('shows the tick only once an item is done, and an unticked box with none', () => {
    expect(draw(card({ checklist: items(0, 5) }))).not.toContain('M3.8 7.2');
    expect(draw(card({ checklist: items(1, 5) }))).toContain('M3.8 7.2');
  });

  it('a complete checklist: weight 600 and ink text, a filled box and a full bar', () => {
    const svg = draw(card({ checklist: items(5, 5) }));
    expect(svg).toMatch(/font-weight="600"[^>]*>5\/5<\/text>/);
    expect(svg).toContain('<title>Checklist: 5 of 5 done</title>');
    expect(svg).toMatch(new RegExp(`<rect width="14" height="14" rx="2.5" style="fill:var\\(--ink, #18212B\\)"/>`));
    expect(svg).toMatch(new RegExp(`<rect x="${BAR_X}" y="[\\d.]+" width="${BAR_W}" height="3" rx="1.5" style="fill:var\\(--ink, #18212B\\)"/>`));
    expect(draw(card({ checklist: items(2, 5) }))).not.toMatch(/font-weight="600"[^>]*>2\/5</);
  });

  it('draws nothing of it on a card with no items, the same as a card with an empty list', () => {
    const none = draw(card());
    expect(none).not.toContain('Checklist');
    expect(none).not.toContain('k-checklist');
    expect(draw(card({ checklist: [] }))).toBe(none);
  });

  it('below zoom 0.4 draws only the bar, across the whole row, with no text and no box', () => {
    const svg = draw(card({ checklist: items(2, 5) }), { zoom: 0.3 });
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('2/5');
    expect(svg).not.toContain('M3.8 7.2');
    expect(svg).toContain('<title>Checklist: 2 of 5 done</title>');
    expect(svg).toMatch(/<rect x="12" y="[\d.]+" width="240" height="3" rx="1.5"/);
    expect(svg).toMatch(/<rect x="12" y="[\d.]+" width="96" height="3" rx="1.5"/);
  });

  it('draws no colour outside a theme variable, so an export can resolve it', () => {
    expect(outsideVars(draw(card({ checklist: items(2, 5) })))).not.toMatch(HEX);
    expect(outsideVars(draw(card({ checklist: items(5, 5) })))).not.toMatch(HEX);
  });
});
