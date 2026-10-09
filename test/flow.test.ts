import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow, UNLIMITED } from '../src/flow';
import type { BaseObj } from '../src/types';
import { inkOn, mix, normalizeHex } from '../src/palette';
import { objectMarkup } from '../src/markup';

/** The parts of BoardApp that Flow uses, without any DOM. */
function fakeApp(doc = new Y.Doc(), userId = 'me') {
  const store = new Store(doc);
  const app = {
    store,
    user: { id: userId, name: userId, color: '#000' },
    r: { invalidateAll() {}, setOverlay() {}, flyTo() {}, flyToCenter() {}, viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }) },
    zoom: 1,
    emit() {},
    participants: () => [],
  };
  const flow = new Flow(app as never);
  return { store, flow };
}

const note = (id: string): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: id });

describe('dot voting', () => {
  it('allows any number of dots with no limit', () => {
    const { store, flow } = fakeApp();
    store.transact(() => { store.create(note('a')); store.create(note('b')); });
    flow.quickVote(UNLIMITED);
    expect(flow.isVoting()).toBe(true);
    for (let i = 0; i < 25; i++) flow.handleClick(store.get('a')!, false);
    flow.handleClick(store.get('b')!, false);
    expect(flow.myVoteCount()).toBe(26);
    expect(flow.myVotesLeft()).toBe(Infinity);
    // shift-click removes one of mine
    flow.handleClick(store.get('a')!, true);
    expect(flow.myVoteCount()).toBe(25);
  });

  it('enforces a limit, and raising it mid-vote frees more dots', () => {
    const { store, flow } = fakeApp();
    store.transact(() => store.create(note('a')));
    flow.quickVote(3);
    for (let i = 0; i < 5; i++) flow.handleClick(store.get('a')!, false);
    expect(flow.myVoteCount()).toBe(3);
    expect(flow.myVotesLeft()).toBe(0);
    flow.setVoteLimit(5);
    for (let i = 0; i < 5; i++) flow.handleClick(store.get('a')!, false);
    expect(flow.myVoteCount()).toBe(5);
    flow.setVoteLimit(UNLIMITED);
    flow.handleClick(store.get('a')!, false);
    expect(flow.myVoteCount()).toBe(6);
  });

  it('hides totals until reveal and counts dots from everyone', () => {
    const doc1 = new Y.Doc(), doc2 = new Y.Doc();
    const A = fakeApp(doc1, 'ada'), B = fakeApp(doc2, 'bo');
    A.store.transact(() => A.store.create(note('a')));
    A.flow.quickVote(UNLIMITED);
    const sync = () => {
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)));
    };
    sync();
    for (let i = 0; i < 4; i++) A.flow.handleClick(A.store.get('a')!, false);
    for (let i = 0; i < 7; i++) B.flow.handleClick(B.store.get('a')!, false);
    sync();
    expect(A.flow.summary().get('a')).toEqual({ mine: 4, total: null });
    expect(A.flow.voteStats()).toEqual({ dots: 11, voters: 2 });
    A.flow.reveal();
    sync();
    expect(B.flow.summary().get('a')).toEqual({ mine: 7, total: 11 });
  });

  it('keeps the dots on the board after finishing, until cleared', () => {
    const { store, flow } = fakeApp();
    store.transact(() => { store.create(note('a')); store.create(note('b')); });
    flow.quickVote(UNLIMITED);
    for (let i = 0; i < 3; i++) flow.handleClick(store.get('b')!, false);
    flow.handleClick(store.get('a')!, false);
    flow.end();
    expect(flow.state().active).toBe(-1);
    expect(flow.state().steps).toEqual([]); // the one-click vote leaves no steps behind
    expect(flow.resultsCount()).toBe(4);
    expect(flow.ranked(flow.state().results!).map((r) => [r.item.id, r.votes])).toEqual([['b', 3], ['a', 1]]);
    expect(flow.summaryMarkdown()).not.toContain('undefined');
    flow.clearResults();
    expect(flow.resultsCount()).toBe(0);
    expect(store.votes.size).toBe(0);
  });

  it('inserts a one-click vote after the current step of a running session', () => {
    const { flow } = fakeApp();
    flow.setSteps([
      { id: 's1', title: 'Write', instructions: '', mode: 'write' },
      { id: 's2', title: 'Discuss', instructions: '', mode: 'discuss' },
    ]);
    flow.start();
    flow.quickVote();
    expect(flow.state().steps.map((s) => s.title)).toEqual(['Write', 'Dot vote', 'Discuss']);
    expect(flow.state().active).toBe(1);
    flow.end();
    expect(flow.state().steps.map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('sticky colours', () => {
  it('picks readable ink for any note colour', () => {
    expect(inkOn('#FFE16B')).toBe('#1D1A12');
    expect(inkOn('#A3D2FF')).toBe('#1D1A12');
    expect(inkOn('#18212B')).toBe('#FFFFFF');
    expect(inkOn('#2F6FED')).toBe('#FFFFFF');
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('draws a sticky with a folded corner and white text on a dark note', () => {
    const svg = objectMarkup({ ...note('d'), fill: '#18212B', text: 'Dark note' }, { get: () => undefined });
    expect(svg).toContain('url(#sticky-flap)');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('url(#sticky-curl-shadow)');
  });
});

describe('markdown summary and hidden content', () => {
  const frame = { id: 'f', type: 'frame', x: 0, y: 0, w: 800, h: 600, rotation: 0, z: 'a0', name: 'Ideas' } as BaseObj;
  const inFrame = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({ ...note(id), x: 10, y: 10, parent: 'f', ...extra }) as BaseObj;

  it('leaves out private notes by other people until the reveal', () => {
    const doc = new Y.Doc();
    const A = fakeApp(doc, 'ana');
    const B = fakeApp(doc, 'ben');
    A.store.transact(() => {
      A.store.create(frame);
      A.store.create(inFrame('mine', { text: 'ana secret', privateStep: 's', createdBy: 'ana' } as never));
      A.store.create(inFrame('open', { text: 'visible' }));
    });
    const forBen = B.flow.summaryMarkdown();
    expect(forBen).toContain('visible');
    expect(forBen).not.toContain('ana secret');
    expect(A.flow.summaryMarkdown()).toContain('ana secret'); // the author still sees their own
    B.flow.reveal();
    expect(B.flow.summaryMarkdown()).toContain('ana secret');
  });

  it('shows vote totals of a running vote only after the reveal', () => {
    const { store, flow } = fakeApp();
    store.transact(() => { store.create(frame); store.create(inFrame('a', { text: 'alpha' })); });
    flow.quickVote(UNLIMITED);
    flow.handleClick(store.get('a')!, false);
    flow.handleClick(store.get('a')!, false);
    expect(flow.summaryMarkdown()).toContain('- alpha');
    expect(flow.summaryMarkdown()).not.toContain('vote');
    flow.reveal();
    expect(flow.summaryMarkdown()).toContain('- alpha (2 votes)');
  });

  it('keeps totals of a finished vote', () => {
    const { store, flow } = fakeApp();
    store.transact(() => { store.create(frame); store.create(inFrame('a', { text: 'alpha' })); });
    flow.quickVote(UNLIMITED);
    flow.handleClick(store.get('a')!, false);
    flow.end();
    expect(flow.summaryMarkdown()).toContain('- alpha (1 vote)');
  });
});

describe('pictures in the markdown summary', () => {
  const frame = { id: 'f', type: 'frame', x: 0, y: 0, w: 800, h: 600, rotation: 0, z: 'a0', name: 'Ideas' } as BaseObj;
  const picture = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({ id, type: 'image', x: 10, y: 10, w: 200, h: 100, rotation: 0, z: 'a1', parent: 'f', asset: 'ab'.repeat(32), mime: 'image/png', nw: 640, nh: 480, ...extra }) as BaseObj;

  it('lists a picture by its description, or by what it is when it has none', () => {
    const { store, flow } = fakeApp();
    store.transact(() => {
      store.create(frame);
      store.create(picture('a', { alt: '  A board   with\nthree columns ', y: 10 }));
      store.create(picture('b', { y: 200 }));
      store.create(picture('c', { mime: 'image/jpeg', nw: undefined, nh: undefined, y: 400 }));
      store.create({ ...note('n'), parent: 'f', x: 10, y: 600 } as BaseObj);
    });
    const md = flow.summaryMarkdown();
    expect(md).toContain('- Image: A board with three columns');
    expect(md).toContain('- Image (image/png, 640 x 480)');
    expect(md).toContain('- Image (image/jpeg, 200 x 100)');
    expect(md).toContain('- n');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('ab'.repeat(32));
  });

  it('keeps a picture outside any frame out, as a note outside a frame is', () => {
    const { store, flow } = fakeApp();
    store.transact(() => store.create(picture('a', { parent: undefined, alt: 'loose' })));
    expect(flow.summaryMarkdown()).not.toContain('loose');
  });
});

describe('dot vote scope (TAB-232)', () => {
  const frame = (id: string): BaseObj => ({ id, type: 'frame', x: 0, y: 0, w: 400, h: 400, rotation: 0, z: 'a0', text: id });
  const shape = (id: string): BaseObj => ({ id, type: 'shape', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: 'a1', text: id } as BaseObj);
  const path = (id: string): BaseObj => ({ id, type: 'path', x: 0, y: 0, w: 50, h: 50, rotation: 0, z: 'a2' } as BaseObj);

  function setup() {
    const f = fakeApp();
    f.store.transact(() => { for (const o of [note('n1'), note('n2'), shape('s1'), frame('f1'), path('p1')]) f.store.create(o); });
    return f;
  }

  it("Everything keeps today's set: notes and shapes, not frames or drawings", () => {
    const { store, flow } = setup();
    flow.quickVote(UNLIMITED);
    expect(flow.eligible({ kind: 'all' }).map((o) => o.id).sort()).toEqual(['n1', 'n2', 's1']);
    for (const id of ['n1', 's1', 'f1', 'p1']) flow.handleClick(store.get(id)!, false);
    expect(flow.myVoteCount()).toBe(2);
  });

  it('Stickies only counts and accepts stickies alone', () => {
    const { store, flow } = setup();
    flow.quickVote(UNLIMITED, { kind: 'stickies' });
    expect(flow.eligible({ kind: 'stickies' }).map((o) => o.id).sort()).toEqual(['n1', 'n2']);
    flow.handleClick(store.get('s1')!, false);
    expect(flow.myVoteCount()).toBe(0);
    flow.handleClick(store.get('n2')!, false);
    expect(flow.myVoteCount()).toBe(1);
  });

  it('Selection takes exactly the chosen items, a frame included, and nothing else', () => {
    const { store, flow } = setup();
    flow.quickVote(UNLIMITED, { kind: 'selection', ids: ['f1', 'n1'] });
    expect(flow.activeStep()).toMatchObject({ voteScope: 'selection', voteItems: ['f1', 'n1'] });
    for (const id of ['f1', 'n1', 'n2', 's1']) flow.handleClick(store.get(id)!, false);
    expect(flow.ranked(flow.activeStep()!.id).map((r) => r.item.id).sort()).toEqual(['f1', 'n1']);
  });

  it('says so when a click is not part of the vote, but not for a frame or for removing a dot', () => {
    const { store, flow } = setup();
    let skips = 0;
    (flow as unknown as { app: { emit: (e: string) => void } }).app.emit = (e: string) => { if (e === 'vote-skip') skips++; };
    flow.quickVote(UNLIMITED, { kind: 'stickies' });
    flow.handleClick(store.get('s1')!, false);
    expect(skips).toBe(1);
    flow.handleClick(store.get('f1')!, false);
    flow.handleClick(store.get('s1')!, true);
    expect(skips).toBe(1);
  });

  it('a locked item is votable, as in Everything and Sticky notes only, because facilitators lock notes before a vote', () => {
    const { store, flow } = fakeApp();
    store.transact(() => { store.create({ ...note('locked'), locked: true } as BaseObj); store.create(note('free')); });
    for (const kind of ['all', 'stickies'] as const) {
      expect(flow.eligible({ kind }).map((o) => o.id).sort()).toEqual(['free', 'locked']);
    }
    flow.quickVote(UNLIMITED, { kind: 'stickies' });
    flow.handleClick(store.get('locked')!, false);
    expect(flow.myVoteCount()).toBe(1);
  });

  it('an old vote step without a scope still means Everything', () => {
    const { store, flow } = setup();
    flow.quickVote(UNLIMITED);
    expect(flow.activeStep()!.voteScope).toBeUndefined();
    expect(flow.canVote(flow.activeStep(), store.get('s1'))).toBe(true);
  });
});
