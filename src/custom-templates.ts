// Custom templates: a saved snapshot of objects and session steps, stored as data.
// Everything here is pure (no DOM, no Yjs) so it runs in the browser, the server and tests.

import type { End, Id, Obj, ObjType, Point, Rect, Step, StepMode } from './types';
import { isBox, isConnector } from './types';
import { boxBounds, center, rectOfPoints } from './geometry';
import { sanitizeSvgBody } from './markup';
import { newId } from './store';

export const MAX_TEMPLATE_OBJECTS = 2000;
export const MAX_TEMPLATE_BYTES = 1_000_000;

export interface TemplateContent {
  objects: Obj[];
  steps: Step[];
  bounds: Rect;
  fonts?: { heading: string; body: string };
}

export type TemplateScope = 'personal' | 'team' | 'workspace';

export interface CustomTemplate {
  id: string;
  version: 1;
  name: string;
  category: string;
  description: string;
  content: TemplateContent;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Accounts mode only: who the template is shared with. Templates kept in the browser have none of these. */
  scope?: TemplateScope;
  teamId?: string | null;
  teamName?: string | null;
  ownerName?: string | null;
  /** Whether the person may rename, edit and delete it; absent means yes. */
  canChange?: boolean;
}

/**
 * Copies of `objs` with new ids from `idMap`, shifted by `offset`. Bound connector ends
 * and parents that point outside the list are dealt with as insertObjects always has:
 * a connector end becomes a free end at `resolveOutside(id)` (the origin when that is
 * null), a parent is dropped. Session-private marks are removed. z and createdBy are
 * left for the caller to set.
 */
export function remapObjects(
  objs: Obj[],
  idMap: Map<Id, Id>,
  offset: Point,
  resolveOutside: (id: Id) => Point | null,
): Obj[] {
  return objs.map((o) => {
    const c = structuredClone(o) as Obj;
    c.id = idMap.get(o.id)!;
    if (isConnector(c)) {
      const fix = (e: End): End => {
        if (e.kind === 'free') return { kind: 'free', x: e.x + offset.x, y: e.y + offset.y };
        const nid = idMap.get(e.id);
        if (nid) return { ...e, id: nid };
        const pt = resolveOutside(e.id) ?? { x: 0, y: 0 };
        return { kind: 'free', x: pt.x + offset.x, y: pt.y + offset.y };
      };
      c.from = fix(c.from);
      c.to = fix(c.to);
    } else {
      c.x += offset.x;
      c.y += offset.y;
      c.parent = c.parent ? idMap.get(c.parent) : undefined;
      delete c.privateStep;
    }
    return c;
  });
}

export interface ToTemplateOptions {
  fonts?: { heading: string; body: string };
  /** Keep session steps that have no frame (steps tied to a saved frame are always kept). */
  includeSteps: boolean;
  /** Frames whose steps may be kept; defaults to every object in the selection. */
  frameIds?: Set<Id>;
}

/**
 * Normalise a gathered selection into template content. `objs` must already hold
 * frame children and inner connectors (BoardApp.gather) in paint order; that order
 * becomes the z order. `lookup` finds objects outside the selection, so connector ends
 * that point at them become free ends at the target's centre. Poll and one-click
 * (quick) steps are not saved, since the poll itself is not part of a template.
 */
export function toTemplateContent(
  objs: Obj[],
  steps: Step[],
  opts: ToTemplateOptions,
  lookup?: (id: Id) => Obj | undefined,
): TemplateContent {
  const idMap = new Map<Id, Id>();
  objs.forEach((o, i) => idMap.set(o.id, `o${i + 1}`));
  const resolveOutside = (id: Id): Point | null => {
    const src = lookup?.(id);
    return src && isBox(src) ? center(src) : null;
  };

  const pts: Point[] = [];
  for (const o of objs) {
    if (isConnector(o)) {
      for (const e of [o.from, o.to]) {
        if (e.kind === 'free') pts.push({ x: e.x, y: e.y });
        else if (!idMap.has(e.id)) {
          // An end whose target no longer exists has no position worth fitting the bounds to.
          const pt = resolveOutside(e.id);
          if (pt) pts.push(pt);
        }
      }
    } else {
      const b = boxBounds(o);
      pts.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h });
    }
  }
  const b = rectOfPoints(pts);

  const digits = String(objs.length).length;
  const objects = remapObjects(objs, idMap, { x: -b.x, y: -b.y }, resolveOutside).map((o, i) => {
    delete o.locked;
    delete o.createdBy;
    delete o.updatedAt;
    if (o.parent === undefined) delete o.parent;
    o.z = String(i + 1).padStart(digits, '0');
    return o;
  });

  const frames = opts.frameIds ?? new Set(idMap.keys());
  const kept = steps.filter((s) => {
    if (s.quick || s.pollId) return false;
    return s.frameId ? frames.has(s.frameId) && idMap.has(s.frameId) : opts.includeSteps;
  });
  const outSteps = kept.map((s, i): Step => {
    const c: Step = { ...s, id: `s${i + 1}` };
    if (s.frameId) c.frameId = idMap.get(s.frameId);
    return c;
  });

  return {
    objects,
    steps: outSteps,
    bounds: { x: 0, y: 0, w: b.w, h: b.h },
    ...(opts.fonts ? { fonts: { heading: opts.fonts.heading, body: opts.fonts.body } } : {}),
  };
}

