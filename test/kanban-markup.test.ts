import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cardContentHeight, objectMarkup, type MarkupCtx } from '../src/markup';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import type { BaseObj, Id } from '../src/types';
import { USER_COLORS } from '../src/palette';
import { resolveColorMix, resolveCssVars } from '../src/exporters';
import { LABEL_COLORS, kanbanColor, validLabel } from '../shared/containers';

// docs/kanban.md, slice 2 (Rendering and Visual design): what a container, a lane and a card draw.

function board() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  store.labels.set('bug', { id: 'bug', name: 'Bug', color: 'pink', order: 0 });
  store.labels.set('ui', { id: 'ui', name: 'Frontend', color: 'teal', order: 1 });
  store.labels.set('doc', { id: 'doc', name: 'Docs', color: 'violet', order: 2 });
  store.labels.set('ch', { id: 'ch', name: 'Chore', color: 'grey', order: 3 });
  const ids = ['Write the guide', 'Fix the login loop'].map((t) => addCard(store, lanes[0].id, t, { createdBy: 'me' })!);
  return { store, container: container.id, lanes: lanes.map((l) => l.id), ids };
}

function ctxFor(store: Store, extra: Partial<MarkupCtx> = {}): MarkupCtx {
  return {
    get: (id) => store.getPlaced(id),
    containerLayout: (id) => store.containerLayout(id),
    label: (id) => store.labels.get(id),
    editable: true,
    today: '2026-10-09',
    ...extra,
  };
}

const draw = (store: Store, id: Id, extra: Partial<MarkupCtx> = {}) => objectMarkup(store.getPlaced(id)!, ctxFor(store, extra));
const outsideVars = (svg: string) => svg.replace(/var\([^)]*\)/g, '');
const HEX = /#[\da-f]{3,8}\b|rgba?\(|\b(?:white|black)\b/i;

describe('the container', () => {
  it('draws its name, its lane and card counts and the 2px rule under its header', () => {
    const { store, container } = board();
    const svg = draw(store, container);
    expect(svg).toContain('>Kanban</text>');
    expect(svg).toContain('3 LANES · 2 CARDS');
    expect(svg).toContain('y="46" width="');
    expect(outsideVars(svg)).not.toMatch(HEX);
  });

  it('keeps only its name, larger, below zoom 0.4', () => {
    const { store, container } = board();
    const svg = draw(store, container, { zoom: 0.3 });
    expect(svg).toContain('font-size="40"');
    expect(svg).not.toContain('LANES');
  });
});

describe('a lane', () => {
  it('draws its name, its count and the add-card row for editors', () => {
    const { store, lanes } = board();
    const svg = draw(store, lanes[0]);
    expect(svg).toContain('>To do</text>');
    expect(svg).toMatch(/>2<\/text>/);
    expect(svg).toContain('Add card');
    expect(outsideVars(svg)).not.toMatch(HEX);
  });

  it('offers no add-card row to viewers, nor where the inline input is', () => {
    const { store, lanes } = board();
    expect(draw(store, lanes[0], { editable: false })).not.toContain('Add card');
    expect(draw(store, lanes[0], { addingLane: lanes[0] })).not.toContain('Add card');
    expect(draw(store, lanes[1], { addingLane: lanes[0] })).toContain('Add card');
  });

  it('says No cards when empty, and Drop here while a card is dragged over it', () => {
    const { store, lanes } = board();
    expect(draw(store, lanes[1])).toContain('NO CARDS');
    expect(draw(store, lanes[1], { dropLane: lanes[1] })).toContain('DROP HERE');
    expect(draw(store, lanes[0])).not.toContain('NO CARDS');
  });

  it('marks a done lane, and only a done lane', () => {
    const { store, lanes } = board();
    expect(draw(store, lanes[2])).toContain('>DONE</text>');
    expect(draw(store, lanes[1])).not.toContain('>DONE</text>');
  });

  it('shows count over limit, and the danger chip and rule when over it', () => {
    const { store, lanes } = board();
    store.transact(() => store.update(lanes[0], { wip: 3 }));
    let svg = draw(store, lanes[0]);
    expect(svg).toContain('>2 / 3</text>');
    expect(svg).not.toContain('var(--danger');
    store.transact(() => store.update(lanes[0], { wip: 1 }));
    svg = draw(store, lanes[0]);
    expect(svg).toContain('>2 / 1</text>');
    expect(svg).toContain('Over the limit');
    expect(svg).toContain('y="46" width="280" height="2" style="fill:var(--danger');
  });

  it('tints its body and draws a 4px bar in its colour', () => {
    const { store, lanes } = board();
    store.transact(() => store.update(lanes[1], { fill: 'blue' }));
    const svg = draw(store, lanes[1]);
    expect(svg).toContain('height="4" style="fill:var(--s-blue');
    expect(svg).toContain('color-mix(in srgb, var(--s-blue, #A3D2FF) 10%');
  });

  it('keeps only its name, larger, below zoom 0.4', () => {
    const { store, lanes } = board();
    const svg = draw(store, lanes[0], { zoom: 0.39 });
    expect(svg).toContain('font-size="28"');
    expect(svg).not.toContain('Add card');
    expect(svg).not.toMatch(/>2<\/text>/);
  });
});

