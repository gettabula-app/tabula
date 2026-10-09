export type GroupAction = 'group' | 'ungroup' | null;

export function groupChipText(name: unknown, directMemberCount: number): string {
  const label = typeof name === 'string' ? name.trim() : '';
  return label || `Group · ${Math.max(0, Math.floor(directMemberCount))}`;
}

export function truncateMiddle(text: string, maxLength = 28): string {
  const max = Math.max(1, Math.floor(maxLength));
  if (text.length <= max) return text;
  if (max === 1) return '…';
  const room = max - 1;
  const left = Math.ceil(room / 2);
  const right = Math.floor(room / 2);
  return `${text.slice(0, left)}…${right ? text.slice(-right) : ''}`;
}

export function groupPathLabel(names: readonly unknown[]): { text: string; full: string } {
  const full = names.map((name) => typeof name === 'string' && name.trim() ? name.trim() : 'Group').join(' › ');
  return { text: truncateMiddle(full), full };
}

export function groupActionForSelection(selection: readonly { type: string }[]): GroupAction {
  if (selection.length >= 2) return 'group';
  if (selection.length === 1 && selection[0].type === 'group') return 'ungroup';
  return null;
}

export function doneChipText(coarsePointer: boolean): string {
  return coarsePointer ? 'Done' : 'Done · Esc';
}

/**
 * The screen rectangle the quick-action bar keeps off while a group is selected: the chip sits 6px above the outline, which is 6px
 * out, 20px high; `x` and `y` are the screen position of the group's top-left corner. Null when the chip is not drawn.
 */
export function groupChipAvoidBox(x: number, y: number, text: string, zoom: number): { x: number; y: number; w: number; h: number } | null {
  if (!showSelectedGroupChip(true, false, false, zoom)) return null;
  const pad = 4;
  const w = Math.max(42, 12 + text.length * 7);
  return { x: x - 6 - pad, y: y - 32 - pad, w: w + 2 * pad, h: 20 + 12 + 2 * pad };
}

export function showSelectedGroupChip(selectedGroup: boolean, dragging: boolean, resizing: boolean, zoom: number): boolean {
  return selectedGroup && !dragging && !resizing && zoom >= 0.3;
}

export function clampGroupChipPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  topInset: number,
  margin = 8,
): { x: number; y: number } {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.max(min, max), value));
  return {
    x: clamp(x, margin, viewport.width - size.width - margin),
    y: clamp(y, topInset, viewport.height - size.height - margin),
  };
}

export function placeEnteredGroupChips(
  nameAnchor: { x: number; y: number },
  doneAnchor: { x: number; y: number },
  nameSize: { width: number; height: number },
  doneSize: { width: number; height: number },
  viewport: { width: number; height: number },
  topInset: number,
  gap = 0,
): { name: { x: number; y: number }; done: { x: number; y: number } } {
  const rowHeight = Math.max(nameSize.height, doneSize.height);
  const rowY = Math.max(topInset, Math.min(nameAnchor.y, viewport.height - rowHeight - 8));
  const name = clampGroupChipPosition(nameAnchor.x, rowY, nameSize, viewport, topInset);
  let done = clampGroupChipPosition(doneAnchor.x, rowY, doneSize, viewport, topInset);
  const overlap = name.x < done.x + doneSize.width && name.x + nameSize.width > done.x &&
    name.y < done.y + doneSize.height && name.y + nameSize.height > done.y;
  if (!overlap) return { name, done };

  const margin = 8;
  const maxDoneX = Math.max(margin, viewport.width - doneSize.width - margin);
  const besideX = name.x + nameSize.width + gap;
  if (besideX <= maxDoneX) return { name, done: { x: besideX, y: rowY } };

  // Keep Done on the same row at the viewport's right edge; move the path chip left when the group is narrow.
  const maxNameX = maxDoneX - gap - nameSize.width;
  const nameX = Math.max(margin, Math.min(name.x, maxNameX));
  return { name: { x: nameX, y: rowY }, done: { x: maxDoneX, y: rowY } };
}
