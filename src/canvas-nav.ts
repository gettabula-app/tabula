/**
 * Keyboard navigation of the canvas (docs/canvas-keyboard.md): the reading order of the objects and the nearest object in a
 * direction. Pure: it works on plain boxes, so it is tested without a browser or a store.
 */
export interface NavItem {
  id: string;
  /** Centre and size in world units. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  parent: string | null;
  /** A connector joins two objects; it has no place of its own and is read after the objects. */
  connector?: { from: string | null; to: string | null };
}

export interface OutlineEntry {
  id: string;
  /** 0 at the top level. */
  level: number;
}

export type NavDirection = 'left' | 'right' | 'up' | 'down';

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Rows from top to bottom, left to right in a row. Objects whose centres are within half the median height of the row's first are one row. */
function inRows(items: readonly NavItem[]): NavItem[] {
  const tolerance = median(items.map((i) => i.h)) / 2;
  const byY = [...items].sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.id.localeCompare(b.id));
  const out: NavItem[] = [];
  let row: NavItem[] = [];
  let rowY = 0;
  const flush = () => {
    out.push(...row.sort((a, b) => a.cx - b.cx || a.id.localeCompare(b.id)));
    row = [];
  };
  for (const item of byY) {
    if (row.length && item.cy - rowY > tolerance) flush();
    if (!row.length) rowY = item.cy;
    row.push(item);
  }
  flush();
  return out;
}

/**
 * The outline order: top-level objects by rows then columns, each followed by its children (one level deeper, in rows too), then
 * the connectors, in the order of the objects they start from. An object whose parent is missing counts as top level.
 */
export function readingOrder(items: readonly NavItem[]): OutlineEntry[] {
  const present = new Set(items.map((i) => i.id));
  const objects = items.filter((i) => !i.connector);
  const children = new Map<string | null, NavItem[]>();
  for (const o of objects) {
    const key = o.parent && present.has(o.parent) && o.parent !== o.id ? o.parent : null;
    children.set(key, [...(children.get(key) ?? []), o]);
  }
  const out: OutlineEntry[] = [];
  const seen = new Set<string>();
  const walk = (list: NavItem[] | undefined, level: number) => {
    for (const o of inRows(list ?? [])) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push({ id: o.id, level });
      walk(children.get(o.id), level + 1);
    }
  };
  walk(children.get(null), 0);
  // anything caught in a parent cycle is still read
  for (const o of objects) if (!seen.has(o.id)) { seen.add(o.id); out.push({ id: o.id, level: 0 }); }
  const position = new Map(out.map((e, i) => [e.id, i]));
  const connectors = items.filter((i) => i.connector)
    .sort((a, b) => (position.get(a.connector!.from ?? '') ?? Infinity) - (position.get(b.connector!.from ?? '') ?? Infinity)
      || (position.get(a.connector!.to ?? '') ?? Infinity) - (position.get(b.connector!.to ?? '') ?? Infinity) || a.id.localeCompare(b.id));
  for (const c of connectors) out.push({ id: c.id, level: 0 });
  return out;
}

/**
 * The nearest object in a direction: its centre lies in the 90 degree cone around that direction from the current centre, and the
 * winner has the smallest distance weighted up by how far off the axis it is (and by 30% for a different parent). Null at an edge.
 */
export function nearestInDirection(items: readonly NavItem[], fromId: string, direction: NavDirection): string | null {
  const from = items.find((i) => i.id === fromId);
  if (!from) return null;
  const unit = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } }[direction];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const o of items) {
    if (o.id === fromId || o.connector) continue;
    const dx = o.cx - from.cx;
    const dy = o.cy - from.cy;
    const along = dx * unit.x + dy * unit.y;
    const across = Math.abs(dx * unit.y - dy * unit.x);
    if (along <= 0 || across > along) continue;
    const distance = Math.hypot(dx, dy);
    const score = distance * (1 + 0.5 * (across / distance)) * (o.parent === from.parent ? 1 : 1.3);
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best !== null && o.id.localeCompare(best) < 0)) {
      best = o.id;
      bestScore = score;
    }
  }
  return best;
}

/** The entry `step` places on in reading order, clamped at the ends (so PageDown at the last object stays there). */
export function stepInOrder(order: readonly OutlineEntry[], currentId: string | null, step: number): string | null {
  if (!order.length) return null;
  const at = currentId ? order.findIndex((e) => e.id === currentId) : -1;
  if (at < 0) return order[step < 0 ? order.length - 1 : 0].id;
  return order[Math.max(0, Math.min(order.length - 1, at + step))].id;
}
