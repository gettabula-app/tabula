import type { BoardApp } from './app';
import { STICKY_COLORS } from './palette';
import { newId } from './store';
import type { BaseObj, Id, Obj, ProposedBy } from './types';

// Writes an AI proposal into the board (docs/ai.md, "Proposals"). The layout is a pure function so the preview (ghosts) and
// the add draw the same thing: what is previewed is what is added. Objects go right of everything on the board, at the
// MCP's nextFree (80 units right of the content, level with its top), and to the right of any other preview's area.
// The add is one store.transact, so one undo step on the stack of the person who adds it.

export type AiProposal =
  | { kind: 'create'; objects: { text: string; color?: string }[]; frame?: { title: string } }
  | { kind: 'group'; groups: { title: string; ids: string[] }[] };

export type ApplyResult = { ok: true; created: number; moved: number } | { ok: false; reason: 'board_changed' | 'read_only' };

export interface Rect { x: number; y: number; w: number; h: number }
/** What the layout needs to know about an object already on the board. */
export interface Existing { type: string; x: number; y: number; w: number; h: number; locked?: boolean }

export const STICKY = 192;
const STEP = 216;
const NEXT_FREE_GAP = 80;
const FRAME_PAD = 48;
const COLUMN_GAP = 48;
const HEADER_H = 32;
const HEADER_GAP = 16;

export interface CreateLayout {
  kind: 'create';
  area: Rect;
  frame: (Rect & { title: string }) | null;
  stickies: (Rect & { text: string; fill: string })[];
}
export interface GroupLayout {
  kind: 'group';
  area: Rect;
  headers: (Rect & { title: string })[];
  moves: { id: Id; from: Rect; to: Rect }[];
}
export type Layout = CreateLayout | GroupLayout;

/** A colour name from the model (any case) as the palette's fill; Yellow when it names none. */
export function stickyFill(name: string | undefined): string {
  const found = name ? STICKY_COLORS.find((c) => c.name.toLowerCase() === name.toLowerCase()) : undefined;
  return (found ?? STICKY_COLORS[0]).fill;
}

/** Where the next proposal starts: right of the content and of every area in `avoid`, level with the content's top. */
export function nextFree(content: Rect | null, avoid: Rect[] = []): { x: number; y: number } {
  const rs = [...(content ? [content] : []), ...avoid];
  if (!rs.length) return { x: 0, y: 0 };
  const right = Math.max(...rs.map((r) => r.x + r.w));
  const top = content ? content.y : Math.min(...rs.map((r) => r.y));
  return { x: Math.round(right + NEXT_FREE_GAP), y: Math.round(top) };
}

const gridOf = (n: number) => {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
};

/**
 * The layout of a proposal on a board, or null when the board no longer fits it (a group names a sticky that is gone,
 * locked or no longer a sticky). Pure: `get` reads the board, `content` is its bounds.
 */
export function layoutProposal(proposal: AiProposal, board: { content: Rect | null; get: (id: Id) => Existing | undefined }, avoid: Rect[] = []): Layout | null {
  const at = nextFree(board.content, avoid);
  if (proposal.kind === 'create') {
    const n = proposal.objects.length;
    const { cols, rows } = gridOf(n);
    const inner = { w: cols * STEP - (STEP - STICKY), h: rows * STEP - (STEP - STICKY) };
    const pad = proposal.frame ? FRAME_PAD : 0;
    const stickies = proposal.objects.map((o, i) => ({
      x: at.x + pad + (i % cols) * STEP,
      y: at.y + pad + Math.floor(i / cols) * STEP,
      w: STICKY,
      h: STICKY,
      text: o.text,
      fill: stickyFill(o.color),
    }));
    const area = { x: at.x, y: at.y, w: inner.w + 2 * pad, h: inner.h + 2 * pad };
    return { kind: 'create', area, frame: proposal.frame ? { ...area, title: proposal.frame.title } : null, stickies };
  }
  const headers: GroupLayout['headers'] = [];
  const moves: GroupLayout['moves'] = [];
  let tallest = 0;
  for (const [i, group] of proposal.groups.entries()) {
    const x = at.x + i * (STICKY + COLUMN_GAP);
    headers.push({ x, y: at.y, w: STICKY, h: HEADER_H, title: group.title });
    for (const [j, id] of group.ids.entries()) {
      const o = board.get(id);
      if (!o || o.type !== 'sticky' || o.locked) return null;
      const to = { x, y: at.y + HEADER_H + HEADER_GAP + j * STEP, w: o.w, h: o.h };
      moves.push({ id, from: { x: o.x, y: o.y, w: o.w, h: o.h }, to });
      tallest = Math.max(tallest, to.y + to.h - at.y);
    }
  }
  const w = proposal.groups.length * (STICKY + COLUMN_GAP) - COLUMN_GAP;
  return { kind: 'group', area: { x: at.x, y: at.y, w, h: Math.max(tallest, HEADER_H) }, headers, moves };
}

