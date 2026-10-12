import { describe, expect, it, vi } from 'vitest';
import { POLL_MS, applyPresenceFrame, createPresenceFeed, parseList, parseSummary } from '../src/presence-feed';
import { createPresenceStore } from '../src/presence';

// The Boards page's "Here now" feed: what it accepts from the server, the socket path, and the poll fallback.

const person = (userId: string, name: string, joinedAt = 1) => ({ userId, name, colour: '#326DD3', joinedAt });

describe('what the server sends', () => {
  it('keeps what the row draws, caps the names at eight and falls back to the list length for a missing count', () => {
    const many = Array.from({ length: 12 }, (_, i) => person(`p${i}`, `P${i}`, i));
    expect(parseSummary({ boardId: 'b', count: 12, people: many, me: true, cursor: { x: 1 } })).toEqual({
      boardId: 'b', count: 12, me: true, people: many.slice(0, 8).map((p) => ({ ...p })),
    });
    expect(parseSummary({ boardId: 'b', people: [person('a', 'Ana')] })?.count).toBe(1);
  });

  it('drops what is not a summary or a person, and takes a guest flag only when it is true', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary({ people: [] })).toBeNull();
    expect(parseSummary({ boardId: 'b', count: -3, people: [null, { name: 'x' }, { userId: 'g', name: 'Gus', joinedAt: 2, guest: 'yes' }] })).toEqual({
      boardId: 'b', count: 0, people: [{ userId: 'g', name: 'Gus', colour: null, joinedAt: 2 }],
    });
    expect(parseList('nope')).toEqual([]);
  });
});

describe('socket frames', () => {
  const frames = () => {
    const store = createPresenceStore({ hidden: () => false, leaveMs: 0, setTimer: (fn) => { fn(); return 0; }, clearTimer: () => {} });
    return { store, apply: (f: Record<string, unknown>) => applyPresenceFrame(store, f) };
  };
  const ana = { boardId: 'b1', count: 1, people: [person('a', 'Ana')] };

  it('applies a snapshot, an update and a clear', () => {
    const { store, apply } = frames();
    expect(apply({ t: 'presence.snapshot', boards: [ana, { ...ana, boardId: 'b2' }] })).toBe(true);
    expect([store.get('b1')?.count, store.get('b2')?.count]).toEqual([1, 1]);
    apply({ t: 'presence.update', board: { ...ana, count: 2, people: [person('a', 'Ana'), person('b', 'Ben', 2)] } });
    expect(store.get('b1')?.count).toBe(2);
    apply({ t: 'presence.clear', boardId: 'b1' });
    expect(store.get('b1')).toBeNull();
    apply({ t: 'presence.snapshot', boards: [] }); // a reconnect: nobody is anywhere
    expect(store.get('b2')).toBeNull();
  });

  it('ignores frames it does not understand', () => {
    const { apply } = frames();
    expect(apply({ t: 'unread' })).toBe(false);
    expect(apply({ t: 'presence.update', board: 'x' })).toBe(false);
    expect(apply({ t: 'presence.clear' })).toBe(false);
  });
});

function feedHarness(over: { chatOn: boolean; hidden?: boolean; alive?: boolean; fail?: boolean }) {
  const store = createPresenceStore({ hidden: () => false });
  const state = { hidden: over.hidden ?? false, alive: over.alive ?? true, tick: () => {}, cleared: 0 };
  const fetchList = vi.fn<() => Promise<unknown[]>>(async () => {
    if (over.fail) throw new Error('404');
    return [{ boardId: 'b1', count: 1, people: [person('a', 'Ana')] }];
  });
  let frame: (f: Record<string, unknown>) => void = () => {};
  const watched: boolean[] = [];
  let shown: () => void = () => {};
  const keepSocket = vi.fn<(signal: AbortSignal) => void>();
  const source = createPresenceFeed({
    store, alive: () => state.alive, chatOn: over.chatOn, fetchList, keepSocket,
    watch: (on) => watched.push(on),
    onVisibility: (fn) => { shown = fn; return () => { shown = () => {}; }; },
    onFrame: (fn) => { frame = fn; return () => { state.cleared++; }; },
    hidden: () => state.hidden,
    setTimer: (fn, ms) => { expect(ms).toBe(POLL_MS); state.tick = fn; return 1; },
    clearTimer: () => { state.tick = () => {}; },
  });
  return { store, source, state, fetchList, keepSocket, watched, visibility: () => shown(), frame: (f: Record<string, unknown>) => frame(f) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the feed', () => {
  it('fetches the first value, then takes changes from the socket, and keeps the socket up', async () => {
    const h = feedHarness({ chatOn: true });
    const stop = h.source.subscribe(() => {});
    await settle();
    expect(h.store.get('b1')?.count).toBe(1);
    expect(h.keepSocket).toHaveBeenCalledTimes(1);
    h.frame({ t: 'presence.update', board: { boardId: 'b2', count: 1, people: [person('z', 'Zed')] } });
    expect(h.store.get('b2')?.count).toBe(1);
    expect(h.fetchList).toHaveBeenCalledTimes(1); // no polling beside the socket
    stop();
    expect(h.state.cleared).toBe(1);
  });

  it('tells the server to watch while the page is visible, stops while it is hidden, and refreshes on return', async () => {
    const h = feedHarness({ chatOn: true });
    const stop = h.source.subscribe(() => {});
    await settle();
    expect(h.watched).toEqual([true]);
    h.state.hidden = true;
    h.visibility();
    expect(h.watched).toEqual([true, false]);
    h.state.hidden = false;
    h.visibility();
    await settle();
    expect(h.watched).toEqual([true, false, true]);
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    stop();
    expect(h.watched.at(-1)).toBe(false);
  });

  it('does not ask the server for presence when chat is off', async () => {
    const h = feedHarness({ chatOn: false });
    const stop = h.source.subscribe(() => {});
    stop();
    expect(h.watched).toEqual([]);
  });

  it('polls while the page is visible when chat is off, and not while it is hidden', async () => {
    const h = feedHarness({ chatOn: false });
    const stop = h.source.subscribe(() => {});
    await settle();
    expect(h.fetchList).toHaveBeenCalledTimes(1);
    h.state.tick();
    await settle();
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    h.state.hidden = true;
    h.state.tick();
    await settle();
    expect(h.fetchList).toHaveBeenCalledTimes(2);
    expect(h.keepSocket).not.toHaveBeenCalled();
    stop();
  });

  it('keeps what the rows have when the endpoint fails, and stops once the list has left the page', async () => {
    const failing = feedHarness({ chatOn: false, fail: true });
    failing.store.set('b1', { boardId: 'b1', count: 1, people: [person('a', 'Ana')] });
    failing.source.subscribe(() => {});
    await settle();
    expect(failing.store.get('b1')?.count).toBe(1);

    const gone = feedHarness({ chatOn: true, alive: false });
    gone.source.subscribe(() => {});
    await settle();
    expect(gone.fetchList).not.toHaveBeenCalled();
    expect(gone.state.cleared).toBe(0); // it never registered a frame listener, so there is nothing to undo
  });
});
