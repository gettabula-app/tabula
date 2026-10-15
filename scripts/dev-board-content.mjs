#!/usr/bin/env node
// DEV ONLY. Gives the seeded boards of scripts/dev-seed-boards.mjs their real content (the objects, steps and comments the app would hold).
//
// A seeded board with a built-in template gets that template's objects and steps (the same ones the app inserts when a person starts a
// board from it), with a little variation per board: some stickies are left out or re-worded, and some frames are emptied. The variation
// comes from a hash of the board id, so a reseed gives the same boards. A board with no template is left empty, except the privacy board
// (PRIVACY_BOARD_ID): a fixed set of objects, a comment and an image, for the everyone's-view tests (src/preview-render.ts).
//
// The result is written as the room file the relay opens (`<dataDir>/<id>.yjs`, the Yjs update of the board's Store), and the comments of a
// board as `<dataDir>/<id>~comments.yjs`. No picture is written here: a board's picture is drawn by the browser when an editor leaves it
// (ui/board-preview-sync.ts), because only the browser can draw the export.
//
// The code is the app's own: Vite loads src/store.ts, src/templates.ts and the other modules in Node (ssrLoadModule), so there is no second
// copy of the object model here. The write mirrors place() in src/templates.ts (the part that needs no BoardApp).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as Y from 'yjs';
import { openDirectory } from '../server/directory.mjs';
import { createAssetStore } from '../server/assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The board whose content tests the everyone's view of a picture (and no template picture). */
export const PRIVACY_BOARD_ID = 'preview-privacy-test';
/** Texts a sticky may be re-worded to. A picture draws no words, so this changes only what the board says when opened. */
const REWORDED = [
  'Check with the team before we commit',
  'Good idea, needs a number',
  'Too big for one sprint, split it',
  'Ask the customer what they actually do',
  'Parked for the next round',
  'Owner to confirm on Friday',
];

/** Object types that give a frame its structure. They are never emptied: a kanban, its lanes and cards stay whole. */
const STRUCTURE = new Set(['frame', 'container', 'lane', 'card', 'tracker', 'group']);

