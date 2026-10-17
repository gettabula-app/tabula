import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cardBody, cardContentHeight, cardTitleLines, kanbanHeaderControls, objectMarkup, type MarkupCtx } from '../src/markup';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import type { BaseObj, Id } from '../src/types';
import { USER_COLORS } from '../src/palette';
import type { BoardApp } from '../src/app';
import { exportSvg, resolveColorMix, resolveCssVars } from '../src/exporters';
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
  it('draws its name, its lane and card counts and the 1px rule under its header', () => {
    const { store, container } = board();
    const svg = draw(store, container);
    expect(svg).toContain('>Kanban</text>');
    expect(svg).toContain('3 lanes · 2 cards');
    expect(svg).toMatch(/<rect x="12" y="47" width="[\d.]+" height="1"/);
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
    expect(draw(store, lanes[1])).toContain('>No cards</text>');
    expect(draw(store, lanes[1], { dropLane: lanes[1] })).toContain('>Drop here</text>');
    expect(draw(store, lanes[0])).not.toContain('No cards');
  });

  it('marks a done lane, and only a done lane', () => {
    const { store, lanes } = board();
    expect(draw(store, lanes[2])).toContain('>Done</text>');
    expect(draw(store, lanes[1])).not.toContain('>DONE</text>');
  });

  it('says Done once: a lane called Done shows the name and the check, a lane with another name adds the word', () => {
    const { store, lanes } = board();
    const called = draw(store, lanes[2]);
    expect(called.match(/>Done<\/text>/g)).toHaveLength(1);
    expect(called).toContain('Stage: done');
    store.transact(() => store.update(lanes[2], { name: 'Shipped' }));
    const other = draw(store, lanes[2]);
    expect(other).toContain('>Shipped</text>');
    expect(other.match(/>Done<\/text>/g)).toHaveLength(1);
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
    // over the limit is the red "Over limit" pill (words and colour), not the yellow at-limit pill and not a danger rule
    expect(svg).toContain('>Over limit</text>');
    expect(svg).not.toContain('>At limit</text>');
    expect(svg).toMatch(/<rect x="[\d.]+" y="16" width="[\d.]+" height="20" rx="4" style="fill:var\(--tag-red/);
    // a block-mode lane that is over its limit still shows its lock
    store.transact(() => store.update(lanes[0], { wipMode: 'block' }));
    expect(draw(store, lanes[0])).toMatch(/<rect x="5" y="10.5" width="14" height="10"/);
  });

  it('keeps its body neutral, and draws its colour as a dot before its name', () => {
    const { store, lanes } = board();
    const plain = draw(store, lanes[1]);
    store.transact(() => store.update(lanes[1], { fill: 'blue' }));
    const svg = draw(store, lanes[1]);
    expect(svg).toContain('<circle cx="16" cy="26" r="4" style="fill:var(--s-blue, ');
    expect(svg).not.toContain('color-mix(in srgb, var(--s-blue');
    expect(svg).not.toContain('height="4" style="fill:var(--s-blue');
    expect(svg.match(/<rect x="0" y="0" width="280" height="208" rx="12" style="([^"]*)"/)?.[1]).toBe(plain.match(/<rect x="0" y="0" width="280" height="208" rx="12" style="([^"]*)"/)?.[1]);
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
    for (const name of ['Bug', 'Frontend', 'Docs']) expect(svg).toContain(`>${name}</text>`);
    expect(svg).not.toContain('>Chore</text>');
    expect(svg).toContain('>+1</text>');
    expect(svg).toContain('var(--s-pink, #FFA3C4)');
  });

  it('draws the due chip from the lane stage: overdue, soon, and plain with a check when done', () => {
    const { store, lanes, ids } = board();
    store.transact(() => store.update(ids[0], { due: '2026-10-06' }));
    expect(draw(store, ids[0])).toContain('>3 days ago</text>');
    expect(draw(store, ids[0])).toContain('<title>Overdue</title>');
    store.transact(() => store.update(ids[0], { due: '2026-10-10' }));
    expect(draw(store, ids[0])).toContain('>Tomorrow</text>');
    store.transact(() => store.update(ids[0], { due: '2026-10-06', parent: lanes[2], rank: `a0@${lanes[2]}` }));
    expect(draw(store, ids[0])).toContain('<title>Done</title>');
  });

  it('draws the owner badge with initials, ringed in the person colour when known and with a hairline when not', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[0], { ownerName: 'Alex Berg', ownerId: 'u1' }));
    const known = draw(store, ids[0], { ownerColor: () => USER_COLORS[2] });
    expect(known).toContain('>AB</text>');
    expect(known).toContain(`stroke:${USER_COLORS[2]}`);
    // the person colour is the only colour that is not a theme variable: it is an identity, the same in every theme
    expect(outsideVars(known).replace(USER_COLORS[2], '')).not.toMatch(HEX);
    const free = draw(store, ids[0]);
    expect(free).toContain('(no account)');
    expect(free).not.toContain(USER_COLORS[2]);
  });

  it('draws agent owners with a distinct polygon badge shape instead of the person square', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[0], { ownerName: 'Build agent', ownerId: 'agent-1' }));
    const person = draw(store, ids[0]);
    expect(person).toContain('data-owner-kind="person"');
    store.transact(() => store.update(ids[0], { ownerKind: 'agent' }));
    const agent = draw(store, ids[0]);
    expect(agent).toContain('data-owner-kind="agent"');
    expect(agent).toContain('<polygon points=');
    expect(agent).toContain('>BA</text>');
    expect(agent).toContain('<title>Build agent (agent)</title>');
    expect(agent).not.toContain('(no account)');
  });

  it('puts a 24 by 24 keyboard-focusable safe external link on the card face', () => {
    const { store, ids } = board();
    store.transact(() => store.update(ids[0], { link: 'https://example.com/docs?a=1&b=2', text: 'Read plan' }));
    const svg = draw(store, ids[0]);
    expect(svg).toContain('class="k-card-link"');
    expect(svg).toContain('data-card-link="true"');
    expect(svg).toContain('href="https://example.com/docs?a=1&amp;b=2"');
    expect(svg).toContain('target="_blank"');
    expect(svg).toContain('rel="noopener noreferrer"');
    expect(svg).toContain('tabindex="0"');
    expect(svg).toContain('aria-label="Open link: Read plan"');
    expect(svg).toContain('<title>Open link: Read plan</title>');
    expect(svg).toMatch(/class="k-card-link-focus"[^>]*width="24" height="24"/);
    const credentialLink = objectMarkup({ ...store.getPlaced(ids[0])!, link: 'https://user:pass@example.com/' }, ctxFor(store));
    expect(credentialLink).not.toContain('k-card-link');
  });

  it('does not emit or reserve a link for a credential URL when markup receives raw data', () => {
    const { store, ids } = board();
    const card = store.get(ids[0]) as BaseObj;
    const withoutLink = { ...card, link: undefined };
    const unsafe = { ...card, link: 'https://user:pass@example.com/private' };
    expect(cardBody(unsafe, ctxFor(store))).not.toContain('data-card-link');
    expect(cardTitleLines(unsafe, card.w)).toEqual(cardTitleLines(withoutLink, card.w));
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
    expect(cardContentHeight({ ...base, labels: ['x'], ownerName: 'A' }, 264)).toBe(94);
    const long = { ...base, text: 'word '.repeat(200) };
    expect(cardContentHeight(long, 264)).toBe(8 + 3 * 18 + 8);
    expect(objectMarkup(long, { get: () => undefined }).match(/<tspan/g)).toHaveLength(3);
  });
});

