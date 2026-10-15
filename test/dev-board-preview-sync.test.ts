import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store';
import type { Obj } from '../src/types';
import { previewSvgFor } from '../src/preview-render';
import { PREVIEW_QUIET_MS, devPreviewWritesSettled, watchBoardPreview } from '../src/ui/dev-board-preview-sync';

// DEV ONLY (src/ui/dev-board-preview-sync.ts): the picture of a board is written three seconds after its last change, and when it is
// left, and never twice for the same picture. A store stands in for the board's: only cache, getFlow and onChange are read.

const sticky = (id: string, fill: string, extra: Record<string, unknown> = {}): Obj => ({
  id, type: 'sticky', x: 0, y: 0, w: 100, h: 100, rotation: 0, z: id, fill, ...extra,
} as Obj);

/** Paint order as the store gives it: frames first, then by z (src/store.ts ordered). */
const paintOrderOf = (list: Iterable<Obj>) => [...list].sort((a, b) => Number(b.type === 'frame') - Number(a.type === 'frame') || (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));

function fakeStore(objects: Obj[], flow = { reveal: false }) {
  const cache = new Map(objects.map((o) => [o.id, o]));
  const listeners = new Set<() => void>();
  const store = {
    cache,
    getFlow: () => flow,
    ordered: () => paintOrderOf(cache.values()),
    onChange: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  /** A change, as the store announces one: the object is replaced and the listeners run. */
  const change = (o: Obj) => {
    cache.set(o.id, o);
    listeners.forEach((l) => l());
  };
  return { store: store as unknown as Store, change, cache, listeners };
}

const puts = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('watchBoardPreview (dev)', () => {
  it('writes the picture 3 seconds after the last change, not before', async () => {
    const { store, change } = fakeStore([sticky('a', '#FFE066')]);
    const fetchMock = vi.mocked(fetch);
    watchBoardPreview(store, 'q4-roadmap');
    change(sticky('a', '#FFE066', { text: 'one' }));
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS - 1);
    expect(puts(fetchMock)).toHaveLength(0);
    change(sticky('a', '#FFE066', { text: 'two' }));
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS - 1);
    expect(puts(fetchMock)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts(fetchMock)).toHaveLength(1);
  });

  it('sends the picture of what everyone may see, as an SVG the relay takes', async () => {
    const { store, change } = fakeStore([sticky('a', '#FFE066')]);
    const fetchMock = vi.mocked(fetch);
    watchBoardPreview(store, 'q4-roadmap');
    change(sticky('b', '#B0C4DE', { privateStep: 'step-1' }));
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS);
    const [url, init] = puts(fetchMock)[0] as [string, RequestInit];
    expect(url).toBe('/api/dev/board-preview/q4-roadmap');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'content-type': 'image/svg+xml', 'x-tabula': '1' });
    const body = String(init.body);
    expect(body.startsWith('<svg')).toBe(true);
    expect(body).toContain('#FFE066');
    expect(body).not.toContain('#B0C4DE');
  });

  it('leaving the board writes at once when something changed, and stops listening', async () => {
    const { store, change, listeners } = fakeStore([sticky('a', '#FFE066')]);
    const fetchMock = vi.mocked(fetch);
    const leave = watchBoardPreview(store, 'q4-roadmap');
    change(sticky('a', '#FF0000'));
    leave();
    expect(puts(fetchMock)).toHaveLength(1);
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS * 2);
    expect(puts(fetchMock)).toHaveLength(1);
  });

  it('leaving a board nobody changed sends nothing', async () => {
    const { store } = fakeStore([sticky('a', '#FFE066')]);
    const fetchMock = vi.mocked(fetch);
    const leave = watchBoardPreview(store, 'q4-roadmap');
    leave();
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS * 2);
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('a change that leaves the picture as it was is not sent again', async () => {
    const { store, change } = fakeStore([sticky('a', '#FFE066')]);
    const fetchMock = vi.mocked(fetch);
    const leave = watchBoardPreview(store, 'q4-roadmap');
    change(sticky('a', '#FFE066', { text: 'reworded, same picture' }));
    await vi.advanceTimersByTimeAsync(PREVIEW_QUIET_MS);
    expect(puts(fetchMock)).toHaveLength(1);
    change(sticky('a', '#FFE066', { text: 'reworded again' }));
    leave();
    expect(puts(fetchMock)).toHaveLength(1);
  });

  it('a frame drawn around a note is drawn under it in the picture, whatever order they were made in', async () => {
    const note = sticky('note', '#FFE16B', { z: 'n' });
    const frame = { id: 'frame', type: 'frame', x: -40, y: -40, w: 320, h: 320, rotation: 0, z: 'f', fill: '#E4EFFF', name: 'Ideas' } as Obj;
    // the note was made first, so the store's cache lists it first; a picture in that order would put the frame over it
    const { store, change } = fakeStore([note, frame]);
    const fetchMock = vi.mocked(fetch);
    const leave = watchBoardPreview(store, 'q4-roadmap');
    change({ ...note, text: 'moved' } as Obj);
    leave();
    const body = String((puts(fetchMock)[0][1] as RequestInit).body);
    expect(body).toBe(previewSvgFor([frame, note], { reveal: false }));
    expect(body).not.toBe(previewSvgFor([note, frame], { reveal: false }));
  });

  it('a refused or failed write is answered, and nothing throws', async () => {
    const { store, change } = fakeStore([sticky('a', '#FFE066')]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('relay is down'); }));
    const leave = watchBoardPreview(store, 'q4-roadmap');
    change(sticky('a', '#FF0000'));
    leave();
    await expect(devPreviewWritesSettled()).resolves.toBeUndefined();
  });

  it('the Boards page waits for the pictures still on their way', async () => {
    const { store, change } = fakeStore([sticky('a', '#FFE066')]);
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = () => resolve({ ok: true, status: 204 }); })));
    const leave = watchBoardPreview(store, 'q4-roadmap');
    change(sticky('a', '#FF0000'));
    leave();
    let settled = false;
    void devPreviewWritesSettled().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});
