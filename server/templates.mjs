// Custom templates on the server (docs/custom-templates.md): the directory migration, every template query and the
// validator that decides what is stored. A template is data this server keeps and hands to other people's browsers,
// so everything that comes in is rebuilt field by field from what is accepted, never stored as it arrived.
// The SQL lives here so directory.mjs only registers it (a migration entry and one spread).
// This file does not touch the file system (a test keeps it that way, like tokens.mjs and board-ops.mjs).

import crypto from 'node:crypto';
import { DASHES, HEADS, OBJ_TYPES, ROUTES, SHAPE_KINDS, SIDES } from './board-ops.mjs';

// the built-in categories (CATEGORIES in src/templates.ts) and CUSTOM_CATEGORY; a test keeps them equal
export const TEMPLATE_CATEGORIES = [
  'Retrospective', 'Ideation', 'Discussion', 'Prioritisation', 'Planning', 'Discovery', 'Strategy', 'Risk', 'Custom',
];
export const TEMPLATE_SCOPES = ['personal', 'team', 'workspace'];
// the object types of ObjType in src/types.ts (a test keeps them equal), and the relations of UmlRelation
// not 'image': a template is copied to boards that cannot read another board's assets (docs/images.md, Templates)
export const TEMPLATE_OBJ_TYPES = OBJ_TYPES.filter((t) => t !== 'image');
export const TEMPLATE_RELATIONS = [
  'association', 'directed', 'generalization', 'realization', 'dependency', 'aggregation', 'composition', 'message',
  'async', 'reply', 'include', 'extend', 'transition',
];
// the modes of StepMode in src/types.ts but 'poll', which a template cannot hold (a test keeps them equal)
export const TEMPLATE_STEP_MODES = ['write', 'private-write', 'cluster', 'vote', 'discuss'];

export const MAX_TEMPLATE_OBJECTS = 2000;
export const MAX_TEMPLATE_STEPS = 100;
export const MAX_TEMPLATE_BYTES = 1_000_000;
export const MAX_SVG_BODY = 100_000;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 280;
export const MAX_TEMPLATES_PER_OWNER = 200;
/** The request body of the template routes: the content (1 MB) plus the few small fields around it. */
export const TEMPLATE_BODY_LIMIT = 1024 * 1024;

export const TEMPLATES_MIGRATION = `
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace')),
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    object_count INTEGER NOT NULL,
    step_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    CHECK ((scope = 'team') = (team_id IS NOT NULL))
  );
  CREATE INDEX templates_owner ON templates(owner_id);
  CREATE INDEX templates_team ON templates(team_id);
`;

/** A template that cannot be stored; the message is meant for the person who sent it and never repeats what they sent. */
export class TemplateInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateInputError';
  }
}

const fail = (message) => {
  throw new TemplateInputError(message);
};
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- SVG bodies

