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
  gap = 8,
): { name: { x: number; y: number }; done: { x: number; y: number } } {
  const name = clampGroupChipPosition(nameAnchor.x, nameAnchor.y, nameSize, viewport, topInset);
  let done = clampGroupChipPosition(doneAnchor.x, doneAnchor.y, doneSize, viewport, topInset);
  const overlap = name.x < done.x + doneSize.width && name.x + nameSize.width > done.x &&
    name.y < done.y + doneSize.height && name.y + nameSize.height > done.y;
  if (!overlap) return { name, done };

  const beside = clampGroupChipPosition(name.x + nameSize.width + gap, name.y, doneSize, viewport, topInset);
  if (beside.x >= name.x + nameSize.width + gap) return { name, done: beside };

  return {
    name,
    done: clampGroupChipPosition(name.x, name.y + nameSize.height + 4, doneSize, viewport, topInset),
  };
}