describe('a card', () => {
  it('draws its title in ink on paper with a hairline edge', () => {
    const { store, ids } = board();
    const svg = draw(store, ids[0]);
    expect(svg).toContain('Write the guide');
    expect(svg).toContain('fill:var(--paper');
    expect(outsideVars(svg)).not.toMatch(HEX);
  });

  it('draws label chips by name, at most three and then +n, ignoring unknown labels', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[1], { labels: ['bug', 'ui', 'gone', 'doc', 'ch'] }));
    const svg = draw(store, ids[1]);
    for (const name of ['BUG', 'FRONTEND', 'DOCS']) expect(svg).toContain(`>${name}</text>`);
    expect(svg).not.toContain('>CHORE</text>');
    expect(svg).toContain('>+1</text>');
    expect(svg).toContain('var(--s-pink, #FFA3C4)');
  });

  it('draws the due chip from the lane stage: overdue, soon, and plain with a check when done', () => {
    const { store, lanes, ids } = board();
    store.transact(() => store.update(ids[0], { due: '2026-10-06' }));
    expect(draw(store, ids[0])).toContain('>3 DAYS AGO</text>');
    expect(draw(store, ids[0])).toContain('<title>Overdue</title>');
    store.transact(() => store.update(ids[0], { due: '2026-10-10' }));
    expect(draw(store, ids[0])).toContain('>TOMORROW</text>');
    store.transact(() => store.update(ids[0], { due: '2026-10-06', parent: lanes[2], rank: `a0@${lanes[2]}` }));
    expect(draw(store, ids[0])).toContain('<title>Done</title>');
  });

  it('draws the owner badge with initials, ringed in the person colour when known and with a hairline when not', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[0], { ownerName: 'Johan Saldes', ownerId: 'u1' }));
    const known = draw(store, ids[0], { ownerColor: () => USER_COLORS[2] });
    expect(known).toContain('>JS</text>');
    expect(known).toContain(`stroke:${USER_COLORS[2]}`);
    // the person colour is the only colour that is not a theme variable: it is an identity, the same in every theme
    expect(outsideVars(known).replace(USER_COLORS[2], '')).not.toMatch(HEX);
    const free = draw(store, ids[0]);
    expect(free).toContain('(no account)');
    expect(free).not.toContain(USER_COLORS[2]);
  });

  it('shows the comment count in the meta row, and has no meta row without a due date or an owner', () => {
    const { store, ids } = board();
    expect(draw(store, ids[0], { commentCount: () => 3 })).not.toContain('3 comments');
    store.transact(() => store.update(ids[0], { ownerName: 'Lea' }));
    expect(draw(store, ids[0], { commentCount: () => 3 })).toContain('3 comments');
  });

  it('is a dashed placeholder with nothing inside while it is dragged', () => {
    const { store, ids } = board();
    const svg = draw(store, ids[0], { dragging: (id) => id === ids[0] });
    expect(svg).toContain('stroke-dasharray');
    expect(svg).not.toContain('Write the guide');
  });

  it('turns its title into bars and its chips into colour only below zoom 0.4', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[1], { labels: ['bug'], due: '2026-10-10' }));
    const svg = draw(store, ids[1], { zoom: 0.2 });
    expect(svg).not.toContain('Fix the login loop');
    expect(svg).not.toContain('>BUG</text>');
    expect(svg).not.toContain('TOMORROW');
    expect(svg).toContain('var(--s-pink');
  });

  it('stores a height that grows with the title lines and rows, up to three lines', () => {
    const base: BaseObj = { id: 'k', type: 'card', x: 0, y: 0, w: 264, h: 0, rotation: 0, z: 'a0', text: 'Short' };
    expect(cardContentHeight(base, 264)).toBe(34);
    expect(cardContentHeight({ ...base, labels: ['x'], ownerName: 'A' }, 264)).toBe(90);
    const long = { ...base, text: 'word '.repeat(200) };
    expect(cardContentHeight(long, 264)).toBe(8 + 3 * 18 + 8);
    expect(objectMarkup(long, { get: () => undefined }).match(/<tspan/g)).toHaveLength(3);
  });
});

describe('in an export', () => {
  it('leaves no theme variable behind once the variables are replaced by their fallbacks', () => {
    const { store, container, lanes, ids } = board();
    store.transact(() => {
      store.update(lanes[1], { fill: 'blue', wip: 1 });
      store.update(ids[0], { labels: ['bug', 'ui'], due: '2026-10-01', ownerName: 'Johan Saldes', ownerId: 'u1', fill: '#FFA3C4' });
      store.update(ids[1], { parent: lanes[1], rank: `a0@${lanes[1]}` });
    });
    const ctx = { ownerColor: () => USER_COLORS[0], commentCount: () => 2, zoom: 1, editable: false };
    for (const id of [container, ...lanes, ...ids]) {
      const svg = resolveColorMix(resolveCssVars(draw(store, id, ctx)));
      expect(svg).not.toContain('var(');
      // editors and renderers that do not know color-mix draw it black
      expect(svg).not.toContain('color-mix(');
      expect(svg).not.toContain('Add card');
    }
  });
});

