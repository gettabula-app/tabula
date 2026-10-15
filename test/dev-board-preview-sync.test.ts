import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Obj } from '../src/types';
import {
  PREVIEW_COOLDOWN_MS, PREVIEW_MAX_WAIT_MS, PREVIEW_QUIET_MS, previewModeSetting, watchBoardPreview,
} from '../src/ui/dev-board-preview-sync';

// The picture of a board is kept up to date while an editor works (src/ui/dev-board-preview-sync.ts). A manual clock runs the timers: each
// test moves time forward and sees what was sent. Every request must be same-origin (a relative address), and the picture is drawn from
// the objects the server sent for everyone's view, never from a store.

const SOURCE: Obj[] = [{ id: 'a', type: 'sticky', text: 'hi', fill: '#FFE16B', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a' } as Obj];

/** Lets the pending promise chains of a picture (several awaited steps) run to their end before the next check. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A clock and its timers: `run(ms)` moves time on and fires what is due, in order. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    async run(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch that answers the preview source with SOURCE, takes uploads (with `put` as their status), and fails the test on a foreign address. */
function server(put: (n: number) => Response | Error = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  let uploads = 0;
  const fn = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/') || url.startsWith('//')) throw new Error(`a request left this origin: ${url}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
    if (url.endsWith('/preview-source')) return new Response(JSON.stringify({ objects: SOURCE, revealed: false }), { status: 200 });
    if (url.endsWith('/preview')) {
      uploads += 1;
      const answer = put(uploads);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return new Response(null, { status: 404 });
  });
  return { fn, calls, uploads: () => calls.filter((c) => c.method === 'PUT') };
}

const blob = new Blob([new Uint8Array(12)], { type: 'image/webp' });

function harness(overrides: { put?: (n: number) => Response | Error; mode?: 'export' | 'blocks'; picture?: (...a: unknown[]) => string } = {}) {
  const t = clock();
  const net = server(overrides.put);
  const picture = vi.fn<(...args: unknown[]) => string>(overrides.picture ?? (() => '<svg/>'));
  const watch = watchBoardPreview('board-1', {
    fetch: net.fn as unknown as typeof fetch,
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    mode: () => overrides.mode ?? 'export',
    picture: picture as never,
    rasterize: async () => blob,
  });
  return { t, net, watch, picture };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when a picture is drawn', () => {
  it('three seconds after the last change, not before', async () => {
    const { t, net, watch } = harness();
    watch.touch();
    await t.run(PREVIEW_QUIET_MS - 1);
    expect(net.calls).toHaveLength(0);
    await t.run(1);
    expect(net.calls.map((c) => c.url)).toEqual(['/api/boards/board-1/preview-source', '/api/boards/board-1/preview']);
  });

  it('a long edit still shows up: at most ten seconds after its first change, then at most one picture per ten seconds', async () => {
    const { t, net, watch } = harness();
    for (let i = 0; i < 30; i++) {
      watch.touch();
      await t.run(1000);
    }
    const uploads = net.uploads().length;
    expect(uploads).toBeGreaterThanOrEqual(2);
    expect(uploads).toBeLessThanOrEqual(4);
    // each upload waited for the cooldown: no two uploads closer than the server allows
    const times: number[] = [];
    const orig = net.fn.getMockImplementation()!;
    net.fn.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/preview') && init?.method === 'PUT') times.push(t.now());
      return orig(input, init);
    });
    for (let i = 0; i < 40; i++) {
      watch.touch();
      await t.run(1000);
    }
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PREVIEW_COOLDOWN_MS);
    expect(PREVIEW_MAX_WAIT_MS).toBe(10000);
  });

  it('leaving the board draws one picture, after the cooldown, and listens to nothing afterwards', async () => {
    const { t, net, watch } = harness();
    watch.leave();
    await t.run(0);
    expect(net.uploads()).toHaveLength(1);
    watch.touch();
    await t.run(60_000);
    expect(net.uploads()).toHaveLength(1);
  });

  it('an empty board keeps no picture: nothing is drawn or uploaded, so its card shows the quiet tile', async () => {
    const t = clock();
    const net = server();
    net.fn.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      net.calls.push({ url, method: init?.method ?? 'GET', headers: {}, body: init?.body });
      if (url.endsWith('/preview-source')) return new Response(JSON.stringify({ objects: [], revealed: false }), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const picture = vi.fn<(...args: unknown[]) => string>(() => '<svg/>');
    const watch = watchBoardPreview('board-1', {
      fetch: net.fn as unknown as typeof fetch, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, mode: () => 'export', picture: picture as never, rasterize: async () => blob,
    });
    watch.leave();
    await t.run(60_000);
    expect(picture).not.toHaveBeenCalled();
    expect(net.uploads()).toHaveLength(0);
  });

  it('a second picture waits for the cooldown since the first upload', async () => {
    const { t, net, watch } = harness();
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.uploads()).toHaveLength(1);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.uploads()).toHaveLength(1);
    await t.run(PREVIEW_COOLDOWN_MS);
    expect(net.uploads()).toHaveLength(2);
  });

  it('draws the picture of what the server sent, in the mode the switch names', async () => {
    const { t, net, watch, picture } = harness({ mode: 'blocks' });
    watch.leave();
    await t.run(0);
    expect(picture).toHaveBeenCalledTimes(1);
    expect(picture.mock.calls[0]![0]).toEqual(SOURCE);
    expect(picture.mock.calls[0]![2]).toBe('blocks');
    expect(net.uploads()[0]!.headers).toEqual({ 'content-type': 'image/webp', 'x-tabula': '1' });
    expect(net.uploads()[0]!.body).toBe(blob);
  });

  it('every request is same-origin and the upload is the image itself (its length is set by the browser)', async () => {
    const { t, net, watch } = harness();
    watch.leave();
    await t.run(0);
    expect(net.calls.every((c) => c.url.startsWith('/api/boards/board-1/'))).toBe(true);
    expect(net.uploads()[0]!.body).toBe(blob);
  });
});

