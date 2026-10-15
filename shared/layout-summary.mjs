// Where is there room on a board? (TAB-379) Pure geometry with no I/O, no Yjs and no DOM, imported by the MCP server
// (server/board-ops.mjs: the layout block of get_board and the auto-placement of create_objects) and by the AI chat, so both
// give an AI the same picture. shared/layout-summary.d.ts carries the types.
//
// Everything here works on rectangles. The caller decides what is a solid: every visible box, every frame (even an empty one,
// so nothing lands "inside" a frame without being its child) and the private notes that are withheld from the reader. The
// output never names or counts a solid: free areas are plain rectangles and the occupied map is coarse (see COARSE).

/** The space kept between a new object and what is already there. */
export const GAP = 24;
/** Room beyond the content when nothing else fits, and between the content and the "right of / below" free areas. */
export const MARGIN = 80;
/** The size of the free areas reported by summarizeLayout. */
export const AREA = Object.freeze({ right: { w: 640, h: 480 }, hole: { w: 480, h: 320 }, frame: { w: 320, h: 240 } });
/** A frame's title bar and padding: objects placed inside a frame keep out of this strip. */
export const FRAME_PAD = Object.freeze({ top: 56, side: 24, bottom: 24 });
/** Most frames, free areas and occupied regions in a summary. */
export const MAX = Object.freeze({ frames: 20, free: 6, occupied: 12, frameAreas: 5 });

const MAX_CELLS = 256;
const MIN_CELL = 16;
const COARSE = 160;

/**
 * A rectangle grown outward to the absolute 160-unit grid (not relative to any content). The room taken by something the reader may
 * not see is only ever known to this precision, so no free area, no position chosen for a new object and no "all content" edge can
 * reveal where it exactly is.
 */
export function snapOutward(r, cell = COARSE) {
  const x0 = Math.floor(r.x / cell) * cell, y0 = Math.floor(r.y / cell) * cell;
  return { x: x0, y: y0, w: Math.ceil((r.x + r.w) / cell) * cell - x0, h: Math.ceil((r.y + r.h) / cell) * cell - y0 };
}

const usable = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0;
const round = (v) => Math.round(v);
const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The box around all usable rectangles, or null when there are none. */
export function boundsOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (!usable(r)) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The inside of a frame, where its children may go. */
export const frameInterior = (f) => ({
  x: f.x + FRAME_PAD.side, y: f.y + FRAME_PAD.top, w: Math.max(0, f.w - 2 * FRAME_PAD.side), h: Math.max(0, f.h - FRAME_PAD.top - FRAME_PAD.bottom),
});

/**
 * An occupancy grid over `region`: a cell is taken when a solid, grown by `gap`, touches it. A summed-area table answers "is this window
 * empty?" in constant time, so a search is one pass over the cells however many solids there are.
 */
function gridOf(solids, region, gap) {
  const cell = Math.max(MIN_CELL, Math.ceil(Math.max(region.w, region.h) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil(region.w / cell));
  const rows = Math.max(1, Math.ceil(region.h / cell));
  const taken = new Uint8Array(cols * rows);
  for (const s of solids) {
    if (!usable(s)) continue;
    const c0 = Math.max(0, Math.floor((s.x - gap - region.x) / cell));
    const c1 = Math.min(cols - 1, Math.floor((s.x + s.w + gap - region.x) / cell));
    const r0 = Math.max(0, Math.floor((s.y - gap - region.y) / cell));
    const r1 = Math.min(rows - 1, Math.floor((s.y + s.h + gap - region.y) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) taken[r * cols + c] = 1;
  }
  const sat = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      sat[(r + 1) * (cols + 1) + c + 1] = taken[r * cols + c] + sat[r * (cols + 1) + c + 1] + sat[(r + 1) * (cols + 1) + c] - sat[r * (cols + 1) + c];
    }
  }
  const empty = (c, r, wc, hc) => {
    const a = sat[(r + hc) * (cols + 1) + c + wc] - sat[r * (cols + 1) + c + wc] - sat[(r + hc) * (cols + 1) + c] + sat[r * (cols + 1) + c];
    return a === 0;
  };
  return { cell, cols, rows, taken, empty };
}

/**
 * The first place (top to bottom, then left to right) where a w x h object fits inside `region` without touching a solid or
 * coming closer than `gap` to one. `region` defaults to the box around the solids. Returns null when nothing fits.
 */
export function findSpot(solids, size, { region = boundsOf(solids), gap = GAP } = {}) {
  if (!region || !usable(region) || !(size.w > 0) || !(size.h > 0) || size.w > region.w || size.h > region.h) return null;
  const g = gridOf(solids, region, gap);
  const wc = Math.ceil(size.w / g.cell), hc = Math.ceil(size.h / g.cell);
  for (let r = 0; r + hc <= g.rows; r++) {
    for (let c = 0; c + wc <= g.cols; c++) {
      if (!g.empty(c, r, wc, hc)) continue;
      const x = region.x + c * g.cell, y = region.y + r * g.cell;
      if (x + size.w <= region.x + region.w && y + size.h <= region.y + region.h) return { x: round(x), y: round(y) };
    }
  }
  return null;
}

/** Lays sizes out in rows of at most `maxRowW`, in order: offsets from the block's top left corner, and the block's size. */
export function packBlock(sizes, { maxRowW = 1200, gap = GAP } = {}) {
  const limit = Math.max(maxRowW, ...sizes.map((s) => s.w));
  const offsets = [];
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > limit) { x = 0; y += rowH + gap; rowH = 0; }
    offsets.push({ x, y });
    x += s.w + gap; rowH = Math.max(rowH, s.h); w = Math.max(w, x - gap);
  }
  return { offsets, w, h: sizes.length ? y + rowH : 0 };
}

