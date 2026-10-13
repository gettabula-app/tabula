// Structural validator for what a client writes into a board room or a comments room. PURE: no I/O, no Yjs, no clock.
// It works on plain JS values, the `yMap.toJSON()` of the key that changed, and it is not wired into the relay yet.
//
// Why: the relay decides who may write a room, not what the write holds (docs/comment-authz.md). An editor or commenter
// can put a malformed, oversized or forged object into a room. Only tracker-linked cards (server/tracker/guard.mjs) and
// comment authorship (server/comment-authz.mjs) are checked today. This module is the rest: types, sizes, enumerations,
// finite numbers, depth, forbidden key names, and the fields that name a person (createdBy, ownerId, authorId, ...).
//
// The allow-list was derived from the code that writes the fields, not guessed: src/types.ts (the object model),
// src/safe-obj.ts (what the markup trusts), src/store.ts (create/update, flow, polls, votes, labels), src/comments.ts,
// shared/containers.mjs (kanban limits), shared/text-limits.mjs, server/templates.mjs (the template validator, the
// closest existing allow-list) and server/board-ops.mjs (MCP caps). test/sync-validate.test.ts keeps the copied
// enumerations equal to board-ops.mjs, so a new shape kind or object type fails a test here until it is added.
//
// Rules in one paragraph. Only the keys of a change are looked at, and inside an object only the fields that changed when
// the caller says which (`fields`) or gives the previous value (`prev`); data already in the room is never re-validated or
// rewritten. A violation is `{ code, path }`: a short constant and a field path, never content. Whether a violation
// rejects the write is the caller's decision: see syncValidateMode and shouldReject (off, report, enforce).
//
// The change record (see validateChangedKeys):
//   { kind, key, value, isNew?, fields?, prev?, replyIds? }
//   kind     'object' | 'meta' | 'flow' | 'vote' | 'poll' | 'pollAnswer' | 'pollState' | 'label' | 'thread'
//   key      the map key (the object id, the thread id, `${pollId}:${userId}`, ...)
//   value    the plain value now, or null when the key was deleted (a deletion has nothing to validate here)
//   isNew    the key did not exist before. Authorship is stamped on creation.
//   fields   names of the top-level fields that changed (from the Yjs event's keysChanged). Strongly recommended.
//   prev     the plain value before the change. Fallback to find changed fields when `fields` is absent.
//   replyIds (thread only) the reply ids that were added or changed.
// Without `fields` and without `prev` every field of the value is checked, which is right for a new key and
// conservative for an unknown history.
//
// The context (ctx), supplied by the relay, all optional but fail closed where a rule needs them:
//   writer            { id, name, role? } the authenticated sender, or null in open mode (no identity: authorship
//                     rules are skipped there, as comment-authz.mjs is accounts mode only)
//   isBoardMember(id) is this id a current member of the board? (card ownerId)
//   canEditObject(id) may the writer edit the existing object with this id? (an owner change on an existing object)
//   isAgentOwner(id)  optional: is this id an agent token that may own cards (ownerKind 'agent')
//   counts            { thread, object } how many keys the room holds now, for the room caps
//   createdByPolicy   'writer' (default) | 'member': 'member' also accepts any current member as createdBy, for undo
//                     restoring somebody else's deleted object with its original createdBy

import { CODE_LANG_IDS, MAX_CODE_CHARS, MAX_CODE_TITLE } from '../shared/code-langs.mjs';
import { cleanColor } from '../shared/colors.mjs';
import { isDueDate, isSafeHttpUrl, kanbanColor, LIMITS as KANBAN_LIMITS, OWNER_KINDS, OWNER_NAME_MAX, STAGES } from '../shared/containers.mjs';
import { OBJECT_TEXT_MAX } from '../shared/text-limits.mjs';
import { MAX_CELL_CHARS, MAX_COL_WIDTH, MAX_TABLE_CHARS, MAX_TABLE_COLS, MAX_TABLE_ROWS, MIN_COL_WIDTH, isValidRank, parseTableKey, tableChars } from '../shared/tables.mjs';
import { MAX_SVG_BODY } from '../shared/svg-safety.mjs';

// ---------------------------------------------------------------- limits (one table, adjust here)

export const LIMITS = Object.freeze({
  /** Serialized size of one object / thread / poll, in bytes. */
  objectBytes: 256 * 1024,
  /** Deepest nesting of a value: the object is depth 0, its fields depth 1. */
  depth: 6,
  /** Values (objects, arrays, scalars) in one change, a guard on the walk itself. */
  nodes: 200_000,
  /** Any string, anywhere. The per-field caps below are smaller. */
  anyString: MAX_SVG_BODY + 1000,
  /** Board text. The client caps a paste at OBJECT_TEXT_MAX (4,000), MCP too; typing and rich text allow 20,000 (docs/rich-text.md decision 8). */
  text: 20_000,
  markdown: 8_000,
  pasteText: OBJECT_TEXT_MAX,
  /** Frame, group, layer and board names: the frame-name editor is a textarea with no cap (src/editor.ts), templates cap at 500. */
  name: 1000,
  label: 1000,
  desc: KANBAN_LIMITS.description,
  cardTitle: KANBAN_LIMITS.title,
  laneName: KANBAN_LIMITS.laneName,
  containerName: KANBAN_LIMITS.containerName,
  ownerName: OWNER_NAME_MAX,
  labelName: KANBAN_LIMITS.labelName,
  labelsPerCard: KANBAN_LIMITS.labelsPerCard,
  labelsPerBoard: KANBAN_LIMITS.labels,
  link: 2000,
  idLen: 64,
  coordinate: 10_000_000,
  size: 10_000_000,
  rotation: 1_000_000,
  timestamp: 1e14,
  points: 100_000,
  members: 200,
  memberText: 200,
  steps: 100,
  stepTitle: 200,
  stepInstructions: 2000,
  voteItems: 5000,
  pollQuestion: 200,
  pollOption: 120,
  pollOptions: 10,
  optionsPerAnswer: 10,
  stickyColors: 30,
  commentText: 4000,
  commentName: 80,
  /** Comments: the room and thread caps that MCP already enforces (server/board-ops.mjs LIMITS). */
  threadsPerRoom: 2000,
  repliesPerThread: 200,
  /** The cap on the JSON of a tolerated unknown field. */
  toleratedBytes: 4096,
  trackerBytes: 8192,
  pathChars: 120,
});

/** Own keys that are never accepted at any depth. */
/**
 * Whether a field-length cap (`too_long`) rejects in enforce mode. Off for now: the client does not cap typed text, so
 * the caps run in report mode only (they are still returned, marked `reportOnly`). Enable after the report has run for a release.
 */
export const ENFORCE_TEXT_CAPS = false;

export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------- enumerations (kept equal to board-ops.mjs by a test)