describe('in an export', () => {
  it('keeps the card anchor in a standalone SVG export', () => {
    const { store, container, ids } = board();
    store.transact(() => store.update(ids[0], { link: 'https://example.com/a(b)?q=1' }));
    const app = {
      store,
      r: { contentBounds: () => ({ x: 0, y: 0, w: 500, h: 500 }), ctx: ctxFor(store) },
    } as unknown as BoardApp;
    const svg = exportSvg(app, [container], { fontCss: '' }).svg;
    expect(svg).toContain('<a class="k-card-link" data-card-link="true" href="https://example.com/a(b)?q=1"');
    expect(svg).toContain('aria-label="Open link: Write the guide"');
    expect(svg).toContain('<path');
  });

  it('leaves no theme variable behind once the variables are replaced by their fallbacks', () => {
    const { store, container, lanes, ids } = board();
    store.transact(() => {
      store.update(lanes[1], { fill: 'blue', wip: 1 });
      store.update(ids[0], { labels: ['bug', 'ui'], due: '2026-10-01', ownerName: 'Alex Berg', ownerId: 'u1', fill: '#FFA3C4' });
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
      expect(draw(store, ids[0])).toContain('>Evil</text>');
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
      expect(draw(store, lanes[0])).toContain(`<circle cx="16" cy="26" r="4" style="fill:var(--s-${key}, `);
      expect(draw(store, ids[0]).match(new RegExp(`var\\(--s-${key}, `, 'g'))!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('still draws palette keys and hex colours', () => {
    const { store, lanes, ids } = board();
    store.transact(() => {
      store.update(lanes[0], { fill: '#336699' });
      store.update(ids[0], { fill: 'Teal', labels: ['bug'] });
    });
    // a lane's hex colour is its dot; the lane body stays neutral
    const lane = draw(store, lanes[0]);
    expect(lane).toContain('<circle cx="16" cy="26" r="4" style="fill:#336699;"/>');
    expect(lane).toContain('style="fill:color-mix(in srgb, var(--ink, #18212B) 4%, var(--paper, #FFFFFF))"');
    // a card's teal colour is its 3px bar, and the bug label keeps its own dot
    expect(draw(store, ids[0]).toUpperCase()).toContain('#8FE3CA');
    expect(draw(store, ids[0])).toContain('<circle cx="20" cy="43" r="3" style="fill:var(--s-pink, #FFA3C4)"/>');
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

describe('slice 4: header controls, the lane ⋯, the add-lane + and dimming', () => {
  const chips = [{ key: 'mine', text: 'Mine' }, { key: 'label:bug', text: 'Bug' }];

  it('an editor gets Filter, the ⋯ and the +; a viewer gets Filter only; an export gets none', () => {
    const { store, container, lanes } = board();
    const ed = draw(store, container, { filterChips: () => [] });
    expect(ed).toContain('k-filter');
    expect(ed).toContain('k-menu');
    expect(ed).toContain('k-addlane');
    expect(draw(store, lanes[0])).toContain('k-menu');
    const viewer = draw(store, container, { filterChips: () => [], editable: false });
    expect(viewer).toContain('k-filter');
    expect(viewer).not.toContain('k-menu');
    expect(viewer).not.toContain('k-addlane');
    expect(draw(store, lanes[0], { editable: false })).not.toContain('k-menu');
    const file = draw(store, container, { editable: false });
    expect(file).not.toContain('k-filter');
  });

  it('an active filter: chips with remove buttons, Filter and its count chip; none of it below zoom 0.4', () => {
    const { store, container } = board();
    const svg = draw(store, container, { filterChips: () => chips });
    expect(svg).toContain('>Filter</text>');
    expect(svg).toContain('>2</text>');
    expect(svg.match(/k-fchip/g)).toHaveLength(2);
    expect(svg).toContain('>Mine<');
    expect(draw(store, container, { filterChips: () => chips, zoom: 0.3 })).not.toContain('k-filter');
  });

  it('chips that do not fit are left out, the Filter count still counts them; the name stops before the controls', () => {
    const { store, container } = board();
    const o = store.getPlaced(container) as BaseObj;
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `label:${i}`, text: `A long label name ${i}` }));
    const c = kanbanHeaderControls(o, many, true);
    expect(c.chips.length).toBeLessThan(12);
    expect(c.filter!.text).toBe('Filter');
    expect(c.filter!.count).toBe(12);
    expect(c.left).toBeGreaterThanOrEqual(o.w / 2);
    for (const chip of c.chips) expect(chip.rect.x + chip.rect.w).toBeLessThanOrEqual(c.filter!.rect.x);
    expect(c.menu!.x + c.menu!.w).toBe(o.w - 12);
  });

  it('a dimmed card draws at 35%, others at full strength', () => {
    const { store, ids } = board();
    expect(draw(store, ids[0], { dimmed: (o) => o.id === ids[0] })).toContain('opacity="0.35"');
    expect(draw(store, ids[1], { dimmed: (o) => o.id === ids[0] })).not.toContain('opacity=');
  });

  it('the open control draws pressed', () => {
    const { store, container, lanes } = board();
    const closed = draw(store, container, { filterChips: () => [] });
    const open = draw(store, container, { filterChips: () => [], openControl: { id: container, kind: 'menu' } });
    expect(open).not.toBe(closed);
    expect(draw(store, lanes[0], { openControl: { id: lanes[0], kind: 'menu' } })).not.toBe(draw(store, lanes[0]));
  });

  it('no hard-coded colours in any of it', () => {
    const { store, container, lanes, ids } = board();
    store.transact(() => store.update(lanes[1], { wip: 1, wipMode: 'block' }));
    addCard(store, lanes[1], 'Full', { createdBy: 'me' });
    const svg = [
      draw(store, container, { filterChips: () => chips, openControl: { id: container, kind: 'filter' } }),
      draw(store, container, { filterChips: () => [], openControl: { id: container, kind: 'menu' } }),
      draw(store, lanes[1], { openControl: { id: lanes[1], kind: 'menu' } }),
      draw(store, ids[0], { dimmed: () => true }),
    ].join('');
    expect(svg).toContain('k-add-full');
    expect(outsideVars(svg)).not.toMatch(HEX);
  });
});
