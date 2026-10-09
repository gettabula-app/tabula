// A stored object in a shape the markup can trust (TAB-203). Board objects are Yjs data that any collaborator, file,
// template or tool can write, and much of each one ends up in SVG attributes on the canvas and in exported files: an
// exported SVG opened on its own has no CSP, so a stored `viewBox` of `0" onload="…` would run there. Everything that
// draws an object (src/markup.ts, the renderer's overlays, exports, thumbnails) reads it through `safeObj`: numbers are
// finite numbers, enumerations are one of their values, text is a string, a connector end is a free point or a bound id
// with a known anchor. What does not fit is dropped (the type's default applies) or replaced by a neutral value. Colours
// are left to `styleOf` (shared/colors.mjs), which knows each type's default.

import type { Obj } from './types';
import { HEADS, SHAPE_KINDS } from './shapes';
import { RELATIONS } from './uml';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const KINDS = new Set<string>(SHAPE_KINDS.map((k) => k.kind));
const HEAD_SET = new Set<string>(HEADS.map((h) => h.head));
const ROUTES = new Set(['straight', 'elbow', 'curved']);
const DASHES = new Set(['solid', 'dashed', 'dotted']);
const ALIGNS = new Set(['left', 'center', 'right']);
const VALIGNS = new Set(['top', 'middle', 'bottom']);
const ANCHORS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const STAGES = new Set(['todo', 'doing', 'done']);
const WIP_MODES = new Set(['warn', 'block']);
const VISIBILITY = new Set(['+', '-', '#', '~', '']);
/** Every enumerated object field and its values; the template file check (src/custom-templates.ts) uses it too. */
export const OBJ_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  kind: KINDS, route: ROUTES, startHead: HEAD_SET, endHead: HEAD_SET, dash: DASHES, align: ALIGNS, valign: VALIGNS,
  stage: STAGES, wipMode: WIP_MODES, relation: new Set(Object.keys(RELATIONS)),
};

/** A font is a Fontshare slug or `system`; it is used in a font-family attribute and a CSS font shorthand. */
const FONT_RE = /^[a-z0-9-]{1,64}$/;

/** Fields that every box has: a non-finite value becomes 0. */
const REQUIRED_NUMBERS = ['x', 'y', 'w', 'h', 'rotation'];
/** Optional numbers: a non-finite value is dropped, so the default applies. */
const OPTIONAL_NUMBERS = ['strokeWidth', 'opacity', 'fontSize', 'fontWeight', 'nw', 'nh', 'laneW', 'wip', 'updatedAt'];
/** Free text, drawn only as escaped text content or an escaped attribute: anything but a string is dropped. */
const TEXTS = ['text', 'name', 'label', 'stereotype', 'alt', 'desc', 'ownerName', 'ownerId', 'due', 'body', 'ref', 'asset', 'mime', 'parent', 'layout', 'rank', 'createdBy', 'privateStep', 'z'];
/** Enumerations and their sets: a value outside the set is dropped. */
const ENUMS: [string, Set<string>][] = [
  ['dash', DASHES], ['align', ALIGNS], ['valign', VALIGNS], ['stage', STAGES], ['wipMode', WIP_MODES],
  ['relation', new Set(Object.keys(RELATIONS))],
];

function end(e: unknown): { kind: 'free'; x: number; y: number } | { kind: 'bound'; id: string; anchor: 'auto' | 'top' | 'right' | 'bottom' | 'left' } {
  const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  if (r.kind === 'bound' && typeof r.id === 'string') {
    return { kind: 'bound', id: r.id, anchor: (typeof r.anchor === 'string' && ANCHORS.has(r.anchor) ? r.anchor : 'auto') as 'auto' };
  }
  return { kind: 'free', x: finite(r.x) ? r.x : 0, y: finite(r.y) ? r.y : 0 };
}

function members(v: unknown) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m) => m && typeof m === 'object')
    .map((m: Record<string, unknown>) => ({
      visibility: typeof m.visibility === 'string' && VISIBILITY.has(m.visibility) ? m.visibility : '',
      name: typeof m.name === 'string' ? m.name : '',
      type: typeof m.type === 'string' ? m.type : '',
      ...(m.isStatic === true ? { isStatic: true } : {}),
      ...(m.isAbstract === true ? { isAbstract: true } : {}),
    }));
}

/**
 * `o` with every field the markup reads in a type-safe form (see the top of this file). A fresh shallow copy each time
 * (not memoised: some callers build an object and change it before drawing it again).
 */
export function safeObj<T extends Obj>(o: T): T {
  if (!o || typeof o !== 'object') return o;
  const out = { ...o } as Record<string, unknown>;
  out.id = typeof o.id === 'string' ? o.id : String(o.id ?? '');
  if (o.type === 'connector') {
    out.from = end(out.from);
    out.to = end(out.to);
    out.route = typeof out.route === 'string' && ROUTES.has(out.route) ? out.route : 'straight';
    for (const k of ['startHead', 'endHead']) out[k] = typeof out[k] === 'string' && HEAD_SET.has(out[k] as string) ? out[k] : 'none';
  } else {
    for (const k of REQUIRED_NUMBERS) out[k] = finite(out[k]) ? out[k] : 0;
  }
  if (o.type === 'connector') for (const k of REQUIRED_NUMBERS) if (k in out && !finite(out[k])) delete out[k];
  for (const k of OPTIONAL_NUMBERS) if (k in out && !finite(out[k])) delete out[k];
  for (const k of TEXTS) if (k in out && typeof out[k] !== 'string') delete out[k];
  for (const [k, set] of ENUMS) if (k in out && !(typeof out[k] === 'string' && set.has(out[k] as string))) delete out[k];
  if ('kind' in out && !(typeof out.kind === 'string' && KINDS.has(out.kind))) out.kind = 'rect';
  if ('font' in out && !(typeof out.font === 'string' && FONT_RE.test(out.font))) delete out.font;
  if ('points' in out) out.points = Array.isArray(out.points) && out.points.every(finite) ? out.points : [];
  if ('viewBox' in out && !(Array.isArray(out.viewBox) && out.viewBox.length === 4 && out.viewBox.every(finite))) delete out.viewBox;
  if ('attributes' in out) out.attributes = members(out.attributes);
  if ('operations' in out) out.operations = members(out.operations);
  if ('labels' in out && !(Array.isArray(out.labels) && out.labels.every((l) => typeof l === 'string'))) delete out.labels;
  for (const k of ['locked', 'sticker']) if (k in out && typeof out[k] !== 'boolean') delete out[k];
  return out as unknown as T;
}