export const OBJ_TYPES = Object.freeze([
  'shape', 'sticky', 'text', 'frame', 'tracker', 'group', 'icon', 'image', 'link', 'path', 'connector', 'container', 'lane', 'card', 'markdown', 'table', 'code',
  'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-initial', 'uml-final', 'uml-component',
]);
/** Object types the validator knows beyond board-ops.mjs's list: none now that link cards (docs/link-cards.md) are in both. */
export const EXTRA_TYPES = Object.freeze([]);
export const SHAPE_KINDS = Object.freeze([
  'rect', 'rounded', 'ellipse', 'diamond', 'triangle', 'hexagon', 'octagon', 'parallelogram', 'trapezoid', 'star', 'cylinder',
  'document', 'terminator', 'manual-input', 'predefined', 'pentagon', 'cross', 'heart', 'cloud', 'arrow-right', 'arrow-left',
  'arrow-both', 'chevron', 'arrow-pentagon', 'callout-rect', 'callout-round', 'delay', 'merge', 'off-page', 'manual-operation',
  'display',
]);
export const HEADS = Object.freeze(['none', 'arrow', 'open', 'triangle', 'diamond', 'diamond-open', 'circle', 'bar', 'crow-many', 'crow-one']);
export const ROUTES = Object.freeze(['straight', 'elbow', 'curved']);
export const DASHES = Object.freeze(['solid', 'dashed', 'dotted']);
export const ALIGNS = Object.freeze(['left', 'center', 'right']);
export const VALIGNS = Object.freeze(['top', 'middle', 'bottom']);
export const SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);
export const RELATIONS = Object.freeze([
  'association', 'directed', 'generalization', 'realization', 'dependency', 'aggregation', 'composition', 'message',
  'async', 'reply', 'include', 'extend', 'transition',
]);
export const STEP_MODES = Object.freeze(['write', 'private-write', 'cluster', 'vote', 'discuss', 'poll']);
export const VOTE_SCOPES = Object.freeze(['all', 'stickies', 'selection']);
export const GRID_TYPES = Object.freeze(['dots', 'lines', 'iso', 'none']);
const TRACKER_VIEWS = Object.freeze(['inbox', 'my', 'all', 'board', 'projects']);
/** The unfurl states and error codes of a link card (docs/link-cards.md; server/link-routes.mjs FETCH_CODES plus rate_limited). */
export const UNFURL_STATES = Object.freeze(['pending', 'ok', 'failed', 'off']);
export const UNFURL_ERRORS = Object.freeze(['blocked', 'timeout', 'too_large', 'not_html', 'http_status', 'unreachable', 'rate_limited']);
const WIP_MODES = Object.freeze(['warn', 'block']);
const VISIBILITY = Object.freeze(['+', '-', '#', '~', '']);
const PROPOSED_FEATURES = Object.freeze(['generate', 'summarise', 'cluster']);

// ---------------------------------------------------------------- patterns

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A tracker ticket, state or workspace id (src/safe-obj.ts TRACKER_FIELD_RE). */
const TRACKER_FIELD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKER_KEY_RE = /^[A-Za-z]{2,5}-[1-9][0-9]{0,18}$/i;
/** Font slugs and `system` (src/safe-obj.ts FONT_RE). */
const FONT_RE = /^[a-z0-9-]{1,64}$/;
/** A content hash, or `pending:<id>` while the bytes are only on one device (docs/images.md). */
const ASSET_RE = /^(?:pending:)?[A-Za-z0-9_-]{1,128}$/;
const MIME_RE = /^[a-z0-9]+\/[a-z0-9.+-]{1,100}$/i;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPLY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LINE_BREAK = /\p{Cc}|[\u2028\u2029]/u;

// ---------------------------------------------------------------- tolerated unknown fields (the adjustable table)

/**
 * Fields that are not in the object model yet or any more, but are allowed because the client evolves (specs in docs/
 * that are partly built, older builds, files from other versions). They are allowed on the types named, size-capped,
 * and checked only for kind. Everything else on a known type is an `unknown_field` violation.
 *
 * Edit this table when the client gains a field: first add it here (tolerated), then give it a real rule in FIELDS below.
 * `'*'` applies to every type. Kinds: 'string' (up to `max` characters), 'number' (finite), 'boolean', 'json' (a small
 * value of at most LIMITS.toleratedBytes, depth 3). `prefix` entries match every field starting with that text.
 */
export const TOLERATED_UNKNOWN = Object.freeze({
  // docs/flip-cards.md: two-sided stickies and shapes
  sticky: Object.freeze({
    twoSided: { kind: 'boolean' }, face: { kind: 'string', max: 16 }, faceAt: { kind: 'number' }, backText: { kind: 'string', max: LIMITS.text },
    backFill: { kind: 'string', max: 64 }, backTextColor: { kind: 'string', max: 64 }, backRef: { kind: 'string', max: 200 },
    backBody: { kind: 'string', max: MAX_SVG_BODY }, backViewBox: { kind: 'json' },
    // docs/sticky-stacks.md: a torn note remembers its pad
    stackId: { kind: 'string', max: 64 }, stackName: { kind: 'string', max: 80 }, ownerId: { kind: 'string', max: 64 }, ownerName: { kind: 'string', max: 80 },
  }),
  shape: Object.freeze({
    twoSided: { kind: 'boolean' }, face: { kind: 'string', max: 16 }, faceAt: { kind: 'number' }, backText: { kind: 'string', max: LIMITS.text },
    backFill: { kind: 'string', max: 64 }, backTextColor: { kind: 'string', max: 64 }, backRef: { kind: 'string', max: 200 },
    backBody: { kind: 'string', max: MAX_SVG_BODY }, backViewBox: { kind: 'json' },
  }),
  // docs/tags.md: one key per tag on an item, and the legacy array
  '*': Object.freeze({ labels: { kind: 'json' } }),
  prefixes: Object.freeze({ 'tag:': { kind: 'json' } }),
});

// ---------------------------------------------------------------- checkers
// A checker is (value, helpers) => code | null. Violation codes are short constants.

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const cpLength = (s) => [...s].length;

const str = (max, { min = 0, line = false, cp = false, pattern = null } = {}) => (v) => {
  if (typeof v !== 'string') return 'bad_type';
  if (v.length < min) return 'too_short';
  if (v.length > max && (!cp || cpLength(v) > max)) return 'too_long';
  if (line && LINE_BREAK.test(v)) return 'bad_chars';
  if (pattern && !pattern.test(v)) return 'bad_value';
  return null;
};
const num = (min, max) => (v) => {
  if (typeof v !== 'number') return 'bad_type';
  if (!Number.isFinite(v)) return 'not_finite';
  return v < min || v > max ? 'out_of_range' : null;
};
const int = (min, max) => (v) => {
  const bad = num(min, max)(v);
  if (bad) return bad;
  return Number.isInteger(v) ? null : 'bad_value';
};
const bool = (v) => (typeof v === 'boolean' ? null : 'bad_type');
const oneOf = (list) => {
  const set = new Set(list);
  return (v) => (typeof v !== 'string' ? 'bad_type' : set.has(v) ? null : 'bad_value');
};
const id = str(LIMITS.idLen, { min: 1, pattern: ID_RE });
const color = (v) => (typeof v !== 'string' ? 'bad_type' : cleanColor(v) === null ? 'bad_value' : null);
const kanbanPaint = (v) => (typeof v !== 'string' ? 'bad_type' : kanbanColor(v) === null ? 'bad_value' : null);
const url = (v) => (typeof v !== 'string' ? 'bad_type' : isSafeHttpUrl(v) ? null : 'bad_value');
const nullable = (check) => (v) => (v === null ? null : check(v));
const timestamp = num(0, LIMITS.timestamp);

