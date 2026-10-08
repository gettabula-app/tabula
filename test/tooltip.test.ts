import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, TOOL_KEYS, shortcutKeys } from '../src/shortcuts';
import {
  COOL_DELAY, SHOW_DELAY, TIP_GAP, TIP_MARGIN, addToken, createTipController, placeTip, removeToken, tipContent,
  type Box, type Size, type TipOptions,
} from '../src/tooltip';

function rig(opts: TipOptions<string> = {}) {
  const log: string[] = [];
  const ctl = createTipController<string>({ show: (t) => log.push(`show ${t}`), hide: () => log.push('hide') }, opts);
  return { ctl, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tooltip delay', () => {
  it('opens after the delay and not before', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show a']);
    expect(ctl.current()).toBe('a');
  });

  it('never opens when the pointer leaves first', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY - 100);
    ctl.leave('a');
    vi.advanceTimersByTime(SHOW_DELAY * 2);
    expect(log).toEqual([]);
  });

  it('restarts the delay for a second target while cold', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(300);
    ctl.leave('a');
    ctl.enter('b');
    vi.advanceTimersByTime(SHOW_DELAY - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['show b']);
  });

  it('ignores repeated enters on the same target (moving between its children)', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(300);
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY - 300);
    expect(log).toEqual(['show a']);
    ctl.enter('a');
    expect(log).toEqual(['show a']);
  });

  it('never opens a target that is not live', () => {
    const { ctl, log } = rig({ live: (t) => t !== 'gone' });
    ctl.enter('gone');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.focus('gone');
    expect(log).toEqual([]);
    expect(ctl.current()).toBeNull();
  });
});

describe('tooltip warm group', () => {
  it('swaps at once from one target to the next while one is open', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.enter('b');
    expect(log).toEqual(['show a', 'show b']);
    expect(ctl.current()).toBe('b');
  });

  it('opens the next target at once when the pointer crosses the gap between two', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.leave('a');
    ctl.enter('b');
    expect(log).toEqual(['show a', 'hide', 'show b']);
  });

  it('stays warm for the cool-down after the tooltip closes, then goes cold', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.leave('a');
    vi.advanceTimersByTime(COOL_DELAY - 1);
    ctl.enter('b');
    expect(log).toEqual(['show a', 'hide', 'show b']);
    ctl.leave('b');
    vi.advanceTimersByTime(COOL_DELAY);
    log.length = 0;
    ctl.enter('c');
    expect(log).toEqual([]);
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual(['show c']);
  });

  it('counts the cool-down from the moment the tooltip closed, however long it was open', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY + 60_000);
    ctl.leave('a');
    ctl.enter('b');
    expect(log).toEqual(['show a', 'hide', 'show b']);
  });

  it('keeps the cool-down inside the 300 to 500 ms the design asks for', () => {
    expect(COOL_DELAY).toBeGreaterThanOrEqual(300);
    expect(COOL_DELAY).toBeLessThanOrEqual(500);
    expect(SHOW_DELAY).toBe(500);
  });
});

describe('tooltip focus', () => {
  it('opens at once on keyboard focus and closes on blur', () => {
    const { ctl, log } = rig();
    ctl.focus('a');
    expect(log).toEqual(['show a']);
    ctl.leave('a');
    expect(log).toEqual(['show a', 'hide']);
  });

  it('opens at once even when the pointer was still waiting on another target', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(100);
    ctl.focus('b');
    expect(log).toEqual(['show b']);
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual(['show b']);
  });

  it('moves from one focused target to the next without a pause', () => {
    const { ctl, log } = rig();
    ctl.focus('a');
    ctl.leave('a');
    ctl.focus('b');
    expect(log).toEqual(['show a', 'hide', 'show b']);
  });
});