describe('a refusal is answered quietly', () => {
  it('a 429 on the upload waits for the server\'s retry-after, and tries again then', async () => {
    const { t, net, watch } = harness({ put: (n) => (n === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '7' } }) : new Response(null, { status: 204 })) });
    watch.leave();
    await t.run(0);
    expect(net.uploads()).toHaveLength(1);
    // the wait is the longer of the server's retry-after (7 s) and the ten seconds since the refused upload
    await t.run(9000);
    expect(net.uploads()).toHaveLength(1);
    await t.run(1000);
    expect(net.uploads()).toHaveLength(2);
  });

  it('a network failure does not stop the next change from drawing a picture', async () => {
    const { t, net, watch } = harness({ put: (n) => (n === 1 ? new Error('offline') : new Response(null, { status: 204 })) });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.uploads()).toHaveLength(1);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS + PREVIEW_COOLDOWN_MS);
    expect(net.uploads()).toHaveLength(2);
  });

  it('a board the person may not read any more is simply left alone', async () => {
    const t = clock();
    const fn = vi.fn<() => Promise<Response>>(async () => new Response(null, { status: 403 }));
    const watch = watchBoardPreview('board-1', {
      fetch: fn as unknown as typeof fetch, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, mode: () => 'export', picture: (() => '<svg/>') as never, rasterize: async () => blob,
    });
    watch.leave();
    await t.run(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('the dev switch', () => {
  it('is the export unless localStorage names the blocks; unreadable storage is the export too', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(previewModeSetting()).toBe('export');
    vi.stubGlobal('localStorage', { getItem: () => 'blocks' });
    expect(previewModeSetting()).toBe('blocks');
    vi.stubGlobal('localStorage', { getItem: () => 'export' });
    expect(previewModeSetting()).toBe('export');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(previewModeSetting()).toBe('export');
  });
});