/** An array of at most `max` items, each passing `item`. Reports the first failure's code. */
const list = (max, item) => (v) => {
  if (!Array.isArray(v)) return 'bad_type';
  if (v.length > max) return 'too_many';
  for (const x of v) {
    const bad = item(x);
    if (bad) return bad;
  }
  return null;
};

/** A record whose keys are all in `shape`; a missing key is ok unless `required`. Nested checkers see the nested value. */
const shaped = (shape, required = []) => (v) => {
  if (!isRecord(v)) return 'bad_type';
  for (const k of Object.keys(v)) {
    if (v[k] === undefined) continue;
    const check = Object.hasOwn(shape, k) ? shape[k] : null;
    if (!check) return 'unknown_field';
    const bad = check(v[k]);
    if (bad) return bad;
  }
  for (const k of required) if (v[k] === undefined) return 'missing_field';
  return null;
};

const END = (v) => {
  if (!isRecord(v)) return 'bad_type';
  if (v.kind === 'free') return shaped({ kind: oneOf(['free']), x: num(-LIMITS.coordinate, LIMITS.coordinate), y: num(-LIMITS.coordinate, LIMITS.coordinate) }, ['x', 'y'])(v);
  if (v.kind === 'bound') return shaped({ kind: oneOf(['bound']), id, anchor: oneOf(['auto', ...SIDES]) }, ['id'])(v);
  return 'bad_value';
};

const MEMBER = shaped({
  visibility: oneOf(VISIBILITY), name: str(LIMITS.memberText), type: str(LIMITS.memberText), isStatic: bool, isAbstract: bool,
});
const MEMBERS = list(LIMITS.members, MEMBER);

const VIEW_BOX = (v) => {
  if (!Array.isArray(v)) return 'bad_type';
  if (v.length !== 4) return 'bad_value';
  for (const n of v) {
    const bad = num(-LIMITS.coordinate, LIMITS.coordinate)(n);
    if (bad) return bad;
  }
  return null;
};
const POINTS = (v) => {
  if (!Array.isArray(v)) return 'bad_type';
  if (v.length > LIMITS.points) return 'too_many';
  if (v.length % 2 !== 0) return 'bad_value';
  for (const n of v) {
    const bad = num(-LIMITS.coordinate, LIMITS.coordinate)(n);
    if (bad) return bad;
  }
  return null;
};

/** TAB-160: which AI run an added object came from. */
const PROPOSED_BY = shaped({
  feature: oneOf(PROPOSED_FEATURES),
  by: shaped({ id: nullable(str(64, { pattern: ID_RE })), name: nullable(str(200)) }),
}, ['feature']);

/** Server-written snapshot of a linked ticket: shape-checked loosely, size-capped; trackerGuarded owns who may write it. */
const sizeCapped = (bytes) => (v) => {
  if (!isRecord(v)) return 'bad_type';
  let json;
  try { json = JSON.stringify(v); } catch { return 'bad_type'; }
  return json.length > bytes ? 'too_big' : null;
};

// ---------------------------------------------------------------- the object model

const COORD = num(-LIMITS.coordinate, LIMITS.coordinate);

/** Fields every box has (everything but connectors and groups). */
const BOX = {
  id, type: str(40),
  x: COORD, y: COORD, w: num(0, LIMITS.size), h: num(0, LIMITS.size), rotation: num(-LIMITS.rotation, LIMITS.rotation),
  z: str(64), parent: id, locked: bool, hidden: bool, flipX: bool, flipY: bool,
  createdBy: str(128), updatedAt: timestamp, proposedBy: PROPOSED_BY, privateStep: id,
  text: str(LIMITS.text), name: str(LIMITS.name),
  fill: color, stroke: color, textColor: color, strokeWidth: num(0, 1000), dash: oneOf(DASHES), opacity: num(0, 1),
  font: str(64, { min: 1, pattern: FONT_RE }), fontWeight: num(1, 1000), fontSize: num(1, 2000), align: oneOf(ALIGNS), valign: oneOf(VALIGNS),
};

/** A web address as a link card stores it: http(s), no white space, at most 2,048 characters (docs/link-cards.md). */
const webUrl = (v) => {
  if (typeof v !== 'string') return 'bad_type';
  if (v.length > 2048) return 'too_long';
  return /^https?:\/\/[^\s\\]+$/i.test(v) ? null : 'bad_value';
};
const asset = str(160, { min: 1, pattern: ASSET_RE });

const KANBAN_ROW = { rank: str(200, { min: 1 }) };
const TRACKER_CARD = {
  extProvider: oneOf(['tabula']), extKey: str(40, { pattern: TRACKER_KEY_RE }), extUrl: url,
  trackerId: str(64, { pattern: TRACKER_FIELD_RE }), tracker: sizeCapped(LIMITS.trackerBytes), trackerUnmappedState: bool,
};

/** The rule for one key of a table: a row or column rank, a column width, or a cell's text. Null for a key that is not a table part. */
function tablePartCheck(key) {
  const p = parseTableKey(key);
  if (!p) return null;
  // a rank must be a key fractional-indexing accepts: any other value would make every insert and move in the table throw
  if (p.kind === 'r' || p.kind === 'k') return (v) => (typeof v !== 'string' ? 'bad_type' : isValidRank(v) ? null : 'bad_value');
  if (p.kind === 'w') return num(MIN_COL_WIDTH, MAX_COL_WIDTH);
  if (p.kind === 'a') return oneOf(ALIGNS);
  if (p.kind === 'f') return color;
  return str(MAX_CELL_CHARS, { cp: true });
}

/** A table has at most MAX_TABLE_ROWS rows and MAX_TABLE_COLS columns, whatever order the writes came in. */
function tableCountCodes(value, only) {
  const out = [];
  // all the cell text of one table stays within MAX_TABLE_CHARS, so a table is always inside the per-object byte cap
  if ((!only || [...only].some((k) => parseTableKey(k)?.kind === 'c')) && tableChars(value) > MAX_TABLE_CHARS) out.push({ code: 'table_too_big', path: '' });
  if (only && ![...only].some((k) => parseTableKey(k)?.kind === 'r' || parseTableKey(k)?.kind === 'k')) return out;
  let rows = 0;
  let cols = 0;
  const rowRanks = new Set();
  const colRanks = new Set();
  let duplicate = false;
  for (const k of Object.keys(value)) {
    const p = parseTableKey(k);
    if (p?.kind === 'r') {
      rows++;
      if (rowRanks.has(value[k])) duplicate = true;
      rowRanks.add(value[k]);
    } else if (p?.kind === 'k') {
      cols++;
      if (colRanks.has(value[k])) duplicate = true;
      colRanks.add(value[k]);
    }
  }
  // two clients inserting after the same line honestly make equal ranks (the client orders them by id and repairs), so this is reported, never refused
  if (duplicate) out.push({ code: 'duplicate_rank', path: '', reportOnly: true });
  return [...out, ...(rows > MAX_TABLE_ROWS ? [{ code: 'too_many_rows', path: '' }] : []), ...(cols > MAX_TABLE_COLS ? [{ code: 'too_many_columns', path: '' }] : [])];
}

