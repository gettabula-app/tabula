import { describe, expect, it } from 'vitest';
import { SHORTCUTS, TOOL_KEYS, TOOL_LABELS, formatShortcutLabel, shortcutKeys } from '../src/shortcuts';

describe('the Line tool key', () => {
  it('maps Shift+L to the line tool and keeps L for the connector', () => {
    expect(TOOL_KEYS['shift+l']).toEqual({ kind: 'line' });
    expect(TOOL_KEYS.l).toEqual({ kind: 'connector' });
    expect(TOOL_LABELS['shift+l']).toBe('Line');
  });

  it('lists Line under Tools as Shift+L, and Connector as L or X', () => {
    const line = SHORTCUTS.find((s) => s.ids.includes('shift+l'));
    expect(line).toMatchObject({ group: 'Tools', keys: 'Shift+L', action: 'Line' });
    expect(SHORTCUTS.find((s) => s.action === 'Connector')?.keys).toBe('L or X');
    expect(shortcutKeys('shift+l')).toBe('Shift+L');
    expect(formatShortcutLabel('Shift+L', 'MacIntel')).toBe('⇧L');
    expect(formatShortcutLabel('Shift+L', 'Win32')).toBe('Shift+L');
  });
});
