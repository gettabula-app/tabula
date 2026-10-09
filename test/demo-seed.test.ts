import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Comments } from '../src/comments';
import { Flow } from '../src/flow';
import { groupDepth } from '../src/groups';
import { sanitizeSvgBody } from '../src/markup';
import { USER_COLORS } from '../src/palette';
import { Store } from '../src/store';
import { seedDemo } from '../src/demo/seed';
import type { BoardApp } from '../src/app';
import { isConnector } from '../src/types';

afterEach(() => vi.unstubAllGlobals());

function fakeApp(userId = 'demo-visitor', viewport = { w: 1280, h: 800 }): BoardApp {
  const bounds = viewport.w <= 500
    ? { x: 40, y: 25, w: 530, h: 650 }
    : { x: 40, y: 25, w: 1110, h: 525 };
  return {
    store: new Store(new Y.Doc()),
    comments: new Comments(new Y.Doc()),
    user: { id: userId, name: 'Visitor', color: USER_COLORS[0] },
    zoomToFit: vi.fn<() => void>(),
    selection: [],
    on: vi.fn<(...args: unknown[]) => unknown>(),
    emit: vi.fn<(...args: unknown[]) => unknown>(),
    setSelection: vi.fn<(...args: unknown[]) => unknown>(),
    r: {
      size: vi.fn<() => ReturnType<BoardApp['r']['size']>>(() => ({ ...viewport, left: 0, top: 0 })),
      contentBounds: vi.fn<() => ReturnType<BoardApp['r']['contentBounds']>>(() => bounds),
      setCamera: vi.fn<(...args: unknown[]) => unknown>(),
      setOverlay: vi.fn<(...args: unknown[]) => unknown>(),
      invalidateAll: vi.fn<() => void>(),
    },
  } as unknown as BoardApp;
}

function withAnimationFrame() {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
}

function snapshot(app: BoardApp) {
  const sortedObjects = [...app.store.cache.values()]
    .map((o) => structuredClone(o))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    objects: sortedObjects,
    meta: app.store.meta.toJSON(),
    labels: app.store.labels.toJSON(),
    flow: app.store.flow.toJSON(),
    votes: app.store.votes.toJSON(),
    polls: app.store.polls.toJSON(),
    pollAnswers: app.store.pollAnswers.toJSON(),
    comments: app.comments.threads.toJSON(),
  };
}

const intersectsWithMargin = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, margin: number) =>
  a.x + a.w + margin > b.x && b.x + b.w + margin > a.x && a.y + a.h + margin > b.y && b.y + b.h + margin > a.y;

function flowFor(app: BoardApp): Flow {
  return new Flow(app);
}

