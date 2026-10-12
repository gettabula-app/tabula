import { describe, expect, it } from 'vitest';
import { createPresenceStore, type PresenceSource } from '../src/presence';
import { initialOf, presenceView, spoken, squareColour, MAX_SQUARES, type PresenceUser } from '../src/ui/presence-logic';
import { PERSON_INK, USER_COLORS, luminance } from '../src/palette';

// "Here now" on the Boards rows (proto/designer-preview/presence/SPEC.md): the view rules and the store's debounce and pause.

const u = (userId: string, name: string, joinedAt: number, colour?: string): PresenceUser => ({ userId, name, joinedAt, colour });
const ME = 'me';

describe('presenceView', () => {
  it('is nothing when nobody else is on the board, whether or not the viewer is', () => {
    expect(presenceView([], ME)).toBeNull();
    expect(presenceView([u(ME, 'Me', 1)], ME)).toBeNull();
  });

  it('lists others by arrival, a newcomer last, and says it in words', () => {
    const view = presenceView([u('b', 'Ben', 5), u('a', 'Ana', 2)], ME)!;
    expect(view.squares.map((s) => s.name)).toEqual(['Ana', 'Ben']);
    expect([view.you, view.more, view.label, view.names]).toEqual([false, 0, 'Ana and Ben are here now', 'Ana and Ben']);
    expect(presenceView([u('b', 'Ben', 5)], ME)!.label).toBe('Ben is here now');
  });

  it('shows "You" after the others, only when the viewer is also on the board', () => {
    const view = presenceView([u(ME, 'Me', 1), u('l', 'Lin', 2)], ME)!;
    expect([view.you, view.label]).toEqual([true, 'Lin and you are here now']);
  });

  it('caps the squares at three with the viewer counted, then +N', () => {
    const people = ['a', 'b', 'c', 'd', 'e'].map((id, i) => u(id, id.toUpperCase(), i + 1));
    const without = presenceView(people, ME)!;
    expect([without.squares.length, without.more]).toEqual([MAX_SQUARES, 2]);
    expect(without.label).toBe('A, B and 3 more are here now');
    const withMe = presenceView([...people, u(ME, 'Me', 0)], ME)!;
    expect([withMe.squares.length, withMe.you, withMe.more]).toEqual([MAX_SQUARES - 1, true, 3]);
    expect(withMe.all.map((s) => s.name)).toEqual(['A', 'B', 'C', 'D', 'E']); // the hover list has everyone else
  });

  it('spells the phone text: up to three names, else two and a count', () => {
    expect(spoken(['A'])).toBe('A');
    expect(spoken(['A', 'B', 'you'])).toBe('A, B and you');
    expect(spoken(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });

  it('counts a person on two tabs once, and survives a missing name', () => {
    const view = presenceView([u('a', 'Ana', 9), u('a', 'Ana', 3), u('z', '  ', 4)], ME)!;
    expect(view.squares.map((s) => [s.name, s.initial])).toEqual([['Ana', 'A'], ['Someone', 'S']]);
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

describe('presence store', () => {
  it('shows an arrival at once and a departure after three seconds, unless the person comes back', () => {
    const { store, advance } = harness();
    let redraws = 0;
    store.watch('b1', () => { redraws++; });
    store.set('b1', [u('a', 'Ana', 1)]);
    expect(store.get('b1').map((x) => x.name)).toEqual(['Ana']);
    store.set('b1', []);
    advance(2999);
    expect(store.get('b1')).toHaveLength(1);
    store.set('b1', [u('a', 'Ana', 1)]); // a reload: back within the window
    advance(10_000);
    expect(store.get('b1')).toHaveLength(1);
    store.set('b1', []);
    advance(3000);
    expect(store.get('b1')).toEqual([]);
    expect(redraws).toBeGreaterThanOrEqual(4);
  });

  it('waits while the page is hidden and catches up, latest value only, when it is visible', () => {
    const { store, hide, show } = harness();
    store.connect({ subscribe: () => () => {} }); // the feed is what listens for the page becoming visible
    store.set('b1', [u('a', 'Ana', 1)]);
    hide();
    store.set('b1', [u('a', 'Ana', 1), u('b', 'Ben', 2)]);
    store.set('b1', [u('b', 'Ben', 2), u('c', 'Cy', 3)]);
    expect(store.get('b1').map((x) => x.name)).toEqual(['Ana']); // nothing drawn while hidden
    show();
    expect(store.get('b1').map((x) => x.name).sort()).toEqual(['Ana', 'Ben', 'Cy']); // Ana lingers for the leave window
  });

  it('stops redraws for a watcher that unwatched, and drops timers when the feed stops', () => {
    const { store, pending } = harness();
    let n = 0;
    const off = store.watch('b1', () => { n++; });
    store.set('b1', [u('a', 'Ana', 1)]);
    off();
    store.set('b1', [u('a', 'Ana', 1), u('b', 'Ben', 2)]);
    expect(n).toBe(1);
    let push: (id: string, users: PresenceUser[]) => void = () => {};
    const source: PresenceSource = { subscribe: (p) => { push = p; return () => {}; } };
    const stop = store.connect(source);
    push('b1', []);
    expect(pending()).toBe(2);
    stop();
    expect(pending()).toBe(0);
  });
});