// Icons and stickers carry their SVG inline in `body`. Anything that is not plain drawing is refused rather than
// cleaned: the list of elements is an allow-list, scripts and external references have no way in, and markup the
// checker cannot read as a plain tag is a refusal, since a browser might read it differently.
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'title', 'desc', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))?)*)\s*(\/?)>/y;
const ATTR_RE = /\s+([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
// Character classes by code point, not by regular expression (as in board-ops.mjs).
const isSvgControl = (cp) => cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
// whitespace, control and invisible characters a browser ignores inside a URL scheme
const isUrlNoise = (cp) =>
  cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0x1680 || cp === 0x180e || (cp >= 0x2000 && cp <= 0x200f) ||
  (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0x3000 || cp === 0xfeff;
const without = (value, drop) => {
  let out = '';
  for (const ch of value) if (!drop(ch.codePointAt(0))) out += ch;
  return out;
};
const RASTER_DATA_RE = /^data:image\/(png|jpeg|gif|webp)[;,]/;
const BLOCKED_ATTRIBUTES = new Set(['xml:base', 'srcdoc', 'formaction', 'action', 'poster', 'ping']);

const decodeBasic = (v) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);

function attributeProblem(element, name, rawValue) {
  const lname = name.toLowerCase();
  if (lname.startsWith('on')) return `has an event handler (${name.slice(0, 30)})`;
  if (BLOCKED_ATTRIBUTES.has(lname)) return `has the ${name.slice(0, 30)} attribute`;
  const value = decodeBasic(rawValue);
  if (value.includes('\\')) return 'has a backslash in an attribute';
  const flat = without(value, isUrlNoise).toLowerCase();
  if (lname === 'xmlns' || lname.startsWith('xmlns:')) {
    return value === SVG_NS || value === XLINK_NS ? null : 'declares a namespace other than SVG';
  }
  const local = lname.slice(lname.lastIndexOf(':') + 1);
  if (local === 'href' || local === 'src') {
    if (flat.startsWith('#')) return null;
    if (element !== 'use' && RASTER_DATA_RE.test(flat)) return null;
    return element === 'use'
      ? 'has a <use> that points outside the icon'
      : 'has a link that is not a reference inside the icon or an inline png, jpeg, gif or webp image';
  }
  if (flat.includes('javascript:') || flat.includes('vbscript:') || flat.includes('data:')) return 'has a script or data address in an attribute';
  if (lname === 'style' && /@import|expression|behavior|binding/.test(flat)) return 'has a style that loads or runs something';
  // mask, cursor and the like take CSS images, which can name an address without url()
  if (/(image-set|image|cross-fade|element|paint|src)\(/.test(flat)) return 'has a CSS image function that could load something from outside';
  for (const m of flat.matchAll(/url\(([^)]*)\)/g)) {
    if (!m[1].replace(/^['"]/, '').startsWith('#')) return 'has a url() that points outside the icon';
  }
  return null;
}

/** Why an SVG body is refused, or null when it is plain drawing. */
export function svgProblem(body) {
  if (typeof body !== 'string') return 'is not text';
  if (body.length > MAX_SVG_BODY) return `is longer than ${MAX_SVG_BODY.toLocaleString('en-US')} characters`;
  for (const ch of body) if (isSvgControl(ch.codePointAt(0))) return 'has control characters';
  if (/<[!?]/.test(body)) return 'has a comment, CDATA section, DOCTYPE or processing instruction';
  if (/&#/.test(body) || /&(?!(?:amp|lt|gt|quot|apos);)/.test(body)) return 'has character references other than &amp; &lt; &gt; &quot; and &apos;';
  const stack = [];
  let at = 0;
  while (at < body.length) {
    const lt = body.indexOf('<', at);
    const between = body.slice(at, lt === -1 ? body.length : lt);
    if (between.includes('>')) return 'has a stray ">"';
    if (lt === -1) break;
    TAG_RE.lastIndex = lt;
    const tag = TAG_RE.exec(body);
    if (!tag) return 'has markup that is not a plain SVG tag';
    at = TAG_RE.lastIndex;
    const [, closing, element, attributes, selfClosing] = tag;
    if (!SVG_ELEMENTS.has(element)) return `uses <${element.slice(0, 30)}>, which an icon cannot contain`;
    if (closing) {
      if (attributes.trim() || selfClosing || stack.pop() !== element) return 'has tags that do not match';
      continue;
    }
    const seen = new Set();
    for (const attr of attributes.matchAll(ATTR_RE)) {
      const key = attr[1].toLowerCase();
      if (seen.has(key)) return `repeats the ${attr[1].slice(0, 30)} attribute`;
      seen.add(key);
      const problem = attributeProblem(element, attr[1], attr[2] ?? attr[3] ?? '');
      if (problem) return problem;
    }
    if (!selfClosing) stack.push(element);
  }
  return stack.length ? 'has a tag that is not closed' : null;
}

// ---------------------------------------------------------------- content

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FONT_RE = /^[A-Za-z0-9 _-]{1,64}$/;
// colours as the board writes them: #hex, none, var(--x, #hex), rgb(), hsl() and the like; never url(), never markup
const PAINT_RE = /^[A-Za-z0-9#%().,\s_/-]{1,100}$/;
const PAINT_DENIED_RE = /url\s*\(|image\s*\(|image-set|cross-fade|element\s*\(|paint\s*\(|expression|javascript|;/i;
const LINE_CONTROL_RE = /\p{Cc}/u;
// control characters but tab, line feed and carriage return
const hasTextControl = (v) => {
  for (const ch of v) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
};
const ALIGNS = ['left', 'center', 'right'];
const VALIGNS = ['top', 'middle', 'bottom'];
const VISIBILITIES = ['+', '-', '#', '~', ''];
const COORD = 1_000_000;
const MAX_TEXT = 20_000;
const MAX_POINTS = 100_000;
const MAX_MEMBERS = 200;

function number(v, what, min, max) {
  if (!finite(v) || v < min || v > max) fail(`${what} must be a number from ${min} to ${max}.`);
  return v;
}

function text(v, what, max, { lines = false, min = 0 } = {}) {
  if (typeof v !== 'string' || v.length < min || v.length > max || (lines ? hasTextControl(v) : LINE_CONTROL_RE.test(v))) {
    fail(`${what} must be text of ${min === 0 ? 'at most' : `${min} to`} ${max} characters${lines ? '' : ', on one line'}.`);
  }
  return v;
}

function oneOf(v, list, what) {
  if (typeof v !== 'string' || !list.includes(v)) fail(`${what} is not one of ${list.join(', ')}.`);
  return v;
}

function paint(v, what) {
  if (typeof v !== 'string' || !PAINT_RE.test(v) || PAINT_DENIED_RE.test(v)) fail(`${what} is not a colour the board can draw.`);
  return v;
}

function member(m, what) {
  if (!isRecord(m)) fail(`${what} is not an object.`);
  const out = {
    visibility: oneOf(m.visibility ?? '', VISIBILITIES, `${what} visibility`),
    name: text(m.name, `${what} name`, 200),
    type: text(m.type ?? '', `${what} type`, 200),
  };
  if (m.isStatic !== undefined) out.isStatic = m.isStatic === true;
  if (m.isAbstract !== undefined) out.isAbstract = m.isAbstract === true;
  return out;
}

function members(list, what) {
  if (!Array.isArray(list) || list.length > MAX_MEMBERS) fail(`${what} must be a list of at most ${MAX_MEMBERS} items.`);
  return list.map((m, i) => member(m, `${what} ${i + 1}`));
}

function end(e, side, label, ids) {
  if (!isRecord(e)) fail(`${label} has no ${side} end.`);
  if (e.kind === 'free') return { kind: 'free', x: number(e.x, `${label} ${side} end x`, -COORD, COORD), y: number(e.y, `${label} ${side} end y`, -COORD, COORD) };
  if (e.kind === 'bound') {
    const target = typeof e.id === 'string' ? ids.get(e.id) : undefined;
    if (target === undefined) fail(`${label} is attached to an object that is not in the template.`);
    if (target === 'connector') fail(`${label} is attached to another connector.`);
    return { kind: 'bound', id: e.id, anchor: e.anchor === undefined ? 'auto' : oneOf(e.anchor, ['auto', ...SIDES], `${label} anchor`) };
  }
  return fail(`${label} has an invalid ${side} end.`);
}

function style(o, what, out, withFill = true) {
  if (withFill && o.fill !== undefined) out.fill = paint(o.fill, `${what} fill`);
  if (o.stroke !== undefined) out.stroke = paint(o.stroke, `${what} stroke`);
  if (o.strokeWidth !== undefined) out.strokeWidth = number(o.strokeWidth, `${what} strokeWidth`, 0, 100);
  if (o.dash !== undefined) out.dash = oneOf(o.dash, DASHES, `${what} dash`);
  if (o.opacity !== undefined) out.opacity = number(o.opacity, `${what} opacity`, 0, 1);
}

function box(o, what, ids) {
  const out = {
    id: o.id,
    type: o.type,
    x: number(o.x, `${what} x`, -COORD, COORD),
    y: number(o.y, `${what} y`, -COORD, COORD),
    w: number(o.w, `${what} width`, 0, COORD),
    h: number(o.h, `${what} height`, 0, COORD),
    rotation: o.rotation === undefined ? 0 : number(o.rotation, `${what} rotation`, -COORD, COORD),
    z: text(o.z, `${what} z order`, 64, { min: 1 }),
  };
  if (o.parent !== undefined) {
    if (typeof o.parent !== 'string' || ids.get(o.parent) !== 'frame') fail(`${what} has a parent that is not a frame in the template.`);
    out.parent = o.parent;
  }
  if (o.text !== undefined) out.text = text(o.text, `${what} text`, MAX_TEXT, { lines: true });
  style(o, what, out);
  if (o.font !== undefined) {
    if (typeof o.font !== 'string' || !FONT_RE.test(o.font)) fail(`${what} font is not a font name.`);
    out.font = o.font;
  }
  if (o.fontWeight !== undefined) out.fontWeight = number(o.fontWeight, `${what} fontWeight`, 1, 1000);
  if (o.fontSize !== undefined) out.fontSize = number(o.fontSize, `${what} fontSize`, 1, 1000);
  if (o.textColor !== undefined) out.textColor = paint(o.textColor, `${what} textColor`);
  if (o.align !== undefined) out.align = oneOf(o.align, ALIGNS, `${what} align`);
  if (o.valign !== undefined) out.valign = oneOf(o.valign, VALIGNS, `${what} valign`);

  switch (o.type) {
    case 'shape':
      if (o.kind !== undefined) out.kind = oneOf(o.kind, SHAPE_KINDS, `${what} kind`);
      break;
    case 'frame':
      if (o.name !== undefined) out.name = text(o.name, `${what} name`, 500, { lines: true });
      break;
    case 'icon': {
      if (o.ref !== undefined) out.ref = text(o.ref, `${what} ref`, 200);
      if (o.body !== undefined) {
        const problem = svgProblem(o.body);
        if (problem) fail(`${what} has an SVG body that is not allowed: it ${problem}.`);
        out.body = o.body;
      }
      if (o.viewBox !== undefined) {
        if (!Array.isArray(o.viewBox) || o.viewBox.length !== 4 || !o.viewBox.every((n) => finite(n) && Math.abs(n) <= COORD)) {
          fail(`${what} viewBox must be four numbers.`);
        }
        out.viewBox = [...o.viewBox];
      }
      if (o.sticker !== undefined) out.sticker = o.sticker === true;
      break;
    }
    case 'path':
      if (o.points !== undefined) {
        if (!Array.isArray(o.points) || o.points.length > MAX_POINTS || o.points.length % 2 !== 0 || !o.points.every((n) => finite(n) && Math.abs(n) <= COORD)) {
          fail(`${what} points must be an even list of up to ${MAX_POINTS} numbers.`);
        }
        out.points = [...o.points];
      }
      break;
    case 'uml-class':
      if (o.stereotype !== undefined) out.stereotype = text(o.stereotype, `${what} stereotype`, 200);
      if (o.attributes !== undefined) out.attributes = members(o.attributes, `${what} attribute`);
      if (o.operations !== undefined) out.operations = members(o.operations, `${what} operation`);
      break;
    default:
  }
  return out;
}

function connector(o, what, ids) {
  const out = {
    id: o.id,
    type: 'connector',
    z: text(o.z, `${what} z order`, 64, { min: 1 }),
    from: end(o.from, 'from', what, ids),
    to: end(o.to, 'to', what, ids),
    route: o.route === undefined ? 'elbow' : oneOf(o.route, ROUTES, `${what} route`),
    startHead: o.startHead === undefined ? 'none' : oneOf(o.startHead, HEADS, `${what} startHead`),
    endHead: o.endHead === undefined ? 'arrow' : oneOf(o.endHead, HEADS, `${what} endHead`),
  };
  if (o.relation !== undefined) out.relation = oneOf(o.relation, TEMPLATE_RELATIONS, `${what} relation`);
  if (o.label !== undefined) out.label = text(o.label, `${what} label`, 1000, { lines: true });
  style(o, what, out, false);
  return out;
}

function step(s, i, ids, seen) {
  const what = `Step ${i + 1}`;
  if (!isRecord(s)) fail(`${what} is not an object.`);
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) fail(`${what} needs an id of 1 to 64 letters, digits, - or _.`);
  if (seen.has(s.id)) fail('Two steps share an id.');
  seen.add(s.id);
  if (s.pollId !== undefined || s.mode === 'poll') fail(`${what} is a poll, which a template cannot hold.`);
  if (s.quick !== undefined) fail(`${what} is a quick step, which a template cannot hold.`);
  const out = {
    id: s.id,
    title: text(s.title, `${what} title`, 200, { lines: true }),
    instructions: text(s.instructions, `${what} instructions`, 2000, { lines: true }),
    mode: oneOf(s.mode, TEMPLATE_STEP_MODES, `${what} mode`),
  };
  if (s.frameId !== undefined) {
    if (typeof s.frameId !== 'string' || ids.get(s.frameId) === undefined || ids.get(s.frameId) === 'connector') {
      fail(`${what} points at a frame that is not in the template.`);
    }
    out.frameId = s.frameId;
  }
  if (s.durationSec !== undefined) out.durationSec = number(s.durationSec, `${what} durationSec`, 0, 86_400);
  if (s.votesPerPerson !== undefined) out.votesPerPerson = number(s.votesPerPerson, `${what} votesPerPerson`, 0, 1000);
  return out;
}

/**
 * The content of a template, checked and rebuilt. Returns a new object made only of the fields that are accepted, so
 * nothing else the sender included is stored. Throws TemplateInputError with a message for the sender.
 * @returns {{ content: any, json: string, objectCount: number, stepCount: number }}
 */
export function validateTemplateContent(raw) {
  if (!isRecord(raw)) fail('content must be an object.');
  const { objects: list, steps: stepList, bounds, fonts } = raw;
  if (!Array.isArray(list)) fail('content.objects must be a list.');
  if (list.length > MAX_TEMPLATE_OBJECTS) fail(`A template can hold at most ${MAX_TEMPLATE_OBJECTS} objects; this one has ${list.length}.`);
  if (!Array.isArray(stepList)) fail('content.steps must be a list.');
  if (stepList.length > MAX_TEMPLATE_STEPS) fail(`A template can hold at most ${MAX_TEMPLATE_STEPS} steps.`);

  const ids = new Map();
  list.forEach((o, i) => {
    if (!isRecord(o)) fail(`Object ${i + 1} is not an object.`);
    if (typeof o.id !== 'string' || !ID_RE.test(o.id)) fail(`Object ${i + 1} needs an id of 1 to 64 letters, digits, - or _.`);
    if (ids.has(o.id)) fail(`Object ${i + 1} shares its id with another object.`);
    if (typeof o.type !== 'string' || !TEMPLATE_OBJ_TYPES.includes(o.type)) fail(`Object ${i + 1} has an unknown type.`);
    ids.set(o.id, o.type);
  });

  const objects = list.map((o, i) => (o.type === 'connector' ? connector(o, `Object ${i + 1}`, ids) : box(o, `Object ${i + 1}`, ids)));

  // a parent chain that loops would never end for anything that walks up it
  const parents = new Map(objects.filter((o) => o.parent !== undefined).map((o) => [o.id, o.parent]));
  for (const start of parents.keys()) {
    let cursor = start;
    for (let hops = 0; cursor !== undefined; hops++) {
      cursor = parents.get(cursor);
      if (cursor === start || hops > parents.size) fail('Frames cannot be inside each other in a loop.');
    }
  }

  const seen = new Set();
  const steps = stepList.map((s, i) => step(s, i, ids, seen));

  if (!isRecord(bounds)) fail('content.bounds must be an object.');
  const content = {
    objects,
    steps,
    bounds: {
      x: number(bounds.x, 'bounds x', -COORD, COORD),
      y: number(bounds.y, 'bounds y', -COORD, COORD),
      w: number(bounds.w, 'bounds width', 0, COORD),
      h: number(bounds.h, 'bounds height', 0, COORD),
    },
  };
  if (fonts !== undefined) {
    if (!isRecord(fonts) || typeof fonts.heading !== 'string' || typeof fonts.body !== 'string' || !FONT_RE.test(fonts.heading) || !FONT_RE.test(fonts.body)) {
      fail('content.fonts must name a heading and a body font.');
    }
    content.fonts = { heading: fonts.heading, body: fonts.body };
  }
  const json = JSON.stringify(content);
  if (Buffer.byteLength(json) > MAX_TEMPLATE_BYTES) fail(`A template can be at most ${MAX_TEMPLATE_BYTES / 1_000_000} MB of data.`);
  return { content, json, objectCount: objects.length, stepCount: steps.length };
}

// ---------------------------------------------------------------- the fields around the content

const CREATE_FIELDS = ['name', 'category', 'description', 'scope', 'teamId', 'content'];
const ID_FIELD_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The body of POST (`create`) or PATCH /api/templates. Unknown fields are refused. Returns only what was given, with the
 * content validated and rebuilt; a create gets the defaults (personal, no description).
 * @param {Record<string, any>} body @param {{ create: boolean }} options
 * @returns {Record<string, any>}
 */
export function parseTemplateBody(body, { create }) {
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.includes(key)) fail(`Unknown field: ${key.slice(0, 40)}`);
  }
  const out = {};
  if (create || body.name !== undefined) out.name = text(typeof body.name === 'string' ? body.name.trim() : body.name, 'name', NAME_MAX, { min: 1 });
  if (create || body.category !== undefined) out.category = oneOf(body.category, TEMPLATE_CATEGORIES, 'category');
  if (body.description !== undefined) out.description = text(typeof body.description === 'string' ? body.description.trim() : body.description, 'description', DESCRIPTION_MAX, { lines: true });
  else if (create) out.description = '';
  if (body.scope !== undefined) out.scope = oneOf(body.scope, TEMPLATE_SCOPES, 'scope');
  else if (create) out.scope = 'personal';
  if (body.teamId !== undefined && body.teamId !== null) {
    if (typeof body.teamId !== 'string' || !ID_FIELD_RE.test(body.teamId)) fail('teamId must be an id.');
    out.teamId = body.teamId;
  }
  if (out.scope === 'team' && out.teamId === undefined) fail('teamId is required for a team template.');
  if (out.scope !== undefined && out.scope !== 'team' && out.teamId !== undefined) fail('teamId only applies to a team template.');
  if (create || body.content !== undefined) Object.assign(out, { validated: validateTemplateContent(body.content) });
  if (!create && Object.keys(out).length === 0) fail('Nothing to change.');
  return out;
}

// ---------------------------------------------------------------- queries

const newId = () => crypto.randomBytes(16).toString('base64url');
const SUFFIX = ' (copy)';
/** "<name> (copy)", with the name cut short so the whole stays within the name limit. */
export const copyName = (name) => `${name.slice(0, NAME_MAX - SUFFIX.length).trimEnd()}${SUFFIX}`;

const isAdmin = (user) => user.role === 'owner' || user.role === 'admin';

// A template row without its content, joined with the names a list shows and the caller's role in the template's team.
const SUMMARY_SELECT = `SELECT t.id, t.owner_id, t.scope, t.team_id, t.name, t.category, t.description, t.object_count, t.step_count,
    t.created_at, t.updated_at, u.name AS owner_name, tm.name AS team_name, m.role AS my_team_role
  FROM templates t
  LEFT JOIN users u ON u.id = t.owner_id
  LEFT JOIN teams tm ON tm.id = t.team_id
  LEFT JOIN team_members m ON m.team_id = t.team_id AND m.user_id = $uid`;

/**
 * What a person may do with a template row: personal ones are the owner's (workspace owners and admins also reach those
 * whose owner is gone, as they do boards); team ones belong to the team (its members, guests who are members included,
 * and workspace owners and admins); workspace ones are for everyone but guests. Changing: the owner while still allowed
 * to see it, team admins for team ones, workspace owners and admins for team and workspace ones.
 * @param {{ owner_id: string | null, scope: string }} row
 * @param {{ id: string, role: string }} user
 * @param {string | null | undefined} teamRole the person's role in the template's team
 */
export function templateAccess(row, user, teamRole) {
  const admin = isAdmin(user);
  const mine = row.owner_id !== null && row.owner_id === user.id;
  if (row.scope === 'personal') {
    const own = mine || (row.owner_id === null && admin);
    return { read: own, change: own };
  }
  if (row.scope === 'team') {
    const inTeam = teamRole !== null && teamRole !== undefined;
    return { read: inTeam || admin, change: admin || teamRole === 'admin' || (mine && inTeam) };
  }
  if (row.scope === 'workspace') return { read: user.role !== 'guest', change: admin };
  return { read: false, change: false };
}

const toSummary = (r, user) => {
  const access = templateAccess(r, user, r.my_team_role ?? null);
  return {
    access,
    summary: {
      id: r.id,
      ownerId: r.owner_id,
      ownerName: r.owner_name ?? null,
      scope: r.scope,
      teamId: r.team_id,
      teamName: r.team_name ?? null,
      name: r.name,
      category: r.category,
      description: r.description,
      objectCount: Number(r.object_count),
      stepCount: Number(r.step_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canChange: access.change,
    },
  };
};

/** `db` is the small query kit openDirectory builds: get, all, run (returns the change count) and transaction. */
export function createTemplateStore({ get, all, run }) {
  const param = (user) => ({ uid: user.id });

  /**
   * Metadata of every template the person can see, newest first. The content is never listed.
   * @param {{ id: string, role: string }} user
   */
  function listTemplatesFor(user) {
    return all(`${SUMMARY_SELECT} WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC, t.id`, param(user))
      .map((r) => toSummary(r, user))
      .filter((t) => t.access.read)
      .map((t) => t.summary);
  }

  /**
   * The template with its metadata when the person may see it; null for one that is missing, deleted or not theirs.
   * @param {{ id: string, role: string }} user @param {unknown} id
   */
  function getTemplateFor(user, id) {
    if (typeof id !== 'string') return null;
    const row = get(`${SUMMARY_SELECT} WHERE t.id = $id AND t.deleted_at IS NULL`, { ...param(user), id });
    if (!row) return null;
    const { access, summary } = toSummary(row, user);
    return access.read ? summary : null;
  }

  /** The stored JSON of a template's content. Call it only for a template the person was just allowed to read. */
  const getTemplateContent = (id) => get('SELECT content FROM templates WHERE id = ? AND deleted_at IS NULL', id)?.content ?? null;

  /** @param {{ ownerId: string | null, scope: string, teamId?: string | null, name: string, category: string, description?: string, validated: { json: string, objectCount: number, stepCount: number }, now?: number }} fields */
  function createTemplate({ ownerId, scope, teamId = null, name, category, description = '', validated, now = Date.now() }) {
    const id = newId();
    run(
      `INSERT INTO templates (id, owner_id, scope, team_id, name, category, description, content, object_count, step_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id, ownerId, scope, scope === 'team' ? teamId : null, name, category, description, validated.json, validated.objectCount, validated.stepCount, now, now,
    );
    return id;
  }

  /**
   * `patch` holds any of name, category, description, scope, teamId and validated (the checked content).
   * @param {string} id @param {{ name?: string, category?: string, description?: string, scope?: string, teamId?: string | null, validated?: { json: string, objectCount: number, stepCount: number } }} patch
   */
  function updateTemplate(id, patch, now = Date.now()) {
    const sets = ['updated_at = ?'];
    const params = [now];
    for (const key of ['name', 'category', 'description']) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(patch[key]);
      }
    }
    if (patch.scope !== undefined) {
      sets.push('scope = ?', 'team_id = ?');
      params.push(patch.scope, patch.scope === 'team' ? patch.teamId : null);
    }
    if (patch.validated !== undefined) {
      sets.push('content = ?', 'object_count = ?', 'step_count = ?');
      params.push(patch.validated.json, patch.validated.objectCount, patch.validated.stepCount);
    }
    return run(`UPDATE templates SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, ...params, id) === 1;
  }

  const deleteTemplate = (id, now = Date.now()) => run('UPDATE templates SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', now, id) === 1;

  const countTemplatesOwnedBy = (ownerId) =>
    Number(get('SELECT COUNT(*) AS n FROM templates WHERE owner_id = ? AND deleted_at IS NULL', ownerId).n);

  return { listTemplatesFor, getTemplateFor, getTemplateContent, createTemplate, updateTemplate, deleteTemplate, countTemplatesOwnedBy };
}
