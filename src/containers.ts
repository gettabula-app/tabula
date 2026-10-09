// Client glue for containers (docs/kanban.md, slice 2): making a kanban, adding a card, and moving cards, each one
// transaction and one undo step. Pure maths lives in src/ui/kanban-logic.ts and shared/containers.mjs.

import { KANBAN, LIMITS, layoutContainer, planInsert, ranksBetween } from '../shared/containers';
import type { Store } from './store';
import { newId } from './store';
import type { BaseObj, Id, Obj, Point } from './types';
import { cardContentHeight } from './markup';

/** The three lanes a new kanban starts with (docs/kanban.md, Making one). */
export const DEFAULT_LANES = [
  { name: 'To do', stage: 'todo' },
  { name: 'Doing', stage: 'doing' },
  { name: 'Done', stage: 'done' },
] as const;

export interface NewObjectBase {
  z: string;
  createdBy: string;
  /** Font of the container's name (the board's heading font). */
  headingFont?: string;
  /** Font of lanes and cards (the board's body font). */
  bodyFont?: string;
  /** The frame the container sits in, if any. */
  parent?: Id;
}

/** A new kanban container with the default lanes. Nothing is written; the caller creates them in one transaction. */
export function newKanban(at: Point, base: NewObjectBase): { container: BaseObj; lanes: BaseObj[] } {
  const now = Date.now();
  const id = newId();
  const ranks = ranksBetween(null, null, DEFAULT_LANES.length, id);
  const lanes: BaseObj[] = DEFAULT_LANES.map((l, i) => ({
    id: newId(), type: 'lane', parent: id, rank: ranks[i], name: l.name, stage: l.stage,
    x: 0, y: 0, w: 0, h: 0, rotation: 0, z: base.z, createdBy: base.createdBy, updatedAt: now, font: base.bodyFont,
  }));
  const container: BaseObj = {
    id, type: 'container', layout: 'kanban', name: 'Kanban', x: at.x, y: at.y, w: 0, h: 0, rotation: 0, z: base.z,
    createdBy: base.createdBy, updatedAt: now, font: base.headingFont, parent: base.parent,
  };
  // stored sizes are set once at creation and then ignored (docs/kanban.md, Layout)
  const layout = layoutContainer(container, lanes, [])!;
  container.w = layout.w;
  container.h = layout.h;
  for (const lane of lanes) Object.assign(lane, layout.rects.get(lane.id));
  return { container, lanes };
}

/** The size a new kanban takes, for placing it centred on a click. */
export function newKanbanSize(): { w: number; h: number } {
  const { container } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: '' });
  return { w: container.w, h: container.h };
}

/** The container a lane or a laid-out card is in. */
export function containerOf(store: Store, o: Obj | undefined): Id | null {
  if (o?.type === 'container') return o.id;
  if (o?.type === 'lane') return o.parent ?? null;
  if (o?.type !== 'card' || !o.parent) return null;
  const lane = store.get(o.parent);
  return lane?.type === 'lane' ? lane.parent ?? null : null;
}

/** The lane a card is shown in: its parent, or the first lane of the container that shows it when its lane is gone. */
export function laneOf(store: Store, cardId: Id): Id | null {
  const card = store.get(cardId);
  if (card?.type !== 'card' || !card.parent) return null;
  const parent = store.get(card.parent);
  if (parent) return parent.type === 'lane' ? parent.id : null;
  for (const o of store.cache.values()) {
    if (o.type !== 'container') continue;
    for (const [lane, ids] of store.containerLayout(o.id)?.cards ?? []) if (ids.includes(cardId)) return lane;
  }
  return null;
}

/** Cards in the board, and in one lane: for the limits (docs/kanban.md, Limits). */
function counts(store: Store, laneId: Id): { board: number; lane: number } {
  let board = 0;
  for (const o of store.cache.values()) if (o.type === 'card') board++;
  const lane = store.get(laneId);
  const layout = lane?.type === 'lane' && lane.parent ? store.containerLayout(lane.parent) : null;
  return { board, lane: layout?.cards.get(laneId)?.length ?? 0 };
}

/** Why a card cannot be added to a lane, or null when it can. */
export function addRefusal(store: Store, laneId: Id, n = 1): string | null {
  const c = counts(store, laneId);
  if (c.lane + n > LIMITS.cardsPerLane) return `A lane holds at most ${LIMITS.cardsPerLane} cards.`;
  if (c.board + n > LIMITS.cards) return `A board holds at most ${LIMITS.cards} cards.`;
  return null;
}

