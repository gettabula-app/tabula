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
