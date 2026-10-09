// The board's label set (docs/kanban.md, Labels): the `labels` map, one whole value per label `{ id, name, color, order }`.
// Every read goes through `validLabel` and every colour written through `kanbanColor`, since any client can write the
// map and its values reach a style attribute. Each change is one transaction and one undo step.

import { LABEL_COLORS, LABEL_DEFAULT_COLOR, LIMITS, kanbanColor, validLabel } from '../shared/containers';
import type { Store } from './store';
import { newId } from './store';
import type { Id, Label } from './types';

/**
 * The board's labels in their order (by `order`, then name, then id), each one checked: a value stored under another
 * label's key is not a label (it would shadow or double that label), and no more than the 30 a board holds are read,
 * however many another client wrote.
 */
export function listLabels(store: Store): Label[] {
  const out: Label[] = [];
  store.labels.forEach((v, key) => {
    const l = validLabel(v);
    if (l && l.id === key) out.push(l);
  });
  return sortLabels(out).slice(0, LIMITS.labels);
}

export function sortLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
}

/** A label name as it is stored: one line, trimmed, at most 40 characters. Empty when nothing is left. */
export function cleanLabelName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.labelName).trim();
}

/** The first palette colour no label uses yet, so a new label is told apart; the default when all are taken. */
export function nextLabelColor(labels: Label[]): string {
  return LABEL_COLORS.find((c) => !labels.some((l) => l.color === c)) ?? LABEL_DEFAULT_COLOR;
}

/** Why a label cannot be created, or null. */
export function createRefusal(store: Store, name: string): string | null {
  if (!cleanLabelName(name)) return 'A label needs a name.';
  if (listLabels(store).length >= LIMITS.labels) return `A board holds at most ${LIMITS.labels} labels.`;
  return null;
}

function write(store: Store, fn: () => void): boolean {
  if (store.readOnly) return false;
  store.undo.stopCapturing();
  store.transact(fn);
  store.undo.stopCapturing();
  return true;
}

/** Adds a label at the end. Returns its id, or null when nothing was written. */
export function createLabel(store: Store, name: string, color?: string): Id | null {
  if (createRefusal(store, name) || store.readOnly) return null;
  const labels = listLabels(store);
  const id = newId();
  const order = labels.length ? labels[labels.length - 1].order + 1 : 0;
  const label: Label = { id, name: cleanLabelName(name), color: kanbanColor(color ?? nextLabelColor(labels), LABEL_DEFAULT_COLOR)!, order };
  write(store, () => store.labels.set(id, label));
  return store.labels.has(id) ? id : null;
}

/** Writes one label whole, with the patch applied. Nothing for an unknown label or an empty name. */
function patchLabel(store: Store, id: Id, patch: Partial<Pick<Label, 'name' | 'color' | 'order'>>): boolean {
  const cur = validLabel(store.labels.get(id));
  if (!cur) return false;
  const next: Label = { ...cur };
  if (patch.name !== undefined) {
    const name = cleanLabelName(patch.name);
    if (!name) return false;
    next.name = name;
  }
  if (patch.color !== undefined) next.color = kanbanColor(patch.color, LABEL_DEFAULT_COLOR)!;
  if (patch.order !== undefined && Number.isFinite(patch.order)) next.order = patch.order;
  if (next.name === cur.name && next.color === cur.color && next.order === cur.order) return false;
  return write(store, () => store.labels.set(id, next));
}

export const renameLabel = (store: Store, id: Id, name: string) => patchLabel(store, id, { name });
export const recolorLabel = (store: Store, id: Id, color: string) => patchLabel(store, id, { color });

/**
 * The order values that move one label up or down a place. Only the moving label is written when the gap allows it
 * (halfway between its new neighbours), so a move touches one label and cannot overwrite someone's rename of another;
 * when two labels share an order every label gets a fresh one.
 */
export function planLabelMove(labels: Label[], id: Id, dir: -1 | 1): { id: Id; order: number }[] {
  const list = sortLabels(labels);
  const i = list.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [];
  const rest = list.filter((l) => l.id !== id);
  // its new index in the list is j, which is also where it goes among the others
  const at = j;
  const prev = rest[at - 1];
  const next = rest[at];
  const lo = prev ? prev.order : next.order - 2;
  const hi = next ? next.order : prev.order + 2;
  const mid = (lo + hi) / 2;
  if (lo < mid && mid < hi) return [{ id, order: mid }];
  const order = [...rest.slice(0, at), list[i], ...rest.slice(at)];
  return order.map((l, k) => ({ id: l.id, order: k })).filter((p, k) => order[k].order !== p.order);
}

/** Moves a label one place up (-1) or down (1) in the board's order: one undo step. */
export function moveLabel(store: Store, id: Id, dir: -1 | 1): boolean {
  const plan = planLabelMove(listLabels(store), id, dir);
  if (!plan.length || store.readOnly) return false;
  return write(store, () => {
    for (const p of plan) {
      const cur = validLabel(store.labels.get(p.id));
      if (cur) store.labels.set(p.id, { ...cur, order: p.order });
    }
  });
}

/** Removes a label from the board. Cards keep the id, draw nothing for it and drop it on their next edit. */
export function deleteLabel(store: Store, id: Id): boolean {
  if (!store.labels.has(id)) return false;
  return write(store, () => store.labels.delete(id));
}

/**
 * A card's label ids as they are written: known labels only (the spec's "the next edit of a card drops unknown ids"),
 * each once, in the order given, at most 10.
 */
export function cleanCardLabels(ids: readonly unknown[] | undefined, known: ReadonlySet<Id>): Id[] {
  const out: Id[] = [];
  for (const id of ids ?? []) {
    if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
    if (out.length >= LIMITS.labelsPerCard) break;
  }
  return out;
}

/** The card's labels with one label switched on or off; null when switching it on would pass the per-card limit. */
export function toggleCardLabel(ids: readonly unknown[] | undefined, id: Id, known: ReadonlySet<Id>): Id[] | null {
  const cur = cleanCardLabels(ids, known);
  if (cur.includes(id)) return cur.filter((x) => x !== id);
  if (!known.has(id)) return cur;
  if (cur.length >= LIMITS.labelsPerCard) return null;
  return [...cur, id];
}

/**
 * A template's labels merged by name into the board's (docs/kanban.md, Templates): a board label with the same name
 * (ignoring case) wins, a missing one is added at the end while the board has room for it. It writes without a
 * transaction of its own, so call it inside the one that adds the template (one undo step). Returns the board label id
 * for each template label id that has one; cards drop the others.
 */
export function mergeTemplateLabels(store: Store, labels: readonly { id: string; name: string; color: string }[]): Map<string, Id> {
  const out = new Map<string, Id>();
  if (!labels.length || store.readOnly) return out;
  const board = listLabels(store);
  const byName = new Map(board.map((l) => [l.name.toLowerCase(), l.id]));
  let order = board.length ? board[board.length - 1].order + 1 : 0;
  let count = board.length;
  for (const l of labels) {
    const name = cleanLabelName(l.name);
    if (!name) continue;
    const have = byName.get(name.toLowerCase());
    if (have) {
      out.set(l.id, have);
      continue;
    }
    if (count >= LIMITS.labels) continue;
    const id = newId();
    store.labels.set(id, { id, name, color: kanbanColor(l.color, LABEL_DEFAULT_COLOR)!, order: order++ });
    byName.set(name.toLowerCase(), id);
    out.set(l.id, id);
    count++;
  }
  return out;
}
