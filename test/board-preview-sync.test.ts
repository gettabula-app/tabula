import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Obj } from '../src/types';
import {
  mayKeepPreview, PREVIEW_BACKOFF_MS, PREVIEW_COOLDOWN_MS, PREVIEW_HIDDEN_MS, PREVIEW_QUIET_MS, previewVersionOf, watchBoardPreview, type PreviewAccess,
} from '../src/ui/board-preview-sync';

// The picture of a board is kept up to date while an owner or editor works (src/ui/board-preview-sync.ts, docs/board-previews.md). A manual
// clock runs the timers. Every request is same-origin, the picture is drawn from the objects the server sent for everyone's view, and each
// refusal is answered quietly: no loop, one retry only for a stale revision.

const OWNER: PreviewAccess = { enabled: true, role: 'owner' };
const EDITOR: PreviewAccess = { enabled: true, role: 'editor' };
const SOURCE: Obj[] = [{ id: 'a', type: 'sticky', text: 'hi', fill: '#FFE16B', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a' } as Obj];
const PNG = new Blob([new Uint8Array(12)], { type: 'image/png' });

/** Lets the pending promise chains of a picture run to their end before the next check. */
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

type Call = { url: string; method: string; headers: Record<string, string> };
const sourceAnswer = (rev: unknown) => new Response(JSON.stringify({ objects: SOURCE, revealed: false, rev }), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetch for the preview routes: `source(n)` and `put(n)` answer the n-th call, and a request that leaves this origin fails the test. */
function server(o: { source?: (n: number, rev: number) => Response | Error; put?: (n: number) => Response | Error; rev?: (n: number) => number } = {}) {
  const calls: Call[] = [];
  let sources = 0;
  let puts = 0;
  const fn = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/') || url.startsWith('//')) throw new Error(`a request left this origin: ${url}`);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/preview-source')) {
      sources += 1;
      const rev = o.rev ? o.rev(sources) : 7;
      const answer = o.source?.(sources, rev) ?? sourceAnswer(rev);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (url.endsWith('/preview') && method === 'PUT') {
      puts += 1;
      const answer = o.put?.(puts) ?? new Response(null, { status: 204 });
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return new Response(null, { status: 404 });
  });
  return {
    fn,
    calls,
    sources: () => calls.filter((c) => c.url.endsWith('/preview-source')).length,
    puts: () => calls.filter((c) => c.method === 'PUT'),
  };
}

function harness(o: {
  boardId?: string;
  access?: PreviewAccess;
  source?: (n: number, rev: number) => Response | Error;
  put?: (n: number) => Response | Error;
  rev?: (n: number) => number;
  rasterize?: () => Promise<Blob | null>;
  hidden?: () => number;
} = {}) {
  const t = clock();
  const net = server(o);
  const watch = watchBoardPreview(o.boardId ?? 'board-1', o.access ?? OWNER, {
    fetch: net.fn as unknown as typeof fetch,
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    hiddenForMs: o.hidden ?? (() => 0),
    picture: () => '<svg/>',
    rasterize: o.rasterize ?? (async () => PNG),
  });
  return { t, net, watch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('who may keep a picture', () => {
  it('owners and editors, while the server has board previews on; nobody else, and nothing when it is off', () => {
    expect([mayKeepPreview(OWNER), mayKeepPreview(EDITOR)]).toEqual([true, true]);
    expect(mayKeepPreview({ enabled: true, role: 'viewer' })).toBe(false);
    expect(mayKeepPreview({ enabled: true, role: 'commenter' })).toBe(false);
    expect(mayKeepPreview({ enabled: true, role: null })).toBe(false);
    expect(mayKeepPreview({ enabled: false, role: 'owner' })).toBe(false);
  });

  it('a viewer, or a board with previews off, makes no request at all, not even for the source', async () => {
    for (const access of [{ enabled: true, role: 'viewer' }, { enabled: false, role: 'owner' }] as PreviewAccess[]) {
      const { t, net, watch } = harness({ access });
      watch.touch();
      await t.run(PREVIEW_QUIET_MS * 2);
      watch.leave();
      await t.run(PREVIEW_QUIET_MS * 2);
      expect(net.calls).toEqual([]);
    }
  });
});

describe('the revision the picture is made from', () => {
  it('is sent back on the upload as x-preview-rev, digits only', async () => {
    const { t, net, watch } = harness({ rev: () => 42 });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    const [put] = net.puts();
    expect(put!.headers['x-preview-rev']).toBe('42');
  });

  it('a revision that is not a whole number of digits is not sent, and no picture is uploaded', async () => {
    for (const rev of ['7', -1, 1.5, 1e12, null]) {
      const { t, net, watch } = harness({ rev: () => rev as unknown as number });
      watch.touch();
      await t.run(PREVIEW_QUIET_MS);
      expect([rev, net.puts()]).toEqual([rev, []]);
    }
  });
});

describe('a stale revision (409 preview_stale)', () => {
  it('is asked again once: the source is fetched and drawn again, then the new revision is sent', async () => {
    const { t, net, watch } = harness({
      rev: (n) => (n === 1 ? 5 : 6),
      put: (n) => (n === 1 ? new Response('{"error":"preview_stale"}', { status: 409 }) : new Response(null, { status: 204 })),
    });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.sources()).toBe(2);
    expect(net.puts().map((p) => p.headers['x-preview-rev'])).toEqual(['5', '6']);
  });

  it('twice in a row: the page gives up, and waits for the next change or the next leave', async () => {
    const { t, net, watch } = harness({ put: () => new Response(null, { status: 409 }) });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.sources()).toBe(2);
    expect(net.puts()).toHaveLength(2);
    await t.run(PREVIEW_COOLDOWN_MS * 30);
    expect(net.sources()).toBe(2);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS + PREVIEW_COOLDOWN_MS);
    expect(net.sources()).toBe(4);
  });
});

describe('refusals are quiet, and never a loop', () => {
  it('a 503 on the upload is not retried at once: the board waits out the back-off, and no request is made meanwhile', async () => {
    const { t, net, watch } = harness({ put: () => new Response('{"error":"preview_unavailable"}', { status: 503 }) });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.puts()).toHaveLength(1);
    await t.run(PREVIEW_COOLDOWN_MS);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS + PREVIEW_COOLDOWN_MS);
    expect(net.calls).toHaveLength(2);
    await t.run(PREVIEW_BACKOFF_MS);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS + PREVIEW_COOLDOWN_MS);
    expect(net.puts()).toHaveLength(2);
  });

  it('a 404 on the source (off, or no picture) makes one request and is then left alone until the next change', async () => {
    const { t, net, watch } = harness({ source: () => new Response(null, { status: 404 }) });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.calls).toHaveLength(1);
    await t.run(PREVIEW_BACKOFF_MS);
    expect(net.calls).toHaveLength(1);
  });

  it('a 413 on the source, and a 429 with Retry-After, back off for the time asked and no longer', async () => {
    const big = harness({ source: () => new Response(null, { status: 413 }) });
    big.watch.touch();
    await big.t.run(PREVIEW_QUIET_MS);
    expect(big.net.sources()).toBe(1);

    const busy = harness({ source: () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }) });
    busy.watch.touch();
    await busy.t.run(PREVIEW_QUIET_MS);
    busy.watch.touch();
    await busy.t.run(PREVIEW_QUIET_MS + 60_000);
    expect(busy.net.sources()).toBe(1);
    await busy.t.run(120_000);
    busy.watch.touch();
    await busy.t.run(PREVIEW_QUIET_MS);
    expect(busy.net.sources()).toBe(2);
  });

  it('a network failure is answered quietly, and the board waits before it asks again', async () => {
    const { t, net, watch } = harness({ source: () => new TypeError('offline') });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS + PREVIEW_COOLDOWN_MS);
    expect(net.sources()).toBe(1);
  });

  it('a picture that cannot be encoded (Safari: no WebP, PNG too large) is not uploaded, and nothing throws', async () => {
    const { t, net, watch } = harness({ rasterize: async () => null });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.puts()).toEqual([]);
    expect(net.sources()).toBe(1);
  });

  it('an empty board keeps no picture and uploads nothing', async () => {
    const { t, net, watch } = harness({ source: () => new Response(JSON.stringify({ objects: [], rev: 9 }), { status: 200 }) });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.puts()).toEqual([]);
  });
});