/**
 * Adds a card with this title at the end of a lane: one transaction, one undo step. The title is cut to the limit and its
 * height is stored, so every client lays it out the same. Returns the new card's id, or null when nothing was written.
 */
export function addCard(store: Store, laneId: Id, title: string, base: { createdBy: string; font?: string }): Id | null {
  const lane = store.get(laneId);
  const text = title.trim().slice(0, LIMITS.title);
  if (lane?.type !== 'lane' || !lane.parent || !text || store.readOnly) return null;
  const layout = store.containerLayout(lane.parent);
  if (!layout || addRefusal(store, laneId)) return null;
  const siblings = (layout.cards.get(laneId) ?? []).map((id) => store.get(id)!).filter(Boolean);
  const { ranks, repairs } = planInsert(siblings, laneId, siblings.length, 1);
  const r = layout.rects.get(laneId)!;
  const w = r.w - KANBAN.lanePad * 2;
  const card: BaseObj = {
    id: newId(), type: 'card', parent: laneId, rank: ranks[0], text, x: r.x + KANBAN.lanePad, y: r.y, w, h: 0,
    rotation: 0, z: lane.z, createdBy: base.createdBy, updatedAt: Date.now(), font: base.font,
  };
  card.h = cardContentHeight(card, w);
  store.undo.stopCapturing();
  store.transact(() => {
    for (const p of repairs) store.update(p.id, { parent: p.parent, rank: p.rank });
    store.create(card);
  });
  store.undo.stopCapturing();
  return store.get(card.id) ? card.id : null;
}

/**
 * The order several cards keep when they move together: container order (lane by lane, top to bottom), then loose cards
 * top to bottom and left to right (docs/kanban.md, Hit testing: selecting several cards).
 */
export function movingOrder(store: Store, ids: Iterable<Id>): Id[] {
  const rank = new Map<Id, number>();
  let i = 0;
  for (const o of store.ordered()) {
    if (o.type !== 'container') continue;
    for (const id of store.containerLayout(o.id)?.order ?? []) rank.set(id, i++);
  }
  const all = [...new Set(ids)].map((id) => store.get(id)).filter((o): o is Obj => o?.type === 'card');
  const pos = (o: Obj) => store.geometry(o);
  return all.sort((a, b) => {
    const ra = rank.get(a.id), rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return pos(a).y - pos(b).y || pos(a).x - pos(b).x || (a.id < b.id ? -1 : 1);
  }).map((o) => o.id);
}

/**
 * Why cards cannot move into a lane, or null when they can. Only cards the lane does not already show count as
 * arriving: one whose lane was deleted and that this lane shows already is not new to it.
 */
export function moveRefusal(store: Store, ids: Id[], laneId: Id): string | null {
  const lane = store.get(laneId);
  const shown = lane?.type === 'lane' && lane.parent ? store.containerLayout(lane.parent)?.cards.get(laneId) ?? [] : [];
  const arriving = ids.filter((id) => !shown.includes(id)).length;
  return arriving ? addRefusal(store, laneId, arriving) : null;
}

/**
 * Moves cards into a lane at `index` (among the lane's cards that are not moving), keeping their order: one transaction
 * and one undo step that writes each card's `parent` and `rank`, plus fresh ranks for the lane's other cards when it had
 * equal or mixed ones (docs/kanban.md, Concurrent edits). Locked cards stay. Returns whether anything was written.
 */
export function moveCards(store: Store, ids: Id[], laneId: Id, index: number): boolean {
  const lane = store.get(laneId);
  if (lane?.type !== 'lane' || !lane.parent || store.readOnly) return false;
  const layout = store.containerLayout(lane.parent);
  if (!layout) return false;
  const moving = movingOrder(store, ids).filter((id) => !store.get(id)?.locked);
  if (!moving.length) return false;
  const skip = new Set(moving);
  const current = layout.cards.get(laneId) ?? [];
  const others = current.filter((id) => !skip.has(id));
  const at = Math.min(Math.max(Math.trunc(index) || 0, 0), others.length);
  // dropped where they already are: nothing to write, and no undo step for it
  const after = [...others.slice(0, at), ...moving, ...others.slice(at)];
  if (after.length === current.length && after.every((id, i) => id === current[i])) return false;
  const siblings = others.map((id) => store.get(id)!).filter(Boolean);
  if (moveRefusal(store, moving, laneId)) return false;
  const { ranks, repairs } = planInsert(siblings, laneId, at, moving.length);
  store.undo.stopCapturing();
  store.transact(() => {
    for (const p of repairs) store.update(p.id, { parent: p.parent, rank: p.rank });
    moving.forEach((id, i) => store.update(id, { parent: laneId, rank: ranks[i] }));
  });
  store.undo.stopCapturing();
  return true;
}

