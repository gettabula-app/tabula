import { describe, expect, it } from 'vitest';
import {
  clampGroupChipPosition,
  doneChipText,
  groupActionForSelection,
  groupChipText,
  groupPathLabel,
  placeEnteredGroupChips,
  showSelectedGroupChip,
  truncateMiddle,
} from '../src/ui/group-ui-logic';

describe('group labels', () => {
  it('uses the direct member count until a group has a name', () => {
    expect(groupChipText(undefined, 3)).toBe('Group · 3');
    expect(groupChipText('   ', 2)).toBe('Group · 2');
    expect(groupChipText(' Notes ', 3)).toBe('Notes');
  });

  it('shows the full nested path and truncates a long path in the middle', () => {
    expect(groupPathLabel(['Header', 'Notes'])).toEqual({ text: 'Header › Notes', full: 'Header › Notes' });
    const full = 'A very long header path › Nested group › Notes';
    const label = groupPathLabel(['A very long header path', 'Nested group', 'Notes']);
    expect(label.full).toBe(full);
    expect(label.text).toHaveLength(28);
    expect(label.text).toContain('…');
    expect(label.text.startsWith('A very long')).toBe(true);
    expect(label.text.endsWith('› Notes')).toBe(true);
    expect(truncateMiddle('Unchanged', 28)).toBe('Unchanged');
  });

  it('uses the touch label without the keyboard hint', () => {
    expect(doneChipText(true)).toBe('Done');
    expect(doneChipText(false)).toBe('Done · Esc');
  });
});

describe('group quick actions', () => {
  it('shows Group for a multi-selection and Ungroup for one group, never both', () => {
    expect(groupActionForSelection([])).toBeNull();
    expect(groupActionForSelection([{ type: 'sticky' }])).toBeNull();
    expect(groupActionForSelection([{ type: 'sticky' }, { type: 'shape' }])).toBe('group');
    expect(groupActionForSelection([{ type: 'group' }])).toBe('ungroup');
    expect(groupActionForSelection([{ type: 'group' }, { type: 'sticky' }])).toBe('group');
  });
});

describe('group chip visibility and placement', () => {
  it('hides a selected group chip while dragging or resizing and below 30% zoom', () => {
    expect(showSelectedGroupChip(false, false, false, 1)).toBe(false);
    expect(showSelectedGroupChip(true, true, false, 1)).toBe(false);
    expect(showSelectedGroupChip(true, false, true, 1)).toBe(false);
    expect(showSelectedGroupChip(true, false, false, 0.299)).toBe(false);
    expect(showSelectedGroupChip(true, false, false, 0.3)).toBe(true);
  });

  it('clamps chips inside the viewport and below the top bars', () => {
    expect(clampGroupChipPosition(-20, 0, { width: 100, height: 20 }, { width: 390, height: 844 }, 72))
      .toEqual({ x: 8, y: 72 });
    expect(clampGroupChipPosition(500, 900, { width: 100, height: 20 }, { width: 390, height: 844 }, 72))
      .toEqual({ x: 282, y: 816 });
    expect(clampGroupChipPosition(0, 0, { width: 420, height: 20 }, { width: 390, height: 844 }, 72).x).toBe(8);
  });

  it('keeps the entered path and Done chips apart when a narrow group brings their anchors together', () => {
    const placement = placeEnteredGroupChips(
      { x: 158, y: 336 },
      { x: 151, y: 336 },
      { width: 94, height: 20 },
      { width: 74, height: 20 },
      { width: 390, height: 844 },
      72,
    );
    expect(placement.name).toEqual({ x: 158, y: 336 });
    expect(placement.done).toEqual({ x: 260, y: 336 });
    expect(placement.done.x).toBeGreaterThanOrEqual(placement.name.x + 94 + 8);
  });
});