/** Per type: its own fields added to BOX (or, for connector and group, a list of their own). */
export const FIELDS = Object.freeze({
  shape: { ...BOX, kind: oneOf(SHAPE_KINDS), lineHeight: num(0.8, 3) },
  sticky: { ...BOX, lineHeight: num(0.8, 3) },
  text: { ...BOX, lineHeight: num(0.8, 3) },
  // a Markdown block's text is capped lower than a note: every viewer lays it out
  markdown: { ...BOX, text: str(LIMITS.markdown), lineHeight: num(0.8, 3) },
  // a code block (docs/code-blocks.md): the code is `text` (the cap is report-only like every text cap), the language one of the shared list
  code: { ...BOX, text: str(MAX_CODE_CHARS), lang: oneOf(CODE_LANG_IDS), title: str(MAX_CODE_TITLE), lines: bool, wrap: bool },
  // a table (docs/tables.md): the header flags, and rows, columns, widths and cells as keys of their own, checked by tablePartCheck
  table: { ...BOX, headerRow: bool, headerCol: bool },
  frame: { ...BOX, name: str(LIMITS.name) },
  tracker: {
    ...BOX, trackerId: str(64, { pattern: TRACKER_FIELD_RE }), view: oneOf(TRACKER_VIEWS),
    viewId: str(64, { pattern: TRACKER_FIELD_RE }), focusKey: str(64, { pattern: TRACKER_FIELD_RE }),
  },
  group: {
    id, type: str(40), x: COORD, y: COORD, w: num(0, LIMITS.size), h: num(0, LIMITS.size), rotation: num(-LIMITS.rotation, LIMITS.rotation),
    z: str(64), parent: id, locked: bool, hidden: bool, createdBy: str(128), updatedAt: timestamp, proposedBy: PROPOSED_BY,
    name: str(LIMITS.name),
  },
  icon: {
    ...BOX, ref: str(200), body: str(MAX_SVG_BODY), viewBox: VIEW_BOX, sticker: bool,
  },
  image: {
    ...BOX, asset: str(160, { min: 1, pattern: ASSET_RE }), mime: str(120, { pattern: MIME_RE }),
    nw: num(0, LIMITS.size), nh: num(0, LIMITS.size), alt: str(LIMITS.label),
  },
  path: { ...BOX, points: POINTS },
  link: {
    ...BOX, url: webUrl, title: str(300), description: str(1000), siteName: str(100), image: asset, imageW: num(0, LIMITS.size),
    imageH: num(0, LIMITS.size), icon: asset, finalUrl: webUrl, unfurl: oneOf(UNFURL_STATES), unfurlError: oneOf(UNFURL_ERRORS),
    fetchedAt: timestamp, edited: list(2, oneOf(['title', 'description'])),
  },
  connector: {
    id, type: str(40), z: str(64), from: END, to: END, route: oneOf(ROUTES), startHead: oneOf(HEADS), endHead: oneOf(HEADS),
    relation: oneOf(RELATIONS), label: str(LIMITS.label), stroke: color, strokeWidth: num(0, 1000), dash: oneOf(DASHES), opacity: num(0, 1),
    createdBy: str(128), updatedAt: timestamp, proposedBy: PROPOSED_BY,
    // unused geometry kept for uniform handling (src/types.ts ConnectorObj)
    x: COORD, y: COORD, w: num(0, LIMITS.size), h: num(0, LIMITS.size), rotation: num(-LIMITS.rotation, LIMITS.rotation),
    parent: id, locked: bool, hidden: bool, name: str(LIMITS.name), font: str(64, { min: 1, pattern: FONT_RE }),
    fontSize: num(1, 2000), fontWeight: num(1, 1000), textColor: color, align: oneOf(ALIGNS), valign: oneOf(VALIGNS),
  },
  container: {
    ...BOX, ...KANBAN_ROW, layout: str(40), laneW: num(0, 10_000), name: str(LIMITS.containerName, { cp: true }),
    ext: sizeCapped(LIMITS.trackerBytes), fill: kanbanPaint, stroke: kanbanPaint, textColor: kanbanPaint,
  },
  lane: {
    ...BOX, ...KANBAN_ROW, stage: oneOf(STAGES), wip: int(KANBAN_LIMITS.wipMin, KANBAN_LIMITS.wipMax), wipMode: oneOf(WIP_MODES), laneW: num(0, 10_000),
    name: str(LIMITS.laneName, { cp: true }), fill: kanbanPaint, stroke: kanbanPaint, textColor: kanbanPaint,
  },
  card: {
    ...BOX, ...KANBAN_ROW, ...TRACKER_CARD, text: str(LIMITS.cardTitle, { cp: true }), desc: str(LIMITS.desc, { cp: true }),
    ownerId: id, ownerName: str(LIMITS.ownerName * 4, { line: true }), ownerKind: oneOf(OWNER_KINDS),
    due: (v) => (typeof v !== 'string' ? 'bad_type' : isDueDate(v) ? null : 'bad_value'), link: url,
    labels: list(LIMITS.labelsPerCard, id), fill: kanbanPaint, stroke: kanbanPaint, textColor: kanbanPaint,
  },
  'uml-class': { ...BOX, stereotype: str(200), attributes: MEMBERS, operations: MEMBERS },
  'uml-actor': { ...BOX }, 'uml-usecase': { ...BOX }, 'uml-lifeline': { ...BOX }, 'uml-note': { ...BOX }, 'uml-package': { ...BOX },
  'uml-state': { ...BOX }, 'uml-initial': { ...BOX }, 'uml-final': { ...BOX }, 'uml-component': { ...BOX },
});

// ---------------------------------------------------------------- generic walk

