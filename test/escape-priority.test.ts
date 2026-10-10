import { describe, expect, it } from 'vitest';
import { escapeAction, type EscapeContext } from '../src/ui/escape-priority';

describe('Escape action priority', () => {
  const base: EscapeContext = {
    key: 'Escape', defaultPrevented: false, overlayOpen: false, dragging: false, groupOpen: false, drawerOpen: null,
  };

  it('leaves non-Escape and already handled keys alone', () => {
    expect(escapeAction({ ...base, key: 'Enter' })).toBe('none');
    expect(escapeAction({ ...base, defaultPrevented: true })).toBe('none');
  });

  it('closes an overlay before a drag, group or drawer', () => {
    expect(escapeAction({ ...base, overlayOpen: true, dragging: true, groupOpen: true, drawerOpen: 'templates' })).toBe('overlay');
  });

  it('cancels a drag before leaving a group or closing the drawer', () => {
    expect(escapeAction({ ...base, dragging: true, groupOpen: true, drawerOpen: 'layers' })).toBe('drag');
  });

  it('leaves the current group before closing the drawer', () => {
    expect(escapeAction({ ...base, groupOpen: true, drawerOpen: 'comments' })).toBe('group');
  });

  it('closes the drawer before falling through to board Escape behavior', () => {
    expect(escapeAction({ ...base, drawerOpen: 'templates' })).toBe('drawer');
    expect(escapeAction(base)).toBe('board');
  });

  it('routes every library and side tray through drawer priority', () => {
    for (const drawerOpen of ['shapes', 'uml', 'icons', 'stickers', 'templates', 'layers', 'comments', 'chat']) {
      expect(escapeAction({ ...base, drawerOpen })).toBe('drawer');
    }
  });
});
