import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { featuresOf } from '../shared/containers';
import { boardAccess } from '../src/cloud-logic';
import { remapObjects } from '../src/custom-templates';
import { applyRestore, planRestore } from '../src/history';
import { objectMarkup } from '../src/markup';
import { exportSvg, toDrift, toJson } from '../src/exporters';
import { handlesFor } from '../src/render';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import { createTrackerFrame, TRACKER_FRAME_DEFAULT_SIZE, TRACKER_FRAME_MIN_SIZE } from '../src/tracker-frame';
import { holdAfter, LIVE_CAP, LIVE_HOLD_MS, pickLive, trackerPresentation, type LiveCandidate } from '../src/tracker/ui/frame';
import type { BaseObj } from '../src/types';
import { strFromU8, unzipSync } from 'fflate';

function trackerApp(store: Store) {
  return {
    store,
    r: {
      contentBounds: () => ({ x: 0, y: 0, w: 1280, h: 800 }),
      ctx: { get: (id: string) => store.getPlaced(id) },
    },
    conn: { comments: { list: () => [] } },
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    images: { blobOf: async () => null },
  };
}

describe('tracker frame defaults and size', () => {
  it('creates a 720 x 480 frame that shows all issues, and accepts the 360 x 280 minimum', () => {
    expect(TRACKER_FRAME_DEFAULT_SIZE).toEqual({ w: 720, h: 480 });
    expect(TRACKER_FRAME_MIN_SIZE).toEqual({ w: 360, h: 280 });
    const store = new Store(new Y.Doc());
    const frame = createTrackerFrame(store, { x: 0, y: 0 })!;
    expect(frame).toMatchObject({ w: 720, h: 480, view: 'all' });
    store.transact(() => store.update(frame.id, { w: 100, h: 100 }));
    expect(store.get(frame.id)).toMatchObject({ w: 360, h: 280 });
    expect(safeObj({ ...frame, w: 360, h: 280 } as unknown as BaseObj)).toMatchObject({ w: 360, h: 280 });
    expect(safeObj({ ...frame, w: 900, h: 600 } as unknown as BaseObj)).toMatchObject({ w: 900, h: 600 });
  });
});

describe('live presentation rule', () => {
  it('is live at zoom 0.4 and above with an on-screen height of 240, not on a phone', () => {
    expect(trackerPresentation(0.39, 720, 480 * 0.39)).toBe('snapshot');
    expect(trackerPresentation(0.39, 720, 480)).toBe('snapshot'); // below the zoom floor, even on a full 480 px frame
    expect(trackerPresentation(0.55, 720, 480)).toBe('work'); // 264 px tall on screen
    expect(trackerPresentation(0.4, 720 * 0.4, 480 * 0.4)).toBe('snapshot'); // 192 px tall
    expect(trackerPresentation(0.4, 720 * 0.4, 600 * 0.4)).toBe('work'); // exactly 240 px tall
    expect(trackerPresentation(1, 720, 239)).toBe('snapshot');
    expect(trackerPresentation(1, 720, 240)).toBe('work');
    expect(trackerPresentation(1, 720, 480, true)).toBe('snapshot');
    expect(trackerPresentation(2, 1440, 960)).toBe('work');
  });
});

describe('live set', () => {
  const viewport = { x: 0, y: 0, w: 1000, h: 800 };
  const frame = (id: string, x: number, extra: Partial<LiveCandidate> = {}): LiveCandidate => ({
    id, rect: { x, y: 100, w: 300, h: 300 }, eligible: true, selected: false, hovered: false, ...extra,
  });

  it('ranks selected first, then hovered, then the largest visible area', () => {
    const frames = [
      frame('small', 950),                    // 50 x 300 visible
      frame('big', 0),                        // 300 x 300 visible
      frame('mid', 500),                      // 300 x 300 visible, same area as big: id decides
      frame('hover', 700, { hovered: true }), // 300 x 300 visible but hovered
      frame('sel', 800, { selected: true }),
    ];
    expect([...pickLive(frames, viewport, 10)]).toEqual(['sel', 'hover', 'big', 'mid', 'small']);
  });

  it('keeps at most the cap, and never a frame that is entirely off screen or not eligible', () => {
    expect(LIVE_CAP).toBe(3);
    const frames = [frame('a', 0), frame('b', 100), frame('c', 200), frame('d', 300), frame('off', 2000), frame('zoomed', 400, { eligible: false, selected: true })];
    const live = pickLive(frames, viewport, LIVE_CAP);
    expect(live.size).toBe(3);
    expect(live.has('zoomed')).toBe(false);
    expect(live.has('off')).toBe(false);
    expect([...live]).toEqual(['a', 'b', 'c']);
  });

  it('holds a shell out of the live set for 500 ms before destroying it, and resets when it comes back', () => {
    expect(LIVE_HOLD_MS).toBe(500);
    expect(holdAfter(null, true, 1000)).toEqual({ leftAt: null, destroy: false });
    const left = holdAfter(null, false, 1000);
    expect(left).toEqual({ leftAt: 1000, destroy: false });
    expect(holdAfter(left.leftAt, false, 1499).destroy).toBe(false);
    expect(holdAfter(left.leftAt, false, 1500).destroy).toBe(true);
    expect(holdAfter(left.leftAt, true, 1200)).toEqual({ leftAt: null, destroy: false });
    expect(holdAfter(null, false, 1600)).toEqual({ leftAt: 1600, destroy: false });
  });
});

