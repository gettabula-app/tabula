import type { BaseObj, ConnectorObj, End, Id, Obj, Point } from './types';
import { center } from './geometry';
import { isBox, isConnector } from './types';

export type FlipAxis = 'horizontal' | 'vertical';

export interface FlipPatch {
  id: Id;
  patch: Partial<BaseObj> | Partial<ConnectorObj>;
}

const TAU = Math.PI * 2;
const FLIPPABLE_TYPES = new Set([
  'shape', 'icon', 'image', 'path',
  'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package',
  'uml-state', 'uml-initial', 'uml-final', 'uml-component',
]);
const UNSUPPORTED_TYPES = new Set(['frame', 'container', 'lane', 'card']);

/** Normalize to the app's -π…π rotation range, keeping the sign of the 180° endpoint. */
export function normalizeRotation(angle: number): number {
  if (angle >= -Math.PI && angle <= Math.PI) return angle === 0 ? 0 : angle;
  let result = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
  if (Math.abs(result + Math.PI) < 1e-12 && angle > 0) result = Math.PI;
  return Math.abs(result) < 1e-12 ? 0 : result;
}

export function mirrorPoint(point: Point, axis: FlipAxis, about: Point): Point {
  return axis === 'horizontal'
    ? { x: about.x * 2 - point.x, y: point.y }
    : { x: point.x, y: about.y * 2 - point.y };
}

export function flipDisabledReason(selection: readonly Obj[], leaves: readonly Obj[], readOnly = false): string | null {
  if (readOnly) return 'This board is read-only.';
  if (!selection.length) return 'Select an item to flip.';
  if (leaves.some((o) => UNSUPPORTED_TYPES.has(o.type))) return "Frames, containers, lanes and cards can't be flipped.";
  if (selection.length === 1 && (selection[0].type === 'sticky' || selection[0].type === 'text')) {
    return "Notes and text can't be flipped";
  }
  if (!leaves.length) return 'No unlocked items to flip.';
  const hasMovableBox = leaves.some((o) => isBox(o) && !UNSUPPORTED_TYPES.has(o.type));
  const hasFreeConnector = leaves.some((o) => isConnector(o) && (o.from.kind === 'free' || o.to.kind === 'free'));
  if (!hasMovableBox && !hasFreeConnector) return 'Select an item with flippable content.';
  return null;
}

function flippedEnd(end: End, axis: FlipAxis, about: Point, flipIds: ReadonlySet<Id>): End {
  if (end.kind === 'free') return { ...mirrorPoint(end, axis, about), kind: 'free' };
  if (!flipIds.has(end.id) || end.anchor === 'auto') return end;
  const anchor = axis === 'horizontal'
    ? end.anchor === 'left' ? 'right' : end.anchor === 'right' ? 'left' : end.anchor
    : end.anchor === 'top' ? 'bottom' : end.anchor === 'bottom' ? 'top' : end.anchor;
  return { ...end, anchor };
}

/**
 * Plans the box and connector writes for one screen-space mirror. `participants` are the unlocked selected leaves;
 * `connectors` are all visible unlocked connectors, including those attached between selected boxes.
 */
export function planFlip(
  participants: readonly Obj[],
  connectors: readonly ConnectorObj[],
  axis: FlipAxis,
  about: Point,
): FlipPatch[] {
  const selectedBoxes = participants.filter(isBox);
  const flipIds = new Set(selectedBoxes.map((o) => o.id));
  const explicitConnectors = new Set(participants.filter(isConnector).map((o) => o.id));
  const boxCount = selectedBoxes.length;
  const patches: FlipPatch[] = [];

  for (const o of selectedBoxes) {
    const c = center(o);
    const next = mirrorPoint(c, axis, about);
    const patch: Partial<BaseObj> = {
      x: o.x + next.x - c.x,
      y: o.y + next.y - c.y,
      rotation: normalizeRotation(-(o.rotation || 0)),
    };
    if (FLIPPABLE_TYPES.has(o.type)) {
      if (axis === 'horizontal') patch.flipX = o.flipX === true ? undefined : true;
      else patch.flipY = o.flipY === true ? undefined : true;
    }
    patches.push({ id: o.id, patch });
  }

  for (const c of connectors) {
    const explicit = explicitConnectors.has(c.id);
    const bothBoundObjectsMove = c.from.kind === 'bound' && c.to.kind === 'bound' &&
      flipIds.has(c.from.id) && flipIds.has(c.to.id) && (boxCount > 1 || explicit);
    const from = explicit || bothBoundObjectsMove ? flippedEnd(c.from, axis, about, bothBoundObjectsMove ? flipIds : new Set()) : c.from;
    const to = explicit || bothBoundObjectsMove ? flippedEnd(c.to, axis, about, bothBoundObjectsMove ? flipIds : new Set()) : c.to;
    if (from !== c.from || to !== c.to) patches.push({ id: c.id, patch: { from, to } });
  }

  return patches;
}

export const isFlippableType = (type: Obj['type']): boolean => FLIPPABLE_TYPES.has(type);
export const isUnsupportedFlipType = (type: Obj['type']): boolean => UNSUPPORTED_TYPES.has(type);
