/** A box in viewport pixels: a popover, or the anchor it opens from. */
export interface PopoverBox { left: number; top: number; width: number; height: number }

/**
 * The transform origin of a popover that grows from its anchor: the anchor's centre, as "Xpx Ypx" inside the popover's own box.
 * An anchor beside or above the popover gives an edge (0), not a point outside the box.
 */
export function popoverOrigin(anchor: PopoverBox, pop: PopoverBox): string {
  const x = Math.min(Math.max(anchor.left + anchor.width / 2 - pop.left, 0), pop.width);
  const y = Math.min(Math.max(anchor.top + anchor.height / 2 - pop.top, 0), pop.height);
  return `${x}px ${y}px`;
}