describe('demo board seed', () => {
  it('creates a complete, laid out board in one store transaction with a live vote and comments', () => {
    withAnimationFrame();
    const app = fakeApp();
    const transact = vi.spyOn(app.store, 'transact');

    seedDemo(app);

    expect(transact).toHaveBeenCalledTimes(1);
    expect(app.store.getMeta().name).toBe('Try Tabula');
    expect(app.store.cache.size).toBe(45);
    expect(app.r.setCamera).toHaveBeenCalledTimes(1);
    const initialCamera = vi.mocked(app.r.setCamera).mock.calls[0][0];
    expect(initialCamera.zoom).toBeGreaterThanOrEqual(0.5);
    expect(initialCamera.zoom).toBeLessThanOrEqual(1);
    expect(app.store.undo.undoStack).toHaveLength(0);

    const objects = [...app.store.cache.values()];
    expect(objects.every((o) => o.updatedAt === Date.UTC(2026, 9, 9, 12, 0, 0))).toBe(true);
    const counts = Object.fromEntries(['text', 'frame', 'sticky', 'shape', 'connector', 'icon', 'group', 'container', 'lane', 'card']
      .map((type) => [type, objects.filter((o) => o.type === type).length]));
    expect(counts).toEqual({ text: 3, frame: 4, sticky: 9, shape: 7, connector: 4, icon: 7, group: 1, container: 1, lane: 3, card: 6 });
    expect(new Set(objects.map((o) => o.id)).size).toBe(objects.length);

    const parentLinks = objects.filter((o) => o.parent).map((child) => ({ child, parent: app.store.get(child.parent) }));
    expect(parentLinks.every(({ child, parent }) => !!parent && (
      child.type === 'lane' ? parent.type === 'container' :
        child.type === 'card' ? parent.type === 'lane' :
          ['frame', 'group', 'container'].includes(parent.type)
    ))).toBe(true);
    const frameChildren = objects.flatMap((child) => {
      const parent = child.parent ? app.store.get(child.parent) : undefined;
      return parent?.type === 'frame' && !isConnector(child) ? [{ child, parent }] : [];
    });
    const outsideFrames = frameChildren.filter(({ child, parent }) => {
      const r = app.store.geometry(child), p = app.store.geometry(parent);
      return r.x < p.x || r.y < p.y || r.x + r.w > p.x + p.w || r.y + r.h > p.y + p.h;
    }).map(({ child }) => child.id);
    expect(outsideFrames).toEqual([]);

    const roots = objects.filter((o) => !o.parent && o.type !== 'connector');
    for (let i = 0; i < roots.length; i++) {
      const a = app.store.geometry(roots[i]);
      for (let j = i + 1; j < roots.length; j++) {
        const b = app.store.geometry(roots[j]);
        expect(intersectsWithMargin(a, b, 8), `${roots[i].id} overlaps ${roots[j].id}`).toBe(false);
      }
    }

    const connectors = objects.filter(isConnector);
    const connectorEnds = connectors.flatMap((connector) => [connector.from, connector.to]);
    expect(connectorEnds.every((end) => end.kind === 'bound' && !!app.store.get(end.id))).toBe(true);

    const crew = app.store.get('demo-crew')!;
    const members = app.store.childrenOf(crew.id);
    expect(crew).toMatchObject({ type: 'group', name: 'Workshop crew', parent: 'demo-toolkit-frame' });
    expect(members.map((o) => o.id).sort()).toEqual(['demo-crew-jonas', 'demo-crew-marta', 'demo-crew-you']);
    for (const member of members) {
      expect(member.parent).toBe(crew.id);
      expect(groupDepth(member, (id) => app.store.get(id))).toBe(1);
    }

    const voteStep = app.store.getFlow().steps[0];
    expect(voteStep).toMatchObject({ id: 'demo-vote-step', mode: 'vote', votesPerPerson: 3, voteScope: 'selection' });
    expect(app.store.getFlow()).toMatchObject({ active: 0, reveal: false });
    const flow = flowFor(app);
    expect(flow.isVoting()).toBe(true);
    expect(flow.myVotesLeft()).toBe(3);
    expect([...app.store.votes.values()].map((v) => v.userId).sort()).toEqual(['demo-jonas', 'demo-marta']);
    const seededVotes = [...app.store.votes.values()].sort((a, b) => a.userId.localeCompare(b.userId));
    expect(seededVotes.map(({ userId, itemId }) => [userId, itemId])).toEqual([
      ['demo-jonas', 'demo-well-3'], ['demo-marta', 'demo-well-2'],
    ]);
    expect(Object.fromEntries(seededVotes.map((vote) => {
      const item = app.store.get(vote.itemId);
      return [vote.itemId, item && 'text' in item ? item.text : undefined];
    }))).toEqual({ 'demo-well-2': 'Try it', 'demo-well-3': 'Calm' });
    for (const vote of seededVotes) {
      const item = app.store.get(vote.itemId);
      expect(item).toMatchObject({ type: 'sticky', parent: 'demo-well-frame' });
      const text = item && 'text' in item ? item.text : undefined;
      expect(text?.length ?? Infinity).toBeLessThanOrEqual(6);
    }
    expect([...flow.summary(voteStep.id).values()].every((v) => v.total === null)).toBe(true);

    const poll = app.store.polls.get('demo-next-poll')!;
    expect(poll.options).toHaveLength(3);
    expect(poll.question).toBe('Which feature should we show next?');
    expect([...app.store.pollAnswers.values()].every((answer) => answer.userId !== app.user.id)).toBe(true);
    expect(app.store.pollAnswers.size).toBeGreaterThanOrEqual(2);

    const threads = app.comments.list();
    expect(threads).toHaveLength(3);
    expect(threads.every((t) => ['demo-marta', 'demo-jonas'].includes(t.authorId))).toBe(true);
    expect(threads.every((t) => app.store.get(t.anchor.obj))).toBe(true);
    expect(threads.map((t) => t.anchor.obj).sort()).toEqual(['demo-flow-frame', 'demo-improve-frame', 'demo-well-frame']);
    const anchorPositions: Record<string, readonly [number, number]> = {
      'demo-flow-frame': [0.65, 0.05], 'demo-improve-frame': [0.32, 0.05], 'demo-well-frame': [0.94, 0.05],
    };
    for (const thread of threads) {
      const expected = anchorPositions[thread.anchor.obj!]!;
      expect(thread.anchor.fx).toBeCloseTo(expected[0], 2);
      expect(thread.anchor.fy).toBeCloseTo(expected[1], 2);
      expect(app.store.get(thread.anchor.obj!)?.type).toBe('frame');
    }
    expect(threads.flatMap((t) => t.replies).every((r) => ['demo-marta', 'demo-jonas'].includes(r.authorId))).toBe(true);
    expect(new Set([...threads.map((t) => t.authorId), ...threads.flatMap((t) => t.replies.map((r) => r.authorId))]))
      .toEqual(new Set(['demo-marta', 'demo-jonas']));
    expect(threads[0].createdAt).toBe(Date.UTC(2026, 9, 9, 12, 0, 0));
    const allIds = [
      ...objects.map((o) => o.id), ...app.store.labels.keys(), ...app.store.getFlow().steps.map((s) => s.id),
      ...Array.from(app.store.polls.values()).flatMap((p) => [p.id, ...p.options.map((o) => o.id)]),
      ...threads.flatMap((t) => [t.id, ...t.replies.map((r) => r.id)]),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);

    const icons = objects.filter((o) => o.type === 'icon');
    expect(icons.filter((o) => o.type === 'icon' && !o.sticker)).toHaveLength(5);
    expect(icons.filter((o) => o.type === 'icon' && o.sticker)).toHaveLength(2);
    for (const icon of icons) {
      if (icon.type !== 'icon') continue;
      expect(sanitizeSvgBody(icon.body ?? '')).toBe(icon.body);
      expect(sanitizeSvgBody(icon.body ?? '')).not.toBe('');
    }
  });

  it('stacks the intro frames and flowchart on phones so they all fit above the vote bar', () => {
    withAnimationFrame();
    const app = fakeApp('demo-visitor', { w: 390, h: 844 });
    seedDemo(app);

    expect(app.store.get('demo-well-frame')).toMatchObject({ x: 40, y: 145, w: 530, h: 185 });
    expect(app.store.get('demo-improve-frame')).toMatchObject({ x: 40, y: 390, w: 530, h: 170 });
    expect(app.store.get('demo-flow-frame')).toMatchObject({ x: 40, y: 590, w: 530, h: 130 });
    expect(app.r.contentBounds).toHaveBeenCalledWith([
      'demo-title', 'demo-instructions', 'demo-well-frame', 'demo-improve-frame', 'demo-flow-frame',
    ]);
    const camera = vi.mocked(app.r.setCamera).mock.calls[0][0];
    expect(camera.zoom).toBeGreaterThanOrEqual(0.5);
  });

  it('can answer the seeded poll after moving to its step', () => {
    withAnimationFrame();
    const app = fakeApp();
    seedDemo(app);
    const flow = flowFor(app);
    const poll = app.store.polls.get('demo-next-poll')!;

    expect(flow.pollOpen()).toBe(false);
    flow.goto(1);
    expect(flow.pollOpen()).toBe(true);
    flow.polls.choose(poll.id, poll.options[1].id);
    expect(app.store.pollAnswers.get(`${poll.id}:${app.user.id}`)?.optionIds).toEqual([poll.options[1].id]);
  });

  it('is idempotent and produces the same JSON every time', () => {
    withAnimationFrame();
    const first = fakeApp();
    seedDemo(first);
    const before = JSON.stringify(snapshot(first));
    seedDemo(first);
    expect(JSON.stringify(snapshot(first))).toBe(before);
    expect(first.comments.list()).toHaveLength(3);

    const second = fakeApp();
    seedDemo(second);
    expect(JSON.stringify(snapshot(second))).toBe(before);
  });

  it('round trips through two real Stores and their comments docs', () => {
    withAnimationFrame();
    const left = fakeApp();
    seedDemo(left);
    const rightStore = new Store(new Y.Doc());
    Y.applyUpdate(rightStore.doc, Y.encodeStateAsUpdate(left.store.doc));
    expect([...rightStore.cache.values()].map((o) => structuredClone(o)).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...left.store.cache.values()].map((o) => structuredClone(o)).sort((a, b) => a.id.localeCompare(b.id)));
    expect(rightStore.meta.toJSON()).toEqual(left.store.meta.toJSON());
    expect(rightStore.flow.toJSON()).toEqual(left.store.flow.toJSON());
    expect(rightStore.votes.toJSON()).toEqual(left.store.votes.toJSON());
    expect(rightStore.polls.toJSON()).toEqual(left.store.polls.toJSON());
    expect(rightStore.pollAnswers.toJSON()).toEqual(left.store.pollAnswers.toJSON());

    const rightComments = new Comments(new Y.Doc());
    Y.applyUpdate(rightComments.doc, Y.encodeStateAsUpdate(left.comments.doc));
    expect(rightComments.list()).toEqual(left.comments.list());
  });
});