/** Free space beyond the content: to the right of everything, level with its top, or (an empty board) at the origin. */
export const beyondContent = (solids) => {
  const b = boundsOf(solids);
  return b ? { x: round(b.x + b.w + MARGIN), y: round(b.y) } : { x: 0, y: 0 };
};

/**
 * Places `sizes` together as one block. Outside a frame (no `region`): in a hole of the content that fits the whole block, else
 * beyond the content. Inside a frame (`region` is its interior): in a spot of the interior that fits the block, else one by one
 * in the first spots that fit, else null (the caller refuses: the frame has no room). Returns one {x, y} per size.
 */
export function placeBlock(solids, sizes, { region = null, gap = GAP } = {}) {
  if (!sizes.length) return [];
  const block = packBlock(sizes, { gap, maxRowW: region ? Math.max(region.w, 1) : 1200 });
  const spot = findSpot(solids, block, { region: region ?? undefined, gap });
  if (spot) return block.offsets.map((o) => ({ x: round(spot.x + o.x), y: round(spot.y + o.y) }));
  if (!region) {
    const at = beyondContent(solids);
    return block.offsets.map((o) => ({ x: round(at.x + o.x), y: round(at.y + o.y) }));
  }
  const placed = [], taken = [...solids];
  for (const s of sizes) {
    const one = findSpot(taken, s, { region, gap });
    if (!one) return null;
    placed.push(one);
    taken.push({ ...one, w: s.w, h: s.h });
  }
  return placed;
}

/** Connected groups of coarse cells, as rectangles snapped to the coarse grid: where the board is busy, never what is there. */
function occupiedRegions(solids, bounds) {
  const cell = Math.max(COARSE, Math.ceil(Math.max(bounds.w, bounds.h) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil(bounds.w / cell)), rows = Math.max(1, Math.ceil(bounds.h / cell));
  const taken = new Uint8Array(cols * rows);
  for (const s of solids) {
    if (!usable(s)) continue;
    const c0 = Math.max(0, Math.floor((s.x - bounds.x) / cell)), c1 = Math.min(cols - 1, Math.floor((s.x + s.w - bounds.x) / cell));
    const r0 = Math.max(0, Math.floor((s.y - bounds.y) / cell)), r1 = Math.min(rows - 1, Math.floor((s.y + s.h - bounds.y) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) taken[r * cols + c] = 1;
  }
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let start = 0; start < taken.length; start++) {
    if (!taken[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let c0 = cols, c1 = 0, r0 = rows, r1 = 0, n = 0;
    while (stack.length) {
      const i = stack.pop(), c = i % cols, r = (i - c) / cols;
      n++; c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const j = nr * cols + nc;
        if (taken[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    regions.push({ x: round(bounds.x + c0 * cell), y: round(bounds.y + r0 * cell), w: (c1 - c0 + 1) * cell, h: (r1 - r0 + 1) * cell, cells: n });
  }
  regions.sort((a, b) => b.cells - a.cells || a.y - b.y || a.x - b.x);
  return { regions: regions.slice(0, MAX.occupied).map(({ x, y, w, h }) => ({ x, y, w, h })), more: Math.max(0, regions.length - MAX.occupied) };
}

/**
 * The layout block of get_board. `solids` is every rectangle that takes room, with the `id` of the object it belongs to when it has
 * one: visible boxes, every frame, and the private notes withheld from the reader (counted here, never named). `frames` are the
 * frames the reader may see, with their own cleaned `name` and a count of the children they may see.
 * @returns {{ frames: object[], occupied: object[], occupiedMore?: number, free: object[] }}
 */
export function summarizeLayout({ solids, frames }) {
  const bounds = boundsOf(solids);
  if (!bounds) return { frames: [], occupied: [], free: [{ x: 0, y: 0, ...AREA.right, where: 'empty board' }] };
  const free = [];
  const add = (spot, size, where) => {
    if (spot && free.length < MAX.free) free.push({ x: round(spot.x), y: round(spot.y), w: size.w, h: size.h, where });
  };
  add({ x: bounds.x + bounds.w + MARGIN, y: bounds.y }, AREA.right, 'right of all content');
  add({ x: bounds.x, y: bounds.y + bounds.h + MARGIN }, AREA.right, 'below all content');

  const listed = frames.filter((f) => usable(f)).slice(0, MAX.frames);
  for (const f of listed.slice(0, MAX.frameAreas)) {
    const others = solids.filter((s) => s.id !== f.id);
    const inside = findSpot(others, AREA.frame, { region: frameInterior(f) });
    add(inside, AREA.frame, `inside frame ${f.id}`);
    for (const beside of [{ x: f.x + f.w + MARGIN / 2, y: f.y }, { x: f.x, y: f.y + f.h + MARGIN / 2 }]) {
      const box = { ...beside, ...AREA.frame };
      if (!others.some((s) => usable(s) && hits(box, { x: s.x - GAP, y: s.y - GAP, w: s.w + 2 * GAP, h: s.h + 2 * GAP }))) {
        add(beside, AREA.frame, `${beside.x > f.x ? 'right of' : 'below'} frame ${f.id}`);
        break;
      }
    }
  }
  const crowd = [...solids];
  for (let i = 0; i < 2; i++) {
    const hole = findSpot(crowd, AREA.hole, { region: bounds });
    if (!hole) break;
    add(hole, AREA.hole, 'gap in the content');
    crowd.push({ ...hole, ...AREA.hole });
  }
  const { regions, more } = occupiedRegions(solids, bounds);
  return {
    frames: listed.map((f) => ({ id: f.id, name: f.name, x: round(f.x), y: round(f.y), w: round(f.w), h: round(f.h), children: f.children })),
    occupied: regions,
    ...(more ? { occupiedMore: more } : {}),
    free,
  };
}