describe('tracker frame object', () => {
  it('survives a Yjs round trip with navigation fields and uses the default frame size', () => {
    const store = new Store(new Y.Doc());
    const frame = createTrackerFrame(store, { x: 24, y: 48 })!;
    expect(frame).toMatchObject({
      type: 'tracker', x: 24, y: 48, ...TRACKER_FRAME_DEFAULT_SIZE, rotation: 0, view: 'all',
    });
    expect(frame.trackerId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const copyDoc = new Y.Doc();
    Y.applyUpdate(copyDoc, Y.encodeStateAsUpdate(store.doc));
    const copy = new Store(copyDoc).get(frame.id);
    expect(copy).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'all',
    });
  });

  it('validates navigation fields and ignores invalid strings', () => {
    const safe = safeObj({
      id: 'tracker', type: 'tracker', x: 0, y: 0, w: 300, h: 200, rotation: 1, z: 'a0',
      trackerId: 'x'.repeat(65), view: 'milestones', viewId: 'view with spaces', focusKey: 'TAB/12',
    } as unknown as BaseObj);
    expect(safe).not.toHaveProperty('trackerId');
    expect(safe).not.toHaveProperty('view');
    expect(safe).not.toHaveProperty('viewId');
    expect(safe).not.toHaveProperty('focusKey');
    expect(safe).toMatchObject({ w: 360, h: 280, rotation: 0 });
  });

  it('writes the tracker feature marker atomically and makes later frames share the workspace tracker', () => {
    const store = new Store(new Y.Doc());
    let objectTransaction: Y.Transaction | undefined;
    let metaTransaction: Y.Transaction | undefined;
    store.objects.observe((event) => { objectTransaction = event.transaction; });
    store.meta.observe((event) => { metaTransaction = event.transaction; });

    const first = createTrackerFrame(store, { x: 0, y: 0 })!;
    expect(objectTransaction).toBe(metaTransaction);
    expect(store.meta.get('feature:tracker')).toBe(true);
    expect(store.unsupportedFeatures()).toEqual([]);

    const second = createTrackerFrame(store, { x: 1400, y: 0 })!;
    expect(second.id).not.toBe(first.id);
    expect(second.trackerId).toBe(first.trackerId);
    const pasted = remapObjects([first], new Map([[first.id, 'pasted']]), { x: 40, y: 40 }, () => null)[0] as BaseObj;
    store.transact(() => store.create(pasted));
    expect(store.get('pasted')).toMatchObject({ type: 'tracker', trackerId: first.trackerId, view: 'all' });
  });

  it('keeps old clients read-only when they encounter the tracker marker', () => {
    const store = new Store(new Y.Doc());
    const featuresKnownByOldClient = new Set(['containers']);
    const applyOldGate = () => {
      const unknown = featuresOf(store.meta.toJSON()).some((feature) => !featuresKnownByOldClient.has(feature));
      store.setReadOnly(boardAccess('owner', null, false, unknown).storeReadOnly);
    };
    store.meta.observe(applyOldGate);
    applyOldGate();
    expect(store.readOnly).toBe(false);

    createTrackerFrame(store, { x: 0, y: 0 });
    expect(store.readOnly).toBe(true);
  });

  it('restores navigation-state changes and remains resizable without a rotation handle', () => {
    const live = new Store(new Y.Doc());
    const snap = new Store(new Y.Doc());
    const base = {
      id: 'tracker', type: 'tracker', x: 0, y: 0, w: 1280, h: 800, rotation: 0, z: 'a0', trackerId: 'workspace',
    } as BaseObj;
    live.transact(() => live.create({ ...base, view: 'inbox', focusKey: 'TAB-1' }));
    snap.transact(() => snap.create({ ...base, view: 'my', viewId: 'saved', focusKey: 'TAB-2' }));
    const plan = planRestore(live, snap, { isHidden: () => false });
    expect(plan.summary.changed).toBe(1);
    expect(plan.change[0].set).toMatchObject({ view: 'my', viewId: 'saved', focusKey: 'TAB-2' });
    applyRestore(live, plan);
    expect(live.get('tracker')).toMatchObject({ view: 'my', viewId: 'saved', focusKey: 'TAB-2' });

    live.transact(() => live.update('tracker', { w: 100, h: 100, rotation: 0.5 }));
    expect(live.get('tracker')).toMatchObject({ w: 360, h: 280, rotation: 0 });
    const handles = handlesFor(live.get('tracker')!, () => undefined, 1).map((handle) => handle.id);
    expect(handles).toContain('se');
    expect(handles).not.toContain('rot');
  });

  it('exports a static placeholder and carries navigation fields in JSON and .drift files', async () => {
    const store = new Store(new Y.Doc());
    const frame = createTrackerFrame(store, { x: 0, y: 0 })!;
    store.transact(() => store.update(frame.id, { focusKey: 'TAB-42', view: 'all', viewId: 'saved-view' }));
    const app = trackerApp(store);

    const svg = exportSvg(app as never).svg;
    expect(svg).toContain('Tracker');
    expect(svg).toContain('Sign in to a workspace to see tickets.');
    expect(svg).not.toContain('TAB-42');
    expect(objectMarkup(frame, { get: () => undefined })).toContain('stroke-width="1"');

    expect(toJson(app as never, [frame.id], []).objects[0]).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
    const archive = unzipSync(await toDrift(app as never));
    const board = JSON.parse(strFromU8(archive['board.json'])) as { objects: BaseObj[] };
    expect(board.objects[0]).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
    const restored = new Store(new Y.Doc());
    Y.applyUpdate(restored.doc, archive['doc.yjs']);
    expect(restored.get(frame.id)).toMatchObject({
      trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
  });
});