/** A seeded generator (mulberry32) keyed by the board id: the same id always gives the same variation. */
export function generatorFor(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  let state = h || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The objects of a template after the variation for board `id`: some stickies are left out or re-worded, and some frames lose their
 * notes. Connectors whose bound end went are dropped with it. Mutates and returns the kept objects.
 */
export function varyObjects(objs, id) {
  const rand = generatorFor(id);
  const emptied = new Set(objs.filter((o) => o.type === 'frame' && rand() < 0.3).map((o) => o.id));
  const removed = new Set();
  const kept = [];
  for (const o of objs) {
    if (o.parent && emptied.has(o.parent) && !STRUCTURE.has(o.type)) {
      removed.add(o.id);
      continue;
    }
    if (o.type === 'sticky') {
      if (rand() < 0.18) {
        removed.add(o.id);
        continue;
      }
      if (rand() < 0.15) o.text = REWORDED[Math.floor(rand() * REWORDED.length)];
    }
    kept.push(o);
  }
  return kept.filter((o) => o.type !== 'connector' || [o.from, o.to].every((end) => end.kind !== 'bound' || !removed.has(end.id)));
}

/** A small PNG (64 x 48, two bands of colour): the privacy board's image. Written by hand so the seed needs no image library. */
export function smallPng(width = 64, height = 48) {
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const band = y < height / 2 ? [0x8f, 0xe3, 0xca] : [0xcd, 0xb8, 0xff];
      const at = row + 1 + x * 3;
      raw[at] = band[0];
      raw[at + 1] = band[1];
      raw[at + 2] = band[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/**
 * The privacy board's objects: a visible sticky, an unrevealed private note, a shape, a hidden frame with a child, a hidden sticky, a card
 * with an owner's name, a link card with an external address, an image, and connectors that the everyone's view must drop.
 * `imageHash` is the asset of the image object; `ids` are the object ids the comment is anchored to.
 */
export function privacyObjects({ maja, pia, imageHash, step }) {
  const at = (x, y, w, h, extra) => ({ rotation: 0, x, y, w, h, z: '', ...extra });
  const note = (id, x, y, text, fill, extra = {}) => ({ id, type: 'sticky', text, fill, ...at(x, y, 192, 192, { createdBy: maja, font: 'system' }), ...extra });
  const objs = [
    note('p-public', 0, 0, 'PUBLIC-STICKY-TEXT', '#FFE16B'),
    note('p-private', 240, 0, 'PRIVATE-NOTE-TEXT', '#A3D2FF', { privateStep: step, createdBy: maja }),
    { id: 'p-shape', type: 'shape', kind: 'rect', text: 'PUBLIC-SHAPE-TEXT', fill: '#FFFFFF', ...at(0, 240, 200, 100, { createdBy: maja }) },
    { id: 'p-frame-hidden', type: 'frame', name: 'HIDDEN-FRAME-NAME', hidden: true, fill: '#E4EFFF', ...at(480, 0, 300, 300, { createdBy: maja }) },
    note('p-frame-child', 500, 40, 'HIDDEN-CHILD-TEXT', '#BCE88C', { parent: 'p-frame-hidden', createdBy: maja }),
    note('p-hidden', 0, 480, 'HIDDEN-STICKY-TEXT', '#FFB979', { hidden: true, createdBy: maja }),
    { id: 'p-card', type: 'card', fill: '#FFFFFF', ownerId: pia, ownerName: 'Pia Larsen', ownerKind: 'person', text: 'CARD-TEXT', ...at(480, 360, 220, 120, { createdBy: maja }) },
    { id: 'p-link', type: 'link', url: 'https://tracker.example.net/SECRET-LINK-PATH', title: 'LINK-TITLE-TEXT', description: 'LINK-DESCRIPTION', unfurl: 'ok', ...at(760, 0, 240, 140, { createdBy: maja }) },
    { id: 'p-image', type: 'image', asset: imageHash, mime: 'image/png', nw: 64, nh: 48, ...at(760, 240, 192, 144, { createdBy: maja }) },
    { id: 'p-conn-private', type: 'connector', from: { kind: 'bound', id: 'p-public', anchor: 'auto' }, to: { kind: 'bound', id: 'p-private', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', stroke: '#18212B', z: '', createdBy: maja },
    { id: 'p-conn-frame', type: 'connector', from: { kind: 'bound', id: 'p-public', anchor: 'auto' }, to: { kind: 'bound', id: 'p-frame-child', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', stroke: '#18212B', z: '', createdBy: maja },
    { id: 'p-conn-public', type: 'connector', from: { kind: 'bound', id: 'p-public', anchor: 'auto' }, to: { kind: 'bound', id: 'p-shape', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow', stroke: '#18212B', label: 'CONNECTOR-LABEL', z: '', createdBy: maja },
  ];
  return objs;
}

/**
 * Writes the content of the seeded boards into `dataDir`. The directory rows must exist already (seed() in scripts/dev-seed-boards.mjs
 * makes them). Returns one entry per board written.
 * @param {{ dataDir: string, boards: { id: string, owner: string, template: string | null }[], people: { key: string, id: string }[], cacheDir?: string }} input
 */
export async function seedBoardContent({ dataDir, boards, people, cacheDir = path.join(root, '.dev-data', 'vite-seed-cache') }) {
  const vite = await createServer({
    root, configFile: false, cacheDir, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const written = [];
  const directory = openDirectory(path.join(dataDir, 'directory.sqlite'));
  try {
    const storeMod = await vite.ssrLoadModule('/src/store.ts');
    const templates = await vite.ssrLoadModule('/src/templates.ts');
    const labels = await vite.ssrLoadModule('/src/labels.ts');
    const markup = await vite.ssrLoadModule('/src/markup.ts');
    const commentsMod = await vite.ssrLoadModule('/src/comments.ts');
    const ownerIds = Object.fromEntries(people.map((p) => [p.key, p.id]));
    const assets = createAssetStore({
      dir: path.join(dataDir, 'assets'),
      index: directory,
      limits: { maxBytes: 10 * 1024 * 1024, boardQuota: 50 * 1024 * 1024, totalQuota: 0 },
    });

    for (const seeded of boards) {
      if (seeded.id === PRIVACY_BOARD_ID) {
        const ownerId = ownerIds[seeded.owner];
        const pia = ownerIds.pia;
        const omar = ownerIds.omar;
        const { row } = assets.put({ boardId: seeded.id, bytes: smallPng(), declaredType: 'image/png', userId: ownerId });
        const step = 'step-private';
        const objs = privacyObjects({ maja: ownerId, pia, imageHash: row.hash, step });
        const doc = new Y.Doc();
        const store = new storeMod.Store(doc);
        const zs = store.topZs(objs.length);
        objs.forEach((o, i) => { o.z = zs[i]; });
        store.seed(() => {
          for (const o of objs) store.create(o);
        });
        store.setFlow({ steps: [{ id: step, title: 'Silent writing', instructions: 'Write notes that stay private until the reveal.', mode: 'private-write', durationSec: 120 }] });
        const bytes = Y.encodeStateAsUpdate(doc);
        writeAtomic(path.join(dataDir, `${seeded.id}.yjs`), bytes);
        // one comment, by Omar, on the public sticky
        const commentsDoc = new Y.Doc();
        const comments = new commentsMod.Comments(commentsDoc);
        comments.addThread({ id: omar, name: 'Omar Haddad', color: '#2F6FED' }, { x: 20, y: 20, obj: 'p-public' }, 'COMMENT-TEXT-SECRET');
        writeAtomic(path.join(dataDir, `${seeded.id}~comments.yjs`), Y.encodeStateAsUpdate(commentsDoc));
        written.push({ id: seeded.id, objects: store.cache.size, steps: 1, comments: 1, image: row.hash });
        continue;
      }
      if (seeded.template === null) continue;
      const def = templates.TEMPLATES.find((t) => t.id === seeded.template);
      if (!def) throw new Error(`board ${seeded.id} uses template ${seeded.template}, which is not built in`);
      const ownerId = ownerIds[seeded.owner];
      if (!ownerId) throw new Error(`board ${seeded.id} has no owner in the seed`);

      // The build the app runs for a template: a Builder whose host is the person who starts the board, with the default fonts.
      const builder = new templates.Builder({ user: { id: ownerId }, store: { getMeta: () => storeMod.DEFAULT_META } }, 0, 0);
      def.build(builder);
      const objs = varyObjects(builder.objs, seeded.id);

      const doc = new Y.Doc();
      const store = new storeMod.Store(doc);
      const zs = store.topZs(objs.length);
      objs.forEach((o, i) => { o.z = zs[i]; });
      // as place() does: the labels join the board's by name, and a card that uses them takes the board's label ids
      store.seed(() => {
        const cards = objs.filter((o) => o.type === 'card' && o.labels?.length);
        if (cards.length) {
          const ids = labels.mergeTemplateLabels(store, builder.labels);
          for (const card of cards) {
            const next = card.labels.map((lid) => ids.get(lid)).filter(Boolean);
            if (next.length) card.labels = next;
            else {
              delete card.labels;
              card.h = markup.cardContentHeight(card, card.w);
            }
          }
        }
        for (const o of objs) store.create(o);
      });
      if (builder.steps.length) store.setFlow({ steps: builder.steps });
      // No meta name: the relay names a board's document after its directory title when the room loads (server/relay.mjs
      // nameFromDirectory), and a save copies the document's name back to the directory. A template name here would retitle the board.

      const bytes = Y.encodeStateAsUpdate(doc);
      // The round trip the relay makes when it opens the file: a fresh doc and a fresh Store see the same objects.
      const reopened = new Y.Doc();
      Y.applyUpdate(reopened, bytes);
      const check = new storeMod.Store(reopened);
      if (check.cache.size !== store.cache.size) {
        throw new Error(`board ${seeded.id}: ${check.cache.size} objects after the round trip, ${store.cache.size} before`);
      }

      writeAtomic(path.join(dataDir, `${seeded.id}.yjs`), bytes);
      written.push({ id: seeded.id, objects: store.cache.size, steps: builder.steps.length, comments: 0, image: null });
    }
  } finally {
    directory.close();
    await vite.close();
  }
  return written;
}
