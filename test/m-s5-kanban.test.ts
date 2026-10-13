import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { objectMarkup, type MarkupCtx } from '../src/markup';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import type { Id } from '../src/types';

function fixture() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((object) => store.create(object)));
  store.labels.set('ui', { id: 'ui', name: 'Frontend', color: 'teal', order: 0 });
  const card = addCard(store, lanes[0].id, 'Write the guide', { createdBy: 'me' })!;
  const ctx: MarkupCtx = {
    get: (id) => store.getPlaced(id),
    containerLayout: (id) => store.containerLayout(id),
    label: (id) => store.labels.get(id),
    editable: true,
    today: '2026-10-09',
  };
  return { store, container: container.id, lane: lanes[0].id, card, ctx };
}

const draw = (store: Store, id: Id, ctx: MarkupCtx) => objectMarkup(store.getPlaced(id)!, ctx);

describe('M-S5 kanban styling', () => {
  it('draws paper cards with rounded hairlines, sentence-case label dots and calendar due dates', () => {
    const { store, card, ctx } = fixture();
    store.transact(() => store.update(card, { labels: ['ui'], due: '2026-10-10', ownerName: 'Johan Saldes', ownerId: 'u1' }));

    const svg = draw(store, card, ctx);
    expect(svg).toContain('rx="8"');
    expect(svg).toContain('>Frontend</text>');
    expect(svg).toContain('>Tomorrow</text>');
    expect(svg).toContain('M7 3.5v3M17 3.5v3M3.5 9h17');
    expect(svg).toMatch(/<circle cx="[^"]+" cy="[^"]+" r="3" style="fill:var\(--s-teal/);
    expect(svg).toContain('data-owner-kind="person"');
    expect(svg).not.toContain('fill:var(--danger');
  });

  it('marks a lane at its limit with the quiet yellow pill (the over-limit red pill is pinned in kanban-markup)', () => {
    const { store, lane, ctx } = fixture();
    store.transact(() => store.update(lane, { wip: 1, wipMode: 'block' }));

    const svg = draw(store, lane, ctx);
    expect(svg).toContain('>At limit</text>');
    expect(svg).toContain('fill:var(--tag-yellow, #FBF3DB)');
    expect(svg).toContain('<title>Limit, blocks drops</title>');
    expect(svg).not.toContain('>Over limit</text>');
    expect(svg).not.toContain('fill:var(--danger');
  });
});
