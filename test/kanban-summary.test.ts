import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow } from '../src/flow';
import { addCard, newKanban } from '../src/containers';

// docs/kanban.md, Export and import: the Markdown summary lists a kanban as a heading, its lanes as lower headings and its
// cards as bullets with (owner, due); what Layers hides stays out, as in the rest of the summary.

function setup(user = 'me') {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  store.transact(() => store.update(container.id, { name: 'Q4 delivery' }));
  const [todo, doing, done] = lanes.map((l) => l.id);
  const app = { store, user: { id: user, name: user, color: '#000' }, r: { invalidateAll() {}, setOverlay() {} }, emit() {}, participants: () => [] };
  const md = () => new Flow(app as never).summaryMarkdown();
  return { store, container: container.id, todo, doing, done, md };
}

describe('the Markdown summary of a kanban', () => {
  it('lists the kanban, its lanes and its cards in the order drawn, with owner and due date', () => {
    const s = setup();
    const a = addCard(s.store, s.todo, 'Write the guide', { createdBy: 'me' })!;
    addCard(s.store, s.todo, 'Fix login', { createdBy: 'me' });
    s.store.transact(() => s.store.update(a, { ownerName: 'Ada', due: '2026-10-12' }));
    const md = s.md();
    expect(md).toContain('## Q4 delivery');
    expect(md).toContain('### To do');
    expect(md.indexOf('- Write the guide (Ada, 2026-10-12)')).toBeGreaterThan(-1);
    expect(md.indexOf('- Write the guide')).toBeLessThan(md.indexOf('- Fix login'));
    expect(md).toContain('_No cards_');
  });

  it('shows a lane limit and keeps a card on one line', () => {
    const s = setup();
    s.store.transact(() => s.store.update(s.doing, { wip: 2, wipMode: 'block' }));
    addCard(s.store, s.doing, 'One\n# not a heading', { createdBy: 'me' });
    const md = s.md();
    expect(md).toMatch(/### Doing \(.*1 of 2, blocks\)/);
    expect(md).toContain('- One # not a heading');
    expect(md).not.toMatch(/^# not a heading/m);
  });

  it('leaves out a hidden kanban, a hidden lane and a hidden card', () => {
    const s = setup();
    addCard(s.store, s.todo, 'Visible', { createdBy: 'me' });
    const h = addCard(s.store, s.todo, 'Secret card', { createdBy: 'me' })!;
    addCard(s.store, s.doing, 'In hidden lane', { createdBy: 'me' });
    s.store.transact(() => {
      s.store.update(h, { hidden: true });
      s.store.update(s.doing, { hidden: true });
    });
    let md = s.md();
    expect(md).toContain('- Visible');
    expect(md).not.toContain('Secret card');
    expect(md).not.toContain('In hidden lane');
    s.store.transact(() => s.store.update(s.container, { hidden: true }));
    md = s.md();
    expect(md).not.toContain('Q4 delivery');
    expect(md).not.toContain('Visible');
  });
});