describe('when the tab is hidden', () => {
  it('a tab hidden for more than a minute draws nothing when its timer fires', async () => {
    const { t, net, watch } = harness({ hidden: () => PREVIEW_HIDDEN_MS + 1 });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS * 2);
    expect(net.calls).toEqual([]);
  });

  it('a tab hidden for less than that still draws its picture', async () => {
    const { t, net, watch } = harness({ hidden: () => PREVIEW_HIDDEN_MS - 1 });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(net.puts()).toHaveLength(1);
  });
});

describe('the ordinary path', () => {
  it('draws three seconds after the last change, not before, and uploads WebP or PNG as the browser made it', async () => {
    const { t, net, watch } = harness();
    watch.touch();
    await t.run(PREVIEW_QUIET_MS - 1);
    expect(net.calls).toHaveLength(0);
    await t.run(1);
    expect(net.calls.map((c) => c.url)).toEqual(['/api/boards/board-1/preview-source', '/api/boards/board-1/preview']);
    expect(net.calls[1]!.headers['x-tabula']).toBe('1');
  });

  it('leaving the board draws the picture at once, and nothing more is listened for after it', async () => {
    const { t, net, watch } = harness();
    watch.touch();
    watch.leave();
    await t.run(0);
    watch.touch();
    await t.run(PREVIEW_QUIET_MS * 3);
    expect(net.puts()).toHaveLength(1);
  });
});

describe('a card version', () => {
  it('is the board edit, or the picture this page stored when that is later', async () => {
    expect(previewVersionOf('version-board', 100)).toBe(100);
    const { t, watch } = harness({ boardId: 'version-board' });
    watch.touch();
    await t.run(PREVIEW_QUIET_MS);
    expect(previewVersionOf('version-board', 1)).toBe(PREVIEW_QUIET_MS);
    expect(previewVersionOf('version-board', 5000)).toBe(5000);
  });
});