/** Keeps a path short and free of content: only [A-Za-z0-9_.[\]-], at most pathChars, anything else becomes `?`. */
const cleanKey = (k) => (/^[A-Za-z0-9_:-]{1,40}$/.test(k) ? k : '?');
const joinPath = (parts) => parts.map((p) => (typeof p === 'number' ? `[${p}]` : cleanKey(p))).join('.').replace(/\.\[/g, '[').slice(0, LIMITS.pathChars);

/**
 * Walks a value once and reports structural problems at any depth: forbidden own keys, a prototype other than
 * Object.prototype or null (Y.Map.toJSON assigns `obj['__proto__'] = v`, which sets the prototype, not an own key),
 * non-finite numbers, values that JSON cannot carry, too deep, too many values, strings over the global cap. The same
 * walk adds up the serialized size (strings by length, numbers 8, keys length + 3: an estimate that is exact for ASCII)
 * and stops as soon as it passes `maxBytes`, so no separate JSON.stringify is needed.
 *
 * `budget` ({ bytes, nodes }, remaining for a whole message) is spent as the walk goes; when it runs out the walk stops with
 * a `budget` violation and `budget.exhausted` is set, which the caller counts as skipped, not as a violation.
 * `only` limits the top-level fields looked at (the fields that changed): the rest of an existing object is not walked.
 * Paths are built only for a violation, from parent links.
 */
function scan(value, { maxDepth = LIMITS.depth, maxBytes = LIMITS.objectBytes, budget = null, only = null } = {}) {
  const out = [];
  let nodes = 0;
  let bytes = 0;
  const seen = new Set();
  const stack = [{ v: value, depth: 0, parent: null, key: null }];
  const pathOf = (node) => {
    const parts = [];
    for (let n = node; n && n.parent; n = n.parent) parts.push(n.key);
    return joinPath(parts.reverse());
  };
  const add = (code, node, extra) => {
    if (out.length < 20) out.push({ code, path: extra === undefined ? pathOf(node) : joinPath([...pathParts(node), extra]) });
  };
  const pathParts = (node) => {
    const parts = [];
    for (let n = node; n && n.parent; n = n.parent) parts.push(n.key);
    return parts.reverse();
  };
  while (stack.length) {
    const node = stack.pop();
    const { v, depth } = node;
    if (++nodes > LIMITS.nodes) {
      add('too_big', node);
      break;
    }
    if (budget && (--budget.nodes < 0 || budget.bytes < 0)) {
      budget.exhausted = true;
      out.push({ code: 'budget', path: '' });
      break;
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'undefined') {
      bytes += 5;
      continue;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) add('not_finite', node);
      bytes += 8;
      continue;
    }
    if (typeof v === 'string') {
      if (v.length > LIMITS.anyString) add('too_big', node);
      bytes += v.length + 2;
      if (budget) budget.bytes -= v.length + 2;
      if (bytes > maxBytes) {
        add('too_big', { parent: null });
        break;
      }
      continue;
    }
    if (typeof v !== 'object') {
      add('bad_type', node);
      continue;
    }
    if (depth > maxDepth) {
      add('too_deep', node);
      continue;
    }
    if (seen.has(v)) {
      add('bad_type', node);
      continue;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      // refuse an array longer than what is left to spend before one of its items is pushed
      if (v.length > LIMITS.nodes || (budget && v.length > budget.nodes)) {
        if (budget) budget.exhausted = true;
        out.push({ code: budget ? 'budget' : 'too_big', path: '' });
        break;
      }
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], depth: depth + 1, parent: node, key: i });
      bytes += v.length + 2;
      if (budget) budget.bytes -= v.length + 2;
      continue;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) add('proto_key', node);
    // for...in with a counter instead of Object.keys: no array of every key, and it stops at the cap
    let seenKeys = 0;
    let stopped = false;
    for (const k in v) {
      if (!Object.hasOwn(v, k)) continue;
      if (++seenKeys > LIMITS.nodes || (budget && seenKeys > budget.nodes)) { stopped = true; break; }
      if (FORBIDDEN_KEYS.includes(k)) {
        add('proto_key', node, '?');
        continue;
      }
      if (depth === 0 && only && !only.has(k)) continue;
      bytes += k.length + 3;
      if (budget) budget.bytes -= k.length + 3;
      stack.push({ v: v[k], depth: depth + 1, parent: node, key: k });
    }
    if (stopped) {
      if (budget) budget.exhausted = true;
      out.push({ code: budget ? 'budget' : 'too_big', path: '' });
      break;
    }
    if (bytes > maxBytes) {
      add('too_big', { parent: null });
      break;
    }
  }
  return { out, bytes };
}

/** The structural problems of a value (see scan). Public for tests and for callers that only want the walk. */
export function scanStructure(value, maxDepth = LIMITS.depth) {
  return scan(value, { maxDepth }).out;
}

/** Byte size of the JSON of a value, or Infinity when it cannot be serialised. */
function jsonBytes(value) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return 0;
    return json.length * 3 > LIMITS.objectBytes ? new TextEncoder().encode(json).length : json.length;
  } catch {
    return Infinity;
  }
}

