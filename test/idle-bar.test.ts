import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTHING_HIDDEN, hideSession, hideShown, hidePoll, idleHiddenKey, idleShown, loadIdleHidden, parseIdleHidden,
  escapeHidesBar, reopenPollResults, reopenSession, saveIdleHidden, showPoll, showSession, type EscapeContext,
} from '../src/ui/idle-bar';

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
    items,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('idleHiddenKey', () => {
  it('uses the driftboard prefix, one key per person and board', () => {
    expect(idleHiddenKey('ana', 'board-1')).toBe('driftboard:idle-bar:ana:board-1');
  });
});

describe('parseIdleHidden', () => {
  it('hides nothing when nothing is stored', () => {
    expect(parseIdleHidden(null)).toEqual(NOTHING_HIDDEN);
  });

  it('reads both groups', () => {
    expect(parseIdleHidden('{"session":true,"poll":"p1"}')).toEqual({ session: true, poll: 'p1' });
  });

  it('treats damaged or wrongly typed values as hiding nothing', () => {
    expect(parseIdleHidden('not json')).toEqual(NOTHING_HIDDEN);
    expect(parseIdleHidden('[1,2]')).toEqual(NOTHING_HIDDEN);
    expect(parseIdleHidden('null')).toEqual(NOTHING_HIDDEN);
    expect(parseIdleHidden('{"session":"yes","poll":7}')).toEqual(NOTHING_HIDDEN);
    expect(parseIdleHidden('{"poll":""}')).toEqual(NOTHING_HIDDEN);
  });
});

describe('idleShown', () => {
  const closed = { hasSteps: true, latestClosedId: 'p2' };

  it('shows both groups when nothing is hidden', () => {
    expect(idleShown(NOTHING_HIDDEN, closed)).toEqual({ session: true, poll: true });
  });

  it('shows no session group without steps', () => {
    expect(idleShown(NOTHING_HIDDEN, { hasSteps: false, latestClosedId: null })).toEqual({ session: false, poll: false });
  });

  it('hides the session group once it is hidden', () => {
    expect(idleShown(hideSession(NOTHING_HIDDEN), closed)).toEqual({ session: false, poll: true });
  });

  it('hides the results of the poll that was hidden, and shows a newer one again', () => {
    const hidden = hidePoll(NOTHING_HIDDEN, 'p2');
    expect(idleShown(hidden, closed).poll).toBe(false);
    expect(idleShown(hidden, { hasSteps: true, latestClosedId: 'p3' }).poll).toBe(true);
  });
});

describe('hideShown', () => {
  it('hides only the groups that were on screen', () => {
    const shown = { session: false, poll: true };
    expect(hideShown(NOTHING_HIDDEN, shown, 'p2')).toEqual({ session: false, poll: 'p2' });
  });

  it('keeps a session group hidden that was already hidden', () => {
    const hidden = hideSession(NOTHING_HIDDEN);
    expect(hideShown(hidden, { session: false, poll: false }, null)).toEqual(hidden);
  });

  it('hides both groups together', () => {
    expect(hideShown(NOTHING_HIDDEN, { session: true, poll: true }, 'p2')).toEqual({ session: true, poll: 'p2' });
  });
});

describe('reopening', () => {
  it('showSession and showPoll clear only their own group', () => {
    const both = { session: true, poll: 'p1' };
    expect(showSession(both)).toEqual({ session: false, poll: 'p1' });
    expect(showPoll(both)).toEqual({ session: true, poll: null });
  });

  it('hidePoll and hideSession set only their own group', () => {
    expect(hidePoll(NOTHING_HIDDEN, 'p9')).toEqual({ session: false, poll: 'p9' });
    expect(hideSession(NOTHING_HIDDEN)).toEqual({ session: true, poll: null });
  });
});

describe('escapeHidesBar', () => {
  const free: EscapeContext = {
    selected: 0, tool: 'select', dragging: false, editing: false, threadOpen: false, typing: false, dialogOpen: false,
  };

  it('takes Esc when the board has nothing for it to do', () => {
    expect(escapeHidesBar(free)).toBe(true);
  });

  it('leaves Esc to the board while objects are selected', () => {
    expect(escapeHidesBar({ ...free, selected: 2 })).toBe(false);
  });

  it('leaves Esc to the board while a tool other than select is pending', () => {
    expect(escapeHidesBar({ ...free, tool: 'pen' })).toBe(false);
  });

  it('leaves Esc to the board during a drag or a text edit', () => {
    expect(escapeHidesBar({ ...free, dragging: true })).toBe(false);
    expect(escapeHidesBar({ ...free, editing: true })).toBe(false);
  });

  it('leaves Esc to an open comment', () => {
    expect(escapeHidesBar({ ...free, threadOpen: true })).toBe(false);
  });

  it('leaves Esc to a field or a dialog that has focus or is open', () => {
    expect(escapeHidesBar({ ...free, typing: true })).toBe(false);
    expect(escapeHidesBar({ ...free, dialogOpen: true })).toBe(false);
  });
});

describe('storage', () => {
  it('round-trips per person and board, and clears the key when nothing is hidden', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    saveIdleHidden('ana', 'board-1', { session: true, poll: 'p1' });
    expect(loadIdleHidden('ana', 'board-1')).toEqual({ session: true, poll: 'p1' });
    expect(loadIdleHidden('ben', 'board-1')).toEqual(NOTHING_HIDDEN);
    expect(loadIdleHidden('ana', 'board-2')).toEqual(NOTHING_HIDDEN);
    saveIdleHidden('ana', 'board-1', NOTHING_HIDDEN);
    expect(storage.items.size).toBe(0);
  });

  it('reopening a session or the poll tool clears only that group', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    saveIdleHidden('ana', 'board-1', { session: true, poll: 'p1' });
    reopenSession('ana', 'board-1');
    expect(loadIdleHidden('ana', 'board-1')).toEqual({ session: false, poll: 'p1' });
    reopenPollResults('ana', 'board-1');
    expect(loadIdleHidden('ana', 'board-1')).toEqual(NOTHING_HIDDEN);
  });

  it('hides nothing and does not throw when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(loadIdleHidden('ana', 'board-1')).toEqual(NOTHING_HIDDEN);
    expect(() => saveIdleHidden('ana', 'board-1', { session: true, poll: null })).not.toThrow();
  });
});
