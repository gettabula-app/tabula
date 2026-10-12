import { describe, expect, it } from 'vitest';
import { createPresenceStore, type PresenceSource } from '../src/presence';
import { initialOf, presenceView, spoken, squareColour, MAX_SQUARES, type PresenceSummary, type PresenceUser } from '../src/ui/presence-logic';
import { PERSON_INK, USER_COLORS, luminance } from '../src/palette';

// "Here now" on the Boards rows (proto/designer-preview/presence/SPEC.md): the view rules and the store's debounce and pause.

const u = (userId: string, name: string, joinedAt: number, colour?: string, guest?: boolean): PresenceUser => ({ userId, name, joinedAt, colour, guest });
const sum = (people: PresenceUser[], over: Partial<PresenceSummary> = {}): PresenceSummary => ({ boardId: 'b1', count: people.length, people, ...over });

describe('presenceView', () => {
  it('is nothing when nobody else is on the board, even if the viewer is', () => {
    expect(presenceView(null)).toBeNull();
    expect(presenceView(sum([]))).toBeNull();
    expect(presenceView(sum([], { me: true }))).toBeNull();
  });

  it('lists people by arrival, a newcomer last, and says it in words', () => {
    const view = presenceView(sum([u('b', 'Ben', 5), u('a', 'Ana', 2)]))!;
    expect(view.squares.map((s) => s.name)).toEqual(['Ana', 'Ben']);
    expect([view.you, view.more, view.label, view.names]).toEqual([false, 0, 'Ana and Ben are here now', 'Ana and Ben']);
    expect(presenceView(sum([u('b', 'Ben', 5)]))!.label).toBe('Ben is here now');
  });

  it('shows "You" after the others only when the server says the viewer is on the board too', () => {
    const view = presenceView(sum([u('l', 'Lin', 2)], { me: true }))!;
    expect([view.you, view.label]).toEqual([true, 'Lin and you are here now']);
    expect(presenceView(sum([u('l', 'Lin', 2)], { me: false }))!.you).toBe(false);
  });

  it('caps the squares at three with the viewer counted, then +N from the count', () => {
    const people = ['a', 'b', 'c', 'd', 'e'].map((id, i) => u(id, id.toUpperCase(), i + 1));
    const without = presenceView(sum(people))!;
    expect([without.squares.length, without.more]).toEqual([MAX_SQUARES, 2]);
    expect(without.label).toBe('A, B and 3 more are here now');
    const withMe = presenceView(sum(people, { me: true }))!;
    expect([withMe.squares.length, withMe.you, withMe.more]).toEqual([MAX_SQUARES - 1, true, 3]);
    expect(withMe.label).toBe('A, B and 4 more are here now');
    expect(withMe.all.map((s) => s.name)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('uses the count, not the list, when the server named only eight', () => {
    const eight = Array.from({ length: 8 }, (_, i) => u(`p${i}`, `P${i}`, i));
    const view = presenceView(sum(eight, { count: 11 }))!;
    expect([view.squares.length, view.more, view.unnamed]).toEqual([3, 8, 3]);
    expect(view.label).toBe('P0, P1 and 9 more are here now');
  });

  it('spells the phone text: up to three names, else two and a count', () => {
    expect(spoken(['A'])).toBe('A');
    expect(spoken(['A', 'B', 'you'])).toBe('A, B and you');
    expect(spoken(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });

  it('counts a person on two tabs once, marks guests, and survives a missing name', () => {
    const view = presenceView(sum([u('a', 'Ana', 9), u('a', 'Ana', 3), u('z', '  ', 4, undefined, true)], { count: 2 }))!;
    expect(view.all.map((s) => [s.name, s.initial, s.guest])).toEqual([['Ana', 'A', false], ['Someone', 'S', true]]);
  });

  it('takes the first letter of the name as it is written', () => {
    expect([initialOf('élan'), initialOf('  mia'), initialOf('👩‍🎤 Zo'), initialOf('')]).toEqual(['É', 'M', '👩', '?']);
  });
});

describe('square colours', () => {
  it.each(USER_COLORS)('%s carries white text at 4.5:1 or more', (c) => {
    expect((luminance(PERSON_INK) + 0.05) / (luminance(c) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('maps old and unknown person colours to the palette and leaves a missing one to the ink', () => {
    expect(squareColour('#2F6FED')).toBe(USER_COLORS[0]);
    expect(USER_COLORS).toContain(squareColour('#123456')!);
    for (const none of [undefined, null, '', 'blue', 42]) expect(squareColour(none)).toBeNull();
  });
});

function harness() {
  const timers: { fn: () => void; at: number }[] = [];
  let t = 0;
  let hidden = false;
  let visible: () => void = () => {};
  const store = createPresenceStore({
    leaveMs: 3000,
    hidden: () => hidden,
    onVisible: (apply) => { visible = apply; return () => { visible = () => {}; }; },
    setTimer: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    store,
    advance(ms: number) { t += ms; for (const timer of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } },
    hide() { hidden = true; },
    show() { hidden = false; visible(); },
    pending: () => timers.length,
  };
}

const names = (s: PresenceSummary | null) => s?.people.map((p) => p.name) ?? [];

describe('presence store', () => {
  it('shows a growth at once and a shrink after three seconds, unless the person comes back', () => {
    const { store, advance } = harness();
    let redraws = 0;
    store.watch('b1', () => { redraws++; });
    store.set('b1', sum([u('a', 'Ana', 1)]));
    expect(names(store.get('b1'))).toEqual(['Ana']);
    store.set('b1', sum([]));
    advance(2999);
    expect(names(store.get('b1'))).toEqual(['Ana']);
    store.set('b1', sum([u('a', 'Ana', 1)])); // a reload: back within the window
    advance(10_000);
    expect(names(store.get('b1'))).toEqual(['Ana']);
    store.set('b1', sum([]));
    advance(3000);
    expect(store.get('b1')?.count).toBe(0);
    expect(redraws).toBe(2);
  });

  it('applies the latest summary when a held shrink runs out, and lets a growth cut it short', () => {
    const { store, advance } = harness();
    store.set('b1', sum([u('a', 'Ana', 1), u('b', 'Ben', 2), u('c', 'Cy', 3)]));
    store.set('b1', sum([u('a', 'Ana', 1), u('b', 'Ben', 2)]));
    store.set('b1', sum([u('a', 'Ana', 1)]));
    expect(names(store.get('b1'))).toEqual(['Ana', 'Ben', 'Cy']);
    advance(3000);
    expect(names(store.get('b1'))).toEqual(['Ana']);
    store.set('b1', sum([u('a', 'Ana', 1), u('d', 'Di', 4)]));
    expect(names(store.get('b1'))).toEqual(['Ana', 'Di']);
  });

  it('waits while the page is hidden and catches up, latest value only, when it is visible', () => {
    const { store, hide, show } = harness();
    store.connect({ subscribe: () => () => {} }); // the feed is what listens for the page becoming visible
    store.set('b1', sum([u('a', 'Ana', 1)]));
    hide();
    store.set('b1', sum([u('a', 'Ana', 1), u('b', 'Ben', 2)]));
    store.set('b1', sum([u('a', 'Ana', 1), u('b', 'Ben', 2), u('c', 'Cy', 3)]));
    expect(names(store.get('b1'))).toEqual(['Ana']); // nothing drawn while hidden
    show();
    expect(names(store.get('b1'))).toEqual(['Ana', 'Ben', 'Cy']);
  });

  it('replaces everything on a snapshot: boards it leaves out have nobody else', () => {
    const { store, advance } = harness();
    store.set('b1', sum([u('a', 'Ana', 1)]));
    store.set('b2', sum([u('a', 'Ana', 1)], { boardId: 'b2' }));
    store.replaceAll([sum([u('a', 'Ana', 1)], { boardId: 'b2' })]);
    advance(3000);
    expect(store.get('b1')).toBeNull();
    expect(names(store.get('b2'))).toEqual(['Ana']);
  });

  it('stops redraws for a watcher that unwatched, and drops timers when the feed stops', () => {
    const { store, pending } = harness();
    let n = 0;
    const off = store.watch('b1', () => { n++; });
    store.set('b1', sum([u('a', 'Ana', 1)]));
    off();
    store.set('b1', sum([u('a', 'Ana', 1), u('b', 'Ben', 2)]));
    expect(n).toBe(1);
    let push: (id: string, s: PresenceSummary | null) => void = () => {};
    const source: PresenceSource = { subscribe: (p) => { push = p; return () => {}; } };
    const stop = store.connect(source);
    push('b1', null);
    expect(pending()).toBe(1);
    stop();
    expect(pending()).toBe(0);
  });
});
