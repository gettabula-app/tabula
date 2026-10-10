import { describe, expect, it } from 'vitest';
import { PLATFORM_MODIFIER, resolveKey, SHORTCUTS, type KeyEventLike, type KeyState } from '../src/tracker/ui/keys';

function key(keyName: string, options: Partial<KeyEventLike> = {}): KeyEventLike & { prevented: boolean } {
  const event = {
    key: keyName, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, timeStamp: 100,
    target: null, prevented: false,
    preventDefault() { this.prevented = true; },
    ...options,
  };
  return event;
}

const state: KeyState = { active: true, modifier: 'ctrl', layers: ['work'] };

describe('tracker key resolver', () => {
  it('resolves every single-key list and global binding from the shortcut map', () => {
    const cases: Array<[string, Partial<KeyEventLike>, string]> = [
      ['c', {}, 'create'], ['/', {}, 'focus-search'], ['f', {}, 'open-filter'], ['?', { shiftKey: true }, 'shortcut-sheet'],
      ['Enter', { shiftKey: true }, 'expand'], ['ArrowUp', {}, 'move-cursor'], ['ArrowDown', {}, 'move-cursor'],
      ['ArrowUp', { shiftKey: true }, 'move-cursor'], ['ArrowDown', { shiftKey: true }, 'move-cursor'],
      ['k', {}, 'move-cursor'], ['j', {}, 'move-cursor'], ['ArrowLeft', {}, 'group'], ['ArrowRight', {}, 'group'],
      ['Enter', {}, 'open-ticket'], [' ', {}, 'peek'], ['x', {}, 'toggle-selection'], ['s', {}, 'open-picker'],
      ['a', {}, 'open-picker'], ['p', {}, 'open-picker'], ['l', {}, 'open-picker'], ['d', {}, 'open-picker'],
      ['m', {}, 'open-picker'], ['Home', {}, 'move-to-edge'], ['End', {}, 'move-to-edge'],
      ['PageUp', {}, 'page'], ['PageDown', {}, 'page'], ['Backspace', {}, 'archive'], ['Delete', {}, 'archive'],
    ];
    for (const [keyName, modifiers, type] of cases) {
      expect(resolveKey(state, key(keyName, modifiers)).action?.type, `${keyName}`).toBe(type);
    }
    const mod = { ctrlKey: true };
    expect(resolveKey(state, key('k', mod)).action?.type).toBe('command-box');
    expect(resolveKey(state, key('a', mod)).action?.type).toBe('select-all');
    expect(resolveKey(state, key('z', mod)).action?.type).toBe('undo');
    expect(resolveKey(state, key('z', { ...mod, shiftKey: true })).action?.type).toBe('redo');
    expect(resolveKey(state, key('c', { ...mod, shiftKey: true })).action?.type).toBe('copy-link');
    expect(resolveKey(state, key('c', { ...mod, altKey: true })).action?.type).toBe('copy-key');
    expect(resolveKey(state, key('Escape')).action).toEqual({ type: 'escape', layer: 'work' });
    for (const [keyName, modifiers] of cases) {
      expect(SHORTCUTS.some((row) => row.keys.length > 0), `${keyName} has a populated shortcut sheet`).toBe(true);
      expect(resolveKey(state, key(keyName, modifiers)).action).not.toBeNull();
    }
    expect(SHORTCUTS.some((row) => row.keys === 'Esc')).toBe(true);
    expect(PLATFORM_MODIFIER === 'meta' || PLATFORM_MODIFIER === 'ctrl').toBe(true);
  });

  it('uses the selected platform modifier and keeps Ctrl and Meta from firing together', () => {
    expect(resolveKey({ active: true, modifier: 'meta' }, key('k', { metaKey: true })).action?.type).toBe('command-box');
    expect(resolveKey({ active: true, modifier: 'meta' }, key('k', { ctrlKey: true })).action).toBeNull();
    expect(resolveKey({ active: true, modifier: 'ctrl' }, key('k', { metaKey: true })).action).toBeNull();
  });

  it('waits for G then resolves I, M, A, B, and P, and expires the sequence', () => {
    for (const [next, tab] of [['i', 'inbox'], ['m', 'my'], ['a', 'all'], ['b', 'board'], ['p', 'projects']] as const) {
      const begin = resolveKey(state, key('g', { timeStamp: 100 }));
      expect(begin.action).toEqual({ type: 'sequence-pending', key: 'g', expiresAt: 1100 });
      expect(resolveKey({ ...state, pendingSequence: begin.pendingSequence }, key(next, { timeStamp: 500 })).action).toEqual({ type: 'switch-tab', tab });
    }
    const begin = resolveKey(state, key('g', { timeStamp: 100 }));
    expect(resolveKey({ ...state, pendingSequence: begin.pendingSequence }, key('i', { timeStamp: 1200 })).action).toBeNull();
  });

  it('does not capture typing or picker keys, but Escape still closes the top layer', () => {
    const input = { tagName: 'INPUT', closest: () => null } as unknown as HTMLElement;
    expect(resolveKey(state, key('f', { target: input })).action).toBeNull();
    expect(resolveKey({ ...state, focusOwner: 'picker' }, key('s')).action).toBeNull();
    expect(resolveKey({ ...state, pickerOpen: true }, key('k', { ctrlKey: true })).action).toBeNull();
    expect(resolveKey({ ...state, focusOwner: 'text', layers: ['work', 'ticket'] }, key('Escape')).action).toEqual({ type: 'escape', layer: 'ticket' });
    expect(resolveKey({ ...state, active: false }, key('j')).action).toBeNull();
  });

  it('keeps shell shortcuts available while the inbox list has focus', () => {
    const listbox = { classList: { contains: (name: string) => name === 'trk-inbox-list' } };
    const inboxRow = {
      tagName: 'DIV',
      closest: (selector: string) => selector === '[role="listbox"]' || selector === '.trk-inbox-list' ? listbox : null,
    } as unknown as HTMLElement;
    const begin = resolveKey(state, key('g', { target: inboxRow }));
    expect(begin.action?.type).toBe('sequence-pending');
    expect(resolveKey({ ...state, pendingSequence: begin.pendingSequence }, key('i', { target: inboxRow })).action)
      .toEqual({ type: 'switch-tab', tab: 'inbox' });
    expect(resolveKey(state, key('c', { target: inboxRow })).action?.type).toBe('create');
    expect(resolveKey(state, key('f', { target: inboxRow })).action?.type).toBe('open-filter');
    expect(resolveKey(state, key('k', { ctrlKey: true, target: inboxRow })).action?.type).toBe('command-box');
    expect(resolveKey(state, key('Escape', { target: inboxRow })).action?.type).toBe('escape');
  });
});
