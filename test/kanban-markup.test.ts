import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cardContentHeight, objectMarkup, type MarkupCtx } from '../src/markup';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import type { BaseObj, Id } from '../src/types';
import { USER_COLORS } from '../src/palette';

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