/**
 * Takes cards out of their lanes onto the board as loose cards, each at the place given (its top-left), in the frame
 * there if any: one transaction and one undo step. A card stays a card (docs/kanban.md, Sticky to card and back).
 */
export function dropLoose(store: Store, places: { id: Id; x: number; y: number; w: number; h: number; parent?: Id }[]): boolean {
  const list = places.filter((p) => store.get(p.id)?.type === 'card' && !store.get(p.id)?.locked);
  if (!list.length || store.readOnly) return false;
  // a loose card is an ordinary box again, painted by its own z: above everything, in the order given
  const zs = store.topZs(list.length);
  store.undo.stopCapturing();
  store.transact(() => {
    list.forEach((p, i) => store.update(p.id, { parent: p.parent, rank: undefined, x: p.x, y: p.y, w: p.w, h: p.h, z: zs[i] }));
  });
  store.undo.stopCapturing();
  return true;
}

export type DeletePlan = { ids: Set<Id>; relocate: { id: Id; parent: Id; rank: string }[] } | { refused: string };

/**
 * What deleting `selected` (unlocked objects) does inside kanbans: a container takes its lanes and cards with it; a
 * lane's cards move to the end of the nearest lane on its left that stays, else on its right, and go with the last lane
 * of a kanban (docs/kanban.md, Concurrent edits). A lane of a locked kanban stays. Locked lanes and cards are never
 * deleted or moved by it: the whole delete is refused instead, as a locked object is never changed by an edit.
 */
export function planKanbanDelete(store: Store, selected: Id[]): DeletePlan {
  const ids = new Set(selected);
  const locked = (id: Id) => !!store.get(id)?.locked;
  for (const id of selected) {
    const o = store.get(id);
    if (o?.type === 'container') {
      const inside = store.containerLayout(id)?.order ?? [];
      if (inside.some(locked)) return { refused: 'This kanban has locked lanes or cards. Unlock them to delete it.' };
      inside.forEach((c) => ids.add(c));
    }
    if (o?.type === 'lane' && o.parent && !ids.has(o.parent) && locked(o.parent)) ids.delete(id);
  }
  const relocate: { id: Id; parent: Id; rank: string }[] = [];
  const planned = new Map<Id, { id: Id; parent?: Id; rank?: string }[]>();
  for (const id of Array.from(ids)) {
    const lane = store.get(id);
    if (lane?.type !== 'lane' || !lane.parent || ids.has(lane.parent)) continue;
    const layout = store.containerLayout(lane.parent);
    if (!layout) continue;
    const cards = (layout.cards.get(id) ?? []).filter((c) => !ids.has(c));
    if (cards.some(locked)) return { refused: 'This lane has locked cards. Unlock them to delete it.' };
    const at = layout.lanes.indexOf(id);
    const keep = (l: Id) => !ids.has(l);
    const target = layout.lanes.slice(0, Math.max(at, 0)).reverse().find(keep) ?? layout.lanes.slice(at + 1).find(keep);
    if (!target) {
      cards.forEach((c) => ids.add(c));
      continue;
    }
    if (!cards.length) continue;
    let siblings = planned.get(target);
    if (!siblings) siblings = (layout.cards.get(target) ?? []).filter((c) => !ids.has(c)).map((c) => store.get(c)!).map((o) => ({ id: o.id, parent: o.parent, rank: (o as BaseObj).rank }));
    const plan = planInsert(siblings, target, siblings.length, cards.length);
    const fixed = new Map(plan.repairs.map((r) => [r.id, r]));
    relocate.push(...plan.repairs);
    siblings = siblings.map((c) => fixed.get(c.id) ?? c);
    cards.forEach((c, i) => {
      relocate.push({ id: c, parent: target, rank: plan.ranks[i] });
      siblings!.push({ id: c, parent: target, rank: plan.ranks[i] });
    });
    planned.set(target, siblings);
  }
  return { ids, relocate };
}