/** The board as the layout reads it. */
export function boardOf(app: BoardApp): { content: Rect | null; get: (id: Id) => Existing | undefined } {
  return {
    content: app.r.contentBounds(),
    get: (id) => {
      const o = app.store.get(id) as (Obj & Partial<Existing>) | undefined;
      return o && typeof o.x === 'number' && typeof o.w === 'number' ? { type: o.type, x: o.x, y: o.y!, w: o.w, h: o.h!, locked: o.locked } : undefined;
    },
  };
}

/**
 * Writes the proposal as one undo step. `avoid` are the areas of other previews still on the board. `proposedBy` (TAB-160)
 * is stamped on what it creates, next to `createdBy` (the person who added it); moved stickies keep their own.
 */
export function applyProposal(app: BoardApp, proposal: AiProposal, avoid: Rect[] = [], proposedBy?: ProposedBy): ApplyResult {
  if (app.readOnly) return { ok: false, reason: 'read_only' };
  const layout = layoutProposal(proposal, boardOf(app), avoid);
  if (!layout) return { ok: false, reason: 'board_changed' };
  const meta = app.store.getMeta();
  const now = Date.now();
  const base = (type: BaseObj['type'], r: Rect, z: string): BaseObj => ({
    id: newId(), type, x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0, z, createdBy: app.user.id, updatedAt: now, font: meta.bodyFont,
    ...(proposedBy ? { proposedBy: { feature: proposedBy.feature, by: { ...proposedBy.by } } } : {}),
  });

  const created: Obj[] = [];
  if (layout.kind === 'create') {
    const zs = app.store.topZs(layout.stickies.length + (layout.frame ? 1 : 0));
    const frame = layout.frame ? { ...base('frame', layout.frame, zs.shift()!), name: layout.frame.title, font: meta.headingFont } : null;
    if (frame) created.push(frame as Obj);
    for (const [i, s] of layout.stickies.entries()) {
      created.push({ ...base('sticky', s, zs[i]), text: s.text, fill: s.fill, ...(frame ? { parent: frame.id } : {}) } as Obj);
    }
  } else {
    const zs = app.store.topZs(layout.headers.length);
    for (const [i, hd] of layout.headers.entries()) created.push({ ...base('text', hd, zs[i]), text: hd.title, fontWeight: 700 } as Obj);
  }

  app.store.undo.stopCapturing();
  app.store.transact(() => {
    for (const o of created) app.store.create(o);
    if (layout.kind === 'group') for (const m of layout.moves) app.store.update(m.id, { x: m.to.x, y: m.to.y, parent: undefined });
  });
  app.store.undo.stopCapturing();
  const stickies = layout.kind === 'create' ? created.filter((o) => o.type === 'sticky').map((o) => o.id) : layout.moves.map((m) => m.id);
  app.resetScopeSelection(stickies);
  return { ok: true, created: layout.kind === 'create' ? layout.stickies.length : 0, moved: layout.kind === 'group' ? layout.moves.length : 0 };
}
