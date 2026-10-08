export interface Box { x: number; y: number; w: number; h: number }

/** Places a floating bar centred above a target box, below it when there is no room above. */
export function placeBar(target: Box, bar: { w: number; h: number }, view: { w: number; h: number }, lift = 0, margin = 12, topInset = 64, gap = 12): { x: number; y: number; below: boolean } {
  const maxX = view.w - bar.w - margin;
  const cx = target.x + target.w / 2 - bar.w / 2;
  const x = maxX >= margin ? Math.max(margin, Math.min(maxX, cx)) : margin;
  const yAbove = target.y - gap - lift - bar.h;
  if (yAbove >= topInset) return { x, y: yAbove, below: false };
  const yBelow = target.y + target.h + gap;
  if (yBelow + bar.h <= view.h - margin) return { x, y: yBelow, below: true };
  return { x, y: Math.max(topInset, Math.min(view.h - bar.h - margin, yBelow)), below: true };
}