describe('colours from the board', () => {
  const EVIL = ['red;transform:scale(50);filter:url(//evil/x)', 'url(//evil/x)', 'expression(alert(1))', 'var(--x)', '#12345'];
  const leaks = (svg: string) => /scale\(50\)|url\(|expression\(|evil|var\(--x\)|#12345/.test(svg);

  it('draws no CSS from a lane fill, a card fill or a label colour that is not a palette key or a hex colour', () => {
    const { store, lanes, ids } = board();
    for (const bad of EVIL) {
      store.transact(() => {
        store.update(lanes[0], { fill: bad });
        store.update(ids[0], { fill: bad, labels: ['evil'] });
      });
      store.labels.set('evil', { id: 'evil', name: 'Evil', color: bad, order: 9 });
      for (const id of [lanes[0], ids[0]]) expect(leaks(draw(store, id))).toBe(false);
      // the label stays, in the default colour
      expect(draw(store, ids[0])).toContain('>EVIL</text>');
      expect(draw(store, ids[0])).toContain('var(--s-grey, #E2E6EB)');
    }
  });

  it('draws every palette key as its swatch, on a lane, a card and a label', () => {
    const { store, lanes, ids } = board();
    for (const key of LABEL_COLORS) {
      store.transact(() => {
        store.update(lanes[0], { fill: key });
        store.update(ids[0], { fill: key, labels: ['k'] });
      });
      store.labels.set('k', { id: 'k', name: 'K', color: key, order: 0 });
      expect(draw(store, lanes[0])).toContain(`height="4" style="fill:var(--s-${key}, `);
      expect(draw(store, ids[0]).match(new RegExp(`var\\(--s-${key}, `, 'g'))!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('still draws palette keys and hex colours', () => {
    const { store, lanes, ids } = board();
    store.transact(() => {
      store.update(lanes[0], { fill: '#336699' });
      store.update(ids[0], { fill: 'Teal', labels: ['bug'] });
    });
    expect(draw(store, lanes[0])).toContain('style="fill:#336699"');
    expect(draw(store, ids[0]).toUpperCase()).toContain('#8FE3CA');
  });

  it('does not ring an owner badge in a colour that is not one', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[0], { ownerName: 'A B', ownerId: 'u' }));
    expect(leaks(draw(store, ids[0], { ownerColor: () => 'red;filter:url(//evil/x)' }))).toBe(false);
  });
});

describe('text from the board (slice 3 writes it)', () => {
  it('escapes a title, an owner name and a label name with markup in them', () => {
    const { store, ids } = board();
    const evil = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
    store.transact(() => store.update(ids[0], { text: evil, desc: evil, ownerName: evil, labels: ['x'], due: '2026-01-16' }));
    store.labels.set('x', { id: 'x', name: evil.slice(0, 40), color: 'blue', order: 0 });
    const svg = draw(store, ids[0], { ownerColor: () => undefined });
    expect(svg).not.toMatch(/<img|<script/i);
    expect(svg).toContain('&lt;img');
  });
});

describe('resolving color-mix for an export', () => {
  it('mixes two colours, and gives a mix with transparent as an opacity on fills and strokes', () => {
    expect(resolveColorMix('style="fill:color-mix(in srgb, #000000 50%, #FFFFFF)"')).toBe('style="fill:#808080"');
    expect(resolveColorMix('style="fill:none;stroke:color-mix(in srgb, #18212B 28%, transparent)"')).toBe('style="fill:none;stroke:#18212B;stroke-opacity:0.28"');
    expect(resolveColorMix('style="fill:color-mix(in srgb, #A3D2FF 10%, color-mix(in srgb, #000 0%, #fff))"')).toBe('style="fill:#F6FBFF"');
  });
});

describe('kanbanColor', () => {
  it('takes palette keys in any case, and colours safeColor accepts, in canonical form', () => {
    expect(kanbanColor('Teal')).toBe('teal');
    expect(kanbanColor('#abc')).toBe('#AABBCC');
    expect(kanbanColor('#a1b2c3d4')).toBe('#A1B2C3D4');
  });

  it('gives the fallback, never the value, for anything else', () => {
    for (const bad of ['red;filter:url(//x)', 'url(x)', 'expression(1)', '#12345', 'var(--x)', 'red', 'none', 'transparent', '', 3, null, undefined]) {
      expect(kanbanColor(bad)).toBeNull();
      expect(kanbanColor(bad, 'grey')).toBe('grey');
    }
  });

  it('keeps a label whose colour is bad, in the default colour, and drops one that is not a label', () => {
    expect(validLabel({ id: 'a', name: 'A', color: 'url(//x)', order: 1 })).toEqual({ id: 'a', name: 'A', color: 'grey', order: 1 });
    expect(validLabel({ id: 'a', name: 'x'.repeat(41), color: 'blue' })).toBeNull();
    expect(validLabel('bug')).toBeNull();
  });
});
