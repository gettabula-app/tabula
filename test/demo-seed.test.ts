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
    ? { x: 40, y: 25, w: 300, h: 330 }
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
  it('creates a complete, laid out board in one store transaction as a plain board with comments', () => {
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

    // a plain board: no session, no vote, no poll
    expect(app.store.getFlow()).toMatchObject({ steps: [], active: -1, reveal: false });
    const flow = flowFor(app);
    expect(flow.isVoting()).toBe(false);
    expect(flow.pollOpen()).toBe(false);
    expect(app.store.votes.size).toBe(0);
    expect(app.store.polls.size).toBe(0);
    expect(app.store.pollAnswers.size).toBe(0);

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

  it('opens a phone on one small group of four notes, with the rest below the first screen', () => {
    withAnimationFrame();
    const app = fakeApp('demo-visitor', { w: 390, h: 844 });
    seedDemo(app);

    expect(app.store.get('demo-instructions')).toMatchObject({ text: 'Tap a note to edit it. Drag to move it.', fontSize: 15 });
    const well = app.store.get('demo-well-frame')!;
    expect(well).toMatchObject({ x: 40, w: 300 });
    const notes = app.store.childrenOf(well.id);
    expect(notes).toHaveLength(4);
    expect(notes.every((n) => n.type === 'sticky' && n.w === 130 && n.h === 80 && n.fontSize === 16)).toBe(true);
    expect(new Set(notes.map((n) => n.x)).size).toBe(2); // 2 columns
    expect(new Set(notes.map((n) => n.y)).size).toBe(2); // 2 rows
    for (const n of notes) {
      const r = app.store.geometry(n), f = app.store.geometry(well);
      expect(r.x).toBeGreaterThanOrEqual(f.x);
      expect(r.x + r.w).toBeLessThanOrEqual(f.x + f.w);
      expect(r.y + r.h).toBeLessThanOrEqual(f.y + f.h);
    }
    // everything else sits far below the first screen
    const wellRect = app.store.geometry(well);
    const firstScreenBottom = wellRect.y + wellRect.h;
    for (const id of ['demo-improve-frame', 'demo-flow-frame', 'demo-toolkit-frame']) expect(app.store.get(id)!.y).toBeGreaterThan(firstScreenBottom + 500);
    expect(app.r.contentBounds).toHaveBeenCalledWith(['demo-title', 'demo-instructions', 'demo-well-frame']);
    const camera = vi.mocked(app.r.setCamera).mock.calls[0][0];
    expect(camera.zoom).toBeGreaterThanOrEqual(0.8);
    expect(16 * (camera.zoom ?? 0)).toBeGreaterThanOrEqual(13);
    // one thread, below the first screen
    const threads = app.comments.list();
    expect(threads).toHaveLength(1);
    expect(threads[0].anchor.obj).toBe('demo-improve-frame');
    expect(flowFor(app).isVoting()).toBe(false);
  });

  it('uses theme variable colours and the serif face, so the seed reads in dark themes too', () => {
    withAnimationFrame();
    const app = fakeApp();
    seedDemo(app);

    expect(app.store.get('demo-title')).toMatchObject({ font: 'gambetta', textColor: expect.stringMatching(/^var\(--/) });
    expect(app.store.get('demo-instructions')).toMatchObject({ textColor: expect.stringMatching(/^var\(--/) });
    expect(app.store.get('demo-font-example')).toMatchObject({ textColor: expect.stringMatching(/^var\(--/) });
    const frames = [...app.store.cache.values()].filter((o) => o.type === 'frame');
    expect(frames).toHaveLength(4);
    for (const frame of frames) expect(frame).toMatchObject({ fill: 'var(--paper, #FFFFFF)', font: 'gambetta' });
    expect(frames).not.toContainEqual(expect.objectContaining({ font: 'cabinet-grotesk' }));
  });

  it('lets the visitor start a dot vote after the plain board opens', () => {
    withAnimationFrame();
    const app = fakeApp();
    seedDemo(app);
    const flow = flowFor(app);

    expect(flow.isVoting()).toBe(false);
    flow.quickVote(0, { kind: 'stickies' });
    expect(flow.isVoting()).toBe(true);
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