describe('tooltip dismissal', () => {
  it('closes on Escape and leaves other keys alone', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(ctl.key('Enter')).toBe(false);
    expect(ctl.key('a')).toBe(false);
    expect(ctl.current()).toBe('a');
    expect(ctl.key('Escape')).toBe(true);
    expect(log).toEqual(['show a', 'hide']);
    expect(ctl.current()).toBeNull();
  });

  it('has nothing to do for Escape when no tooltip is open or waiting', () => {
    const { ctl } = rig();
    expect(ctl.key('Escape')).toBe(false);
  });

  it('cancels a waiting tooltip on Escape', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(100);
    expect(ctl.key('Escape')).toBe(true);
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual([]);
  });

  it('stays closed while the pointer stays on the target, and opens again after it leaves and returns', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.key('Escape');
    ctl.enter('a');
    ctl.focus('a');
    vi.advanceTimersByTime(SHOW_DELAY * 2);
    expect(log).toEqual(['show a', 'hide']);
    ctl.leave('a');
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual(['show a', 'hide', 'show a']);
  });

  it('goes cold after Escape: the next target waits the full delay', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    ctl.key('Escape');
    ctl.leave('a');
    ctl.enter('b');
    expect(log).toEqual(['show a', 'hide']);
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual(['show a', 'hide', 'show b']);
  });

  it('closes on a click, a scroll or a resize the same way (dismiss)', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(ctl.dismiss()).toBe(true);
    expect(ctl.dismiss()).toBe(false);
    ctl.enter('a');
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual(['show a', 'hide']);
  });

  it('dispose stops pending work', () => {
    const { ctl, log } = rig();
    ctl.enter('a');
    ctl.dispose();
    vi.advanceTimersByTime(SHOW_DELAY);
    expect(log).toEqual([]);
  });
});

describe('placeTip', () => {
  const view: Size = { width: 1000, height: 800 };
  const tip: Size = { width: 80, height: 24 };
  const at = (left: number, top: number, width = 40, height = 40): Box => ({ left, top, width, height });

  it('centres the tooltip above the target', () => {
    expect(placeTip(at(100, 200), tip, view)).toEqual({ left: 80, top: 200 - TIP_GAP - 24, side: 'above' });
  });

  it('flips below when there is no room above', () => {
    expect(placeTip(at(100, 10), tip, view)).toEqual({ left: 80, top: 10 + 40 + TIP_GAP, side: 'below' });
    // just enough room above keeps it above, one pixel less flips it
    const room = TIP_GAP + 24 + TIP_MARGIN;
    expect(placeTip(at(100, room), tip, view).side).toBe('above');
    expect(placeTip(at(100, room - 1), tip, view).side).toBe('below');
  });

  it('shifts sideways to keep the margin at both edges', () => {
    expect(placeTip(at(0, 200, 20), tip, view).left).toBe(TIP_MARGIN);
    expect(placeTip(at(980, 200, 20), tip, view).left).toBe(1000 - TIP_MARGIN - 80);
  });

  it('pins a tooltip wider than the viewport to the left margin', () => {
    expect(placeTip(at(100, 200), { width: 2000, height: 24 }, view).left).toBe(TIP_MARGIN);
  });

  it('takes the roomier side and never covers the target when neither side has room', () => {
    const small: Size = { width: 1000, height: 60 };
    const cases = [at(100, 20, 40, 20), at(100, 5, 40, 40), at(100, 30, 40, 20)];
    for (const target of cases) {
      const p = placeTip(target, tip, small);
      const covers = p.top < target.top + target.height && p.top + tip.height > target.top;
      expect(covers).toBe(false);
    }
    expect(placeTip(at(100, 5, 40, 40), tip, small).side).toBe('below');
  });

  it('keeps the gap and margin as arguments', () => {
    const p = placeTip(at(100, 200), tip, view, 2, 0);
    expect(p.top).toBe(200 - 2 - 24);
  });
});