const ok = () => ({ ok: true });
/** A text-length cap is report-only while ENFORCE_TEXT_CAPS is off. */
const mark = (x) => (x.code === 'too_long' && !ENFORCE_TEXT_CAPS ? { ...x, reportOnly: true } : x);
const result = (violations) => {
  const seen = new Set();
  const unique = violations.filter((x) => {
    const k = `${x.code}\0${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.length ? { ok: false, violations: unique.map(mark) } : { ok: true };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The top-level fields of `value` to look at: `fields` if given, else those that differ from `prev`, else all. */
function fieldFilter(value, opts) {
  if (opts.isNew || !isRecord(value)) return null;
  if (Array.isArray(opts.fields)) return new Set(opts.fields);
  if (opts.fields instanceof Set) return opts.fields;
  if (isRecord(opts.prev)) {
    const names = new Set();
    for (const k of new Set([...Object.keys(value), ...Object.keys(opts.prev)])) if (!same(value[k], opts.prev[k])) names.add(k);
    return names;
  }
  return null;
}

// ---------------------------------------------------------------- board objects

function toleratedFor(type, key) {
  const own = TOLERATED_UNKNOWN[type];
  if (own && Object.hasOwn(own, key)) return own[key];
  if (Object.hasOwn(TOLERATED_UNKNOWN['*'], key)) return TOLERATED_UNKNOWN['*'][key];
  for (const [prefix, rule] of Object.entries(TOLERATED_UNKNOWN.prefixes)) if (key.startsWith(prefix)) return rule;
  return null;
}

function checkTolerated(rule, v) {
  switch (rule.kind) {
    case 'string': return str(rule.max ?? 200)(v);
    case 'number': return finite(v) ? null : typeof v === 'number' ? 'not_finite' : 'bad_type';
    case 'boolean': return bool(v);
    case 'json': {
      const deep = scanStructure(v, 3);
      if (deep.length) return deep[0].code;
      return jsonBytes(v) > LIMITS.toleratedBytes ? 'too_big' : null;
    }
    default: return 'bad_type';
  }
}

const isWriterKnown = (ctx) => !!ctx?.writer && typeof ctx.writer.id === 'string' && ctx.writer.id !== '';

/**
 * Checks one board object (the plain value of `objects.get(id)`).
 * @param {string} id the map key
 * @param {unknown} value `yMap.toJSON()`
 * @param {any} [ctx] see the top of this file
 * @param {{ isNew?: boolean, fields?: string[]|Set<string>, prev?: Record<string, any> }} [opts] see the change record
 * @returns {{ ok: true } | { ok: false, violations: { code: string, path: string }[] }}
 */
export function validateBoardObject(id_, value, ctx = {}, opts = {}) {
  if (typeof id_ !== 'string' || !ID_RE.test(id_)) return result([{ code: 'bad_value', path: 'id' }]);
  if (!isRecord(value)) return result([{ code: 'bad_type', path: '' }]);
  const v = [];
  const only = fieldFilter(value, opts);
  const walked = scan(value, { budget: ctx?.budget ?? null, only });
  v.push(...walked.out);
  if (walked.out.some((x) => x.code === 'too_deep' || x.code === 'too_big' || x.code === 'budget')) return result(v);

  if (value.id !== undefined && value.id !== id_ && (!only || only.has('id'))) v.push({ code: 'id_mismatch', path: 'id' });
  const type = value.type;
  if (typeof type !== 'string' || !Object.hasOwn(FIELDS, type)) {
    v.push({ code: typeof type === 'string' ? 'unknown_type' : 'bad_type', path: 'type' });
    return result(v);
  }

  const table = FIELDS[type];
  const typeChanged = !only || only.has('type');
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) continue; // already reported by the walk
    if (only && !only.has(key) && !(typeChanged && key === 'type')) continue;
    if (value[key] === undefined) continue;
    const check = Object.hasOwn(table, key) ? table[key] : type === 'table' ? tablePartCheck(key) : null;
    if (check) {
      const bad = check(value[key]);
      if (bad) v.push({ code: bad, path: cleanKey(key) });
      continue;
    }
    const rule = toleratedFor(type, key);
    if (rule) {
      const bad = checkTolerated(rule, value[key]);
      if (bad) v.push({ code: bad, path: cleanKey(key) });
    } else v.push({ code: 'unknown_field', path: cleanKey(key) });
  }

  if (type === 'table') v.push(...tableCountCodes(value, only));
  v.push(...checkObjectAuthorship(id_, value, ctx, opts, only));
  return result(v);
}

/** createdBy is stamped by the writer; the owner fields name a board member and change only with canEditObject. */
function checkObjectAuthorship(id_, value, ctx, opts, only) {
  const out = [];
  const changed = (k) => value[k] !== undefined && (opts.isNew === true || !only || only.has(k));

  if (isWriterKnown(ctx) && changed('createdBy') && typeof value.createdBy === 'string') {
    const member = ctx.createdByPolicy === 'member' && typeof ctx.isBoardMember === 'function' && ctx.isBoardMember(value.createdBy) === true;
    if (value.createdBy !== ctx.writer.id && !member) out.push({ code: 'forged_author', path: 'createdBy' });
  }

  const ownerChanged = ['ownerId', 'ownerName', 'ownerKind'].some((k) => changed(k) || (opts.isNew !== true && only && only.has(k)));
  if (ownerChanged) {
    if (typeof value.ownerId === 'string' && changed('ownerId')) {
      const agent = value.ownerKind === 'agent';
      let allowed;
      if (agent) {
        const keeps = isRecord(opts.prev) && opts.prev.ownerKind === 'agent' && opts.prev.ownerId === value.ownerId;
        allowed = keeps || (typeof ctx.isAgentOwner === 'function' && ctx.isAgentOwner(value.ownerId) === true);
        if (!allowed) out.push({ code: 'forged_owner', path: 'ownerId' });
      } else {
        allowed = typeof ctx.isBoardMember === 'function' && ctx.isBoardMember(value.ownerId) === true;
        if (!allowed) out.push({ code: 'forged_owner', path: 'ownerId' });
      }
    } else if (value.ownerKind === 'agent' && changed('ownerKind')) {
      // an agent kind with no id of its own, or a kind set without its id: nothing the client can create
      const keeps = isRecord(opts.prev) && opts.prev.ownerKind === 'agent';
      if (!keeps) out.push({ code: 'forged_owner', path: 'ownerKind' });
    }
    if (opts.isNew !== true && (opts.prev !== undefined || only)) {
      const may = typeof ctx.canEditObject === 'function' && ctx.canEditObject(id_) === true;
      if (!may) out.push({ code: 'owner_change_denied', path: 'ownerId' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- comments

/** Same shape for a thread and a reply; the thread adds anchor, resolved* and replies. */
const COMMENT_BASE = {
  id: str(64, { min: 1, pattern: THREAD_ID_RE }),
  createdAt: timestamp,
  authorId: str(128), authorName: str(LIMITS.commentName), authorColor: str(7, { pattern: /^#[0-9a-f]{6}$/i }),
  text: str(LIMITS.commentText, { min: 1 }), editedAt: timestamp,
  imported: bool, importedBy: str(128), legacy: bool,
};
const ANCHOR = shaped({
  x: num(-LIMITS.coordinate, LIMITS.coordinate), y: num(-LIMITS.coordinate, LIMITS.coordinate), obj: id,
  fx: num(-1e6, 1e6), fy: num(-1e6, 1e6),
}, ['x', 'y']);
const THREAD_FIELDS = {
  ...COMMENT_BASE, anchor: ANCHOR, resolved: bool, resolvedBy: str(128), resolvedAt: timestamp, replies: (v) => (isRecord(v) ? null : 'bad_type'),
};
const REPLY_FIELDS = { ...COMMENT_BASE, id: str(64, { min: 1, pattern: REPLY_ID_RE }) };

/**
 * The author is stamped by the relay: id and name must be the writer's (the colour is picked by the client and only checked for shape). `changed` is null for a comment being
 * created (or of unknown history), else the set of its fields that changed: the author fields are set once, so a change
 * to one of them on an existing comment is always forged. Owners may import and keep the original authors.
 */
function checkCommentAuthor(c, ctx, path, changed) {
  const out = [];
  const w = ctx?.writer;
  const touched = (k) => changed === null || changed.has(k);
  if (c.legacy !== undefined && touched('legacy')) out.push({ code: 'forged_legacy', path: `${path}legacy` });
  if (!isWriterKnown(ctx)) return out;
  if (c.imported === true && touched('imported')) {
    if (w.role !== 'owner') out.push({ code: 'forged_author', path: `${path}imported` });
    else if (c.importedBy !== w.id) out.push({ code: 'forged_author', path: `${path}importedBy` });
    return out;
  }
  if (c.importedBy !== undefined && touched('importedBy') && c.imported !== true) out.push({ code: 'forged_author', path: `${path}importedBy` });
  if (changed !== null) {
    for (const k of ['authorId', 'authorName', 'authorColor']) if (changed.has(k)) out.push({ code: 'forged_author', path: `${path}${k}` });
    return out;
  }
  if (c.imported === true) return out;
  if (c.authorId !== w.id) out.push({ code: 'forged_author', path: `${path}authorId` });
  if (typeof w.name === 'string' && w.name.trim() !== '') {
    const stamped = w.name.trim().slice(0, LIMITS.commentName);
    if (c.authorName !== stamped) out.push({ code: 'forged_author', path: `${path}authorName` });
  }
  return out;
}

function checkCommentFields(c, table, path, only, tolerateNothing = true) {
  const out = [];
  for (const key of Object.keys(c)) {
    if (FORBIDDEN_KEYS.includes(key)) continue;
    if (only && !only.has(key)) continue;
    if (c[key] === undefined) continue;
    const check = Object.hasOwn(table, key) ? table[key] : null;
    if (!check) {
      if (tolerateNothing) out.push({ code: 'unknown_field', path: `${path}${cleanKey(key)}` });
      continue;
    }
    const bad = check(c[key]);
    if (bad) out.push({ code: bad, path: `${path}${cleanKey(key)}` });
  }
  return out;
}

/**
 * Checks one comment thread (the plain value of `threads.get(id)`, replies included as a plain record).
 * Authorship (id, name, colour of the writer) is checked on creation only: later edits keep the original author.
 * @param {string} id
 * @param {unknown} value
 * @param {any} [ctx]
 * @param {{ isNew?: boolean, fields?: string[], prev?: Record<string, any>, replyIds?: string[] }} [opts]
 */
export function validateCommentThread(id_, value, ctx = {}, opts = {}) {
  if (typeof id_ !== 'string' || !THREAD_ID_RE.test(id_)) return result([{ code: 'bad_value', path: 'id' }]);
  if (!isRecord(value)) return result([{ code: 'bad_type', path: '' }]);
  const v = [];
  const only = fieldFilter(value, opts);
  const walked = scan(value, { budget: ctx?.budget ?? null, only });
  v.push(...walked.out);
  if (walked.out.some((x) => x.code === 'too_deep' || x.code === 'too_big' || x.code === 'budget')) return result(v);
  if (value.id !== undefined && value.id !== id_ && (!only || only.has('id'))) v.push({ code: 'id_mismatch', path: 'id' });

  const isNew = opts.isNew === true;
  if (isNew && typeof ctx?.counts?.thread === 'number' && ctx.counts.thread >= LIMITS.threadsPerRoom) v.push({ code: 'thread_cap', path: '' });

  v.push(...checkCommentFields(value, THREAD_FIELDS, '', only));
  const topChanged = (k) => isNew || !only || only.has(k);
  v.push(...checkCommentAuthor(value, ctx, '', isNew ? null : only));
  if (topChanged('replies') && isRecord(value.replies)) {
    const ids = Object.keys(value.replies);
    if (ids.length > LIMITS.repliesPerThread) v.push({ code: 'reply_cap', path: 'replies' });
    const watch = Array.isArray(opts.replyIds) ? new Set(opts.replyIds) : null;
    const before = isRecord(opts.prev?.replies) ? opts.prev.replies : null;
    for (const rid of ids) {
      if (FORBIDDEN_KEYS.includes(rid)) continue;
      if (watch && !watch.has(rid)) continue;
      const path = `replies.${cleanKey(rid)}.`;
      const r = value.replies[rid];
      if (!REPLY_ID_RE.test(rid)) v.push({ code: 'bad_value', path: path.slice(0, -1) });
      if (!isRecord(r)) {
        v.push({ code: 'bad_type', path: path.slice(0, -1) });
        continue;
      }
      if (r.id !== undefined && r.id !== rid) v.push({ code: 'id_mismatch', path: `${path}id` });
      const was = before && isRecord(before[rid]) ? before[rid] : null;
      const rOnly = was ? new Set([...Object.keys(r), ...Object.keys(was)].filter((k) => !same(r[k], was[k]))) : null;
      v.push(...checkCommentFields(r, REPLY_FIELDS, path, rOnly));
      v.push(...checkCommentAuthor(r, ctx, path, rOnly));
    }
  }
  return result(v);
}

// ---------------------------------------------------------------- the other board maps

const STEP = shaped({
  id, title: str(LIMITS.stepTitle), instructions: str(LIMITS.stepInstructions), frameId: id, durationSec: num(0, 86_400),
  mode: oneOf(STEP_MODES), votesPerPerson: num(0, 1000), voteScope: oneOf(VOTE_SCOPES), voteItems: list(LIMITS.voteItems, id),
  quick: bool, pollId: id,
}, ['id', 'mode']);
const TIMER = shaped({ startedAt: timestamp, durationMs: num(0, 1e10), pausedAt: timestamp }, ['startedAt', 'durationMs']);
const FOCUS = shaped({ x: COORD, y: COORD, zoom: num(0, 1000), ts: timestamp, by: str(128) });

/** Keys of the `flow` map (src/store.ts FlowState). */
const FLOW_KEYS = {
  steps: list(LIMITS.steps, STEP), active: int(-1, 10_000), timer: nullable(TIMER), reveal: bool, focus: nullable(FOCUS),
  stepStartedAt: timestamp, results: nullable(id),
};

/** Keys of the `meta` map (BoardMeta) and the `feature:<name>` flags. */
const META_KEYS = {
  name: str(LIMITS.name), schemaVersion: int(0, 1000), gridType: oneOf(GRID_TYPES), gridSize: num(1, 1000), snap: bool,
  headingFont: str(64, { min: 1, pattern: FONT_RE }), bodyFont: str(64, { min: 1, pattern: FONT_RE }),
  stickyColors: list(LIMITS.stickyColors, str(9, { pattern: /^#[0-9A-F]{6}$/i })),
  features: list(50, str(64)),
  // the in-memory demo board marks itself seeded (src/demo/seed.ts); it never syncs, but its meta is a board's meta
  demoSeeded: bool,
};
const FEATURE_KEY_RE = /^feature:[a-z0-9-]{1,40}$/;

const POLL = shaped({
  id, question: str(LIMITS.pollQuestion, { min: 1 }),
  options: list(LIMITS.pollOptions, shaped({ id, text: str(LIMITS.pollOption, { min: 1 }) }, ['id', 'text'])),
  multiple: bool, anonymous: bool, revealed: bool, createdAt: timestamp, createdBy: str(128), openedAt: timestamp, closedAt: timestamp,
}, ['id', 'question', 'options']);
const POLL_ANSWER = shaped({
  pollId: id, userId: str(128, { min: 1 }), optionIds: list(LIMITS.optionsPerAnswer, id), updatedAt: timestamp,
  name: str(LIMITS.commentName), color: color,
}, ['pollId', 'userId', 'optionIds']);
const VOTE = shaped({ itemId: id, userId: str(128, { min: 1 }), stepId: id }, ['itemId', 'userId', 'stepId']);
const LABEL = shaped({
  id, name: str(LIMITS.labelName, { min: 1, cp: true }), color: kanbanPaint, order: num(-1e9, 1e9),
}, ['id', 'name']);

/** The message budget of the validateChangedKeys call in progress (the checks below are synchronous). */
let activeBudget = null;

function genericValue(value, budget = activeBudget) {
  return scan(value, { budget }).out;
}

function oneField(code, path) {
  return [{ code, path }];
}

/** Validates a value against a shape checker, with the walk and size guard; maps its first failure to one violation. */
function checkShaped(check, value, path = '') {
  const v = genericValue(value);
  if (v.length) return v;
  const bad = check(value);
  return bad ? oneField(bad, path) : [];
}

// ---------------------------------------------------------------- validateChangedKeys

/**
 * Validates a list of changes. Each change names a map (`kind`), a key and the plain value now (null for a deletion).
 * Deletions are not validated: who may delete is an authorization question, and a deleted key holds no data.
 * @param {{ kind: string, key: string, value: unknown, isNew?: boolean, fields?: string[], prev?: Record<string, any>, replyIds?: string[] }[]} changes
 * @param {any} [ctx]
 * `ctx.budget` ({ bytes, nodes }) is spent across the whole list; changes it cannot afford are returned as `skipped` (a count).
 * @returns {({ ok: true } | { ok: false, violations: { code: string, path: string, kind: string, key: string }[] }) & { skipped?: number }}
 *   `key` is the map key (an object id, a thread id), never content
 */
export function validateChangedKeys(changes, ctx = {}) {
  const out = [];
  let skipped = 0;
  const budget = ctx?.budget ?? null;
  const previous = activeBudget;
  activeBudget = budget;
  try {
    for (const change of Array.isArray(changes) ? changes : []) {
      if (budget?.exhausted) {
        skipped++;
        continue;
      }
      let found = validateChange(change, ctx);
      if (budget?.exhausted) {
        // the budget ran out inside this change: it was not fully looked at, so it counts as skipped, not as a violation
        skipped++;
        found = found.filter((x) => x.code !== 'budget');
        if (!found.length) continue;
      }
      const kind = typeof change?.kind === 'string' && /^[A-Za-z]{1,20}$/.test(change.kind) ? change.kind : '?';
      // the key is sender-controlled text: only an id-shaped key is echoed (an object id, `${pollId}:${userId}`, `feature:x`)
      const key = typeof change?.key === 'string' && /^[A-Za-z0-9_:.-]{1,200}$/.test(change.key) && !FORBIDDEN_KEYS.includes(change.key) ? change.key : '?';
      for (const x of found) out.push(mark({ ...x, kind, key }));
    }
  } finally {
    activeBudget = previous;
  }
  const res = out.length ? { ok: false, violations: out } : ok();
  return skipped ? { ...res, skipped } : res;
}

function validateChange(change, ctx) {
  if (!isRecord(change) || typeof change.kind !== 'string' || typeof change.key !== 'string') return [{ code: 'bad_type', path: '' }];
  const { kind, key, value } = change;
  if (FORBIDDEN_KEYS.includes(key)) return [{ code: 'proto_key', path: '' }];
  if (value === null || value === undefined) return [];
  const opts = { isNew: change.isNew, fields: change.fields, prev: change.prev, replyIds: change.replyIds };
  const writerId = isWriterKnown(ctx) ? ctx.writer.id : null;
  const isNew = change.isNew === true;
  switch (kind) {
    case 'object': return unwrap(validateBoardObject(key, value, ctx, opts));
    case 'thread': return unwrap(validateCommentThread(key, value, ctx, opts));
    case 'meta': {
      if (Object.hasOwn(META_KEYS, key)) return checkShaped(META_KEYS[key], value, key);
      if (FEATURE_KEY_RE.test(key)) return checkShaped(bool, value, 'feature');
      return oneField('unknown_field', cleanKey(key));
    }
    case 'flow': {
      if (!Object.hasOwn(FLOW_KEYS, key)) return oneField('unknown_field', cleanKey(key));
      return checkShaped(FLOW_KEYS[key], value, key);
    }
    case 'label': {
      if (!ID_RE.test(key)) return oneField('bad_value', 'key');
      const v = checkShaped(LABEL, value);
      if (!v.length && value.id !== undefined && value.id !== key) v.push({ code: 'id_mismatch', path: 'id' });
      return v;
    }
    case 'poll': {
      if (!ID_RE.test(key)) return oneField('bad_value', 'key');
      const v = checkShaped(POLL, value);
      if (!v.length && value.id !== key) v.push({ code: 'id_mismatch', path: 'id' });
      if (!v.length && isNew && writerId && value.createdBy !== undefined && value.createdBy !== writerId) v.push({ code: 'forged_author', path: 'createdBy' });
      return v;
    }
    case 'pollState': {
      // `${pollId}:revealed|openedAt|closedAt`
      const m = /^([A-Za-z0-9_-]{1,64}):(revealed|openedAt|closedAt)$/.exec(key);
      if (!m) return oneField('bad_value', 'key');
      return checkShaped(m[2] === 'revealed' ? bool : timestamp, value);
    }
    case 'pollAnswer': {
      // `${pollId}:${userId}`; a person writes only their own answer
      const v = checkShaped(POLL_ANSWER, value);
      if (v.length) return v;
      if (key !== `${value.pollId}:${value.userId}`) v.push({ code: 'id_mismatch', path: 'key' });
      if (writerId && value.userId !== writerId) v.push({ code: 'forged_author', path: 'userId' });
      return v;
    }
    case 'vote': {
      // `${stepId}:${userId}:${id}`; a person casts only their own dots
      const v = checkShaped(VOTE, value);
      if (v.length) return v;
      if (!key.startsWith(`${value.stepId}:${value.userId}:`)) v.push({ code: 'id_mismatch', path: 'key' });
      if (writerId && value.userId !== writerId) v.push({ code: 'forged_author', path: 'userId' });
      return v;
    }
    default: return oneField('unknown_kind', '');
  }
}

const unwrap = (r) => (r.ok ? [] : r.violations);

// ---------------------------------------------------------------- mode

export const SYNC_VALIDATE_MODES = Object.freeze(['off', 'report', 'enforce']);

/**
 * TABULA_SYNC_VALIDATE=off|report|enforce. Unset or empty is `report`: the check counts what it would flag and
 * blocks nothing. `off` is the explicit switch. Anything else throws, so a typo cannot silently
 * change the mode: call this once at startup and let the error stop the server.
 * @param {Record<string, string | undefined>} [env]
 * @returns {'off' | 'report' | 'enforce'}
 */
export function syncValidateMode(env = process.env) {
  const raw = env?.TABULA_SYNC_VALIDATE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'report';
  const value = String(raw).trim().toLowerCase();
  if (SYNC_VALIDATE_MODES.includes(value)) return value;
  throw new Error(`TABULA_SYNC_VALIDATE must be one of ${SYNC_VALIDATE_MODES.join(', ')}; got "${String(raw).slice(0, 20)}"`);
}

/** Whether the violations should stop the write: only in enforce mode, and not for report-only ones (text caps). `off` should not call the validator at all. */
export const shouldReject = (mode, result_) => mode === 'enforce' && result_ && result_.ok === false && result_.violations.some((x) => !x.reportOnly);

/** Counts violation codes: `{ code: n }`, for logs and the report script. No content. */
export function countCodes(violations) {
  const counts = {};
  for (const x of violations ?? []) counts[x.code] = (counts[x.code] ?? 0) + 1;
  return counts;
}