/** Fresh objects and steps from template content, with its top-left corner at `origin`. z is left to the caller. */
export function instantiate(content: TemplateContent, origin: Point, userId: string): { objects: Obj[]; steps: Step[] } {
  const idMap = new Map<Id, Id>();
  for (const o of content.objects) idMap.set(o.id, newId());
  const objects = remapObjects(content.objects, idMap, origin, () => null);
  for (const o of objects) o.createdBy = userId;
  const steps = content.steps.map((s): Step => {
    const c: Step = { ...s, id: newId() };
    const frameId = s.frameId ? idMap.get(s.frameId) : undefined;
    if (frameId) c.frameId = frameId;
    else delete c.frameId;
    return c;
  });
  return { objects, steps };
}

const OBJ_TYPES: Record<ObjType, true> = {
  shape: true, sticky: true, text: true, frame: true, icon: true, path: true, connector: true,
  'uml-class': true, 'uml-actor': true, 'uml-usecase': true, 'uml-lifeline': true, 'uml-note': true,
  'uml-package': true, 'uml-state': true, 'uml-initial': true, 'uml-final': true, 'uml-component': true,
};
const TYPE_NAMES = new Set<string>(Object.keys(OBJ_TYPES));

const STEP_MODES: Record<StepMode, true> = {
  write: true, 'private-write': true, cluster: true, vote: true, discuss: true, poll: true,
};
const MODE_NAMES = new Set<string>(Object.keys(STEP_MODES));

function fail(message: string): never {
  throw new Error(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check untrusted template content (from a file or a client) and return a safe copy. Throws a readable Error. */
export function validateContent(c: unknown): TemplateContent {
  if (!isRecord(c)) fail('Template content must be an object.');
  const { objects: list, steps, bounds, fonts } = c;
  if (!Array.isArray(list)) fail('Template content needs a list of objects.');
  if (list.length > MAX_TEMPLATE_OBJECTS) {
    fail(`A template can hold at most ${MAX_TEMPLATE_OBJECTS} objects; this one has ${list.length}.`);
  }
  let json: string;
  try {
    json = JSON.stringify(c);
  } catch {
    return fail('Template content is not valid JSON data.');
  }
  if (new TextEncoder().encode(json).byteLength > MAX_TEMPLATE_BYTES) {
    fail(`A template can be at most ${MAX_TEMPLATE_BYTES / 1_000_000} MB of data.`);
  }

  const ids = new Set<Id>();
  for (const [i, o] of list.entries()) {
    if (!isRecord(o)) fail(`Object ${i + 1} is not an object.`);
    if (typeof o.id !== 'string' || !o.id) fail(`Object ${i + 1} has no id.`);
    if (ids.has(o.id)) fail(`Two objects share the id "${o.id}".`);
    ids.add(o.id);
    if (typeof o.type !== 'string' || !TYPE_NAMES.has(o.type)) fail(`Object "${o.id}" has an unknown type.`);
    if (typeof o.z !== 'string') fail(`Object "${o.id}" has no z order.`);
  }

  const known = (id: unknown) => typeof id === 'string' && ids.has(id);
  const objects = list.map((o: Record<string, unknown>) => {
    if (o.type === 'connector') {
      for (const side of ['from', 'to'] as const) {
        const e = o[side];
        if (!isRecord(e)) fail(`Connector "${o.id}" is missing its ${side} end.`);
        if (e.kind === 'free') {
          if (!isNum(e.x) || !isNum(e.y)) fail(`Connector "${o.id}" has a ${side} end without a position.`);
        } else if (e.kind === 'bound') {
          if (!known(e.id)) fail(`Connector "${o.id}" is attached to a missing object.`);
        } else {
          fail(`Connector "${o.id}" has an invalid ${side} end.`);
        }
      }
      return o;
    }
    if (!isNum(o.x) || !isNum(o.y) || !isNum(o.w) || !isNum(o.h)) fail(`Object "${o.id}" has an invalid position or size.`);
    if (o.parent !== undefined && !known(o.parent)) fail(`Object "${o.id}" has a parent that is not in the template.`);
    if (o.type === 'icon' && o.body !== undefined) {
      if (typeof o.body !== 'string') fail(`Icon "${o.id}" has an invalid body.`);
      return { ...o, body: sanitizeSvgBody(o.body) };
    }
    return o;
  });

  if (!Array.isArray(steps)) fail('Template content needs a list of steps.');
  const stepIds = new Set<Id>();
  for (const [i, s] of steps.entries()) {
    if (!isRecord(s)) fail(`Step ${i + 1} is not an object.`);
    if (typeof s.id !== 'string' || !s.id) fail(`Step ${i + 1} has no id.`);
    if (stepIds.has(s.id)) fail(`Two steps share the id "${s.id}".`);
    stepIds.add(s.id);
    if (typeof s.title !== 'string' || typeof s.instructions !== 'string') fail(`Step ${i + 1} needs a title and instructions.`);
    if (typeof s.mode !== 'string' || !MODE_NAMES.has(s.mode)) fail(`Step ${i + 1} has an unknown mode.`);
    if (s.pollId !== undefined) fail(`Step ${i + 1} refers to a poll, which a template cannot hold.`);
    if (s.frameId !== undefined && !known(s.frameId)) fail(`Step ${i + 1} points at a frame that is not in the template.`);
  }

  if (!isRecord(bounds) || !isNum(bounds.x) || !isNum(bounds.y) || !isNum(bounds.w) || !isNum(bounds.h)) {
    fail('Template content needs bounds.');
  }
  if (fonts !== undefined && (!isRecord(fonts) || typeof fonts.heading !== 'string' || typeof fonts.body !== 'string')) {
    fail('Template fonts must name a heading and a body font.');
  }

  return {
    objects: objects as unknown as Obj[],
    steps: steps as unknown as Step[],
    bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    ...(isRecord(fonts) ? { fonts: { heading: fonts.heading as string, body: fonts.body as string } } : {}),
  };
}