describe('tipContent', () => {
  const keysOf = (id: string) => (id === 'mod+z' ? 'Ctrl/Cmd+Z' : undefined);

  it('uses data-tip, then aria-label', () => {
    expect(tipContent({ tip: 'Close', ariaLabel: 'Close comments', keyId: null }, keysOf)).toEqual({ label: 'Close' });
    expect(tipContent({ tip: null, ariaLabel: 'Close comments', keyId: null }, keysOf)).toEqual({ label: 'Close comments' });
  });

  it('says nothing for an empty label', () => {
    expect(tipContent({ tip: '', ariaLabel: 'Close', keyId: null }, keysOf)).toBeNull();
    expect(tipContent({ tip: '  ', ariaLabel: null, keyId: null }, keysOf)).toBeNull();
    expect(tipContent({ tip: null, ariaLabel: null, keyId: 'mod+z' }, keysOf)).toBeNull();
  });

  it('adds the key chip only for a key id the shortcuts table documents', () => {
    expect(tipContent({ tip: null, ariaLabel: 'Undo', keyId: 'mod+z' }, keysOf)).toEqual({ label: 'Undo', keys: 'Ctrl/Cmd+Z' });
    expect(tipContent({ tip: null, ariaLabel: 'Undo', keyId: 'mod+q' }, keysOf)).toEqual({ label: 'Undo' });
  });
});

describe('aria-describedby tokens', () => {
  it('adds the id once and keeps other ids', () => {
    expect(addToken(null, 'tip')).toBe('tip');
    expect(addToken('hint', 'tip')).toBe('hint tip');
    expect(addToken('hint tip', 'tip')).toBe('hint tip');
  });

  it('removes only its own id and reports when nothing is left', () => {
    expect(removeToken('hint tip', 'tip')).toBe('hint');
    expect(removeToken('tip', 'tip')).toBeNull();
    expect(removeToken(null, 'tip')).toBeNull();
  });
});

describe('shortcutKeys', () => {
  it('reads the keys the shortcuts dialog lists, one per id of a row', () => {
    expect(shortcutKeys('mod+z')).toBe('Ctrl/Cmd+Z');
    expect(shortcutKeys('mod+shift+z')).toBe('Shift+Ctrl/Cmd+Z');
    expect(shortcutKeys('mod+y')).toBe('Ctrl/Cmd+Y');
    expect(shortcutKeys('mod+d')).toBe('Ctrl/Cmd+D');
    expect(shortcutKeys('mod+=')).toBe('Ctrl/Cmd+=');
    expect(shortcutKeys('mod+-')).toBe('Ctrl/Cmd+-');
    expect(shortcutKeys('shift+0')).toBe('Shift+0');
    expect(shortcutKeys('shift+1')).toBe('Shift+1');
    expect(shortcutKeys('delete')).toBe('Delete');
    expect(shortcutKeys('backspace')).toBe('Backspace');
    expect(shortcutKeys(']')).toBe(']');
    expect(shortcutKeys('[')).toBe('[');
  });

  it('gives each of two tool letters for the same tool its own key', () => {
    expect(shortcutKeys('n')).toBe('N');
    expect(shortcutKeys('s')).toBe('S');
    expect(shortcutKeys('l')).toBe('L');
    expect(shortcutKeys('x')).toBe('X');
  });

  it('is undefined for a key the table does not document', () => {
    expect(shortcutKeys('mod+q')).toBeUndefined();
    expect(shortcutKeys('')).toBeUndefined();
  });

  it('answers for every documented id and for every tool letter, without a list of alternatives', () => {
    const ids = SHORTCUTS.flatMap((s) => s.ids);
    expect(ids.filter((id) => shortcutKeys(id) === undefined)).toEqual([]);
    const lists = SHORTCUTS.filter((s) => s.ids.length > 1).flatMap((s) => s.ids).filter((id) => /, | or | \/ /.test(shortcutKeys(id) ?? ''));
    expect(lists).toEqual([]);
    for (const letter of Object.keys(TOOL_KEYS)) expect(shortcutKeys(letter)).toBe(letter.toUpperCase());
  });
});
