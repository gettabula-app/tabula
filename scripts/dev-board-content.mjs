#!/usr/bin/env node
// DEV ONLY. Gives the seeded boards of scripts/dev-seed-boards.mjs their real content, and their pictures for the Boards cards.
//
// A seeded board with a built-in template gets that template's objects and steps (the same ones the app inserts when a person starts
// a board from it), with a little variation per board: some stickies are left out or re-worded, some frames are emptied, one sticky is
// hidden for everyone. The variation comes from a hash of the board id, so a reseed gives the same boards. The result is written as the
// room file the relay opens (`<dataDir>/<id>.yjs`, the Yjs update of the board's Store), then the picture of what everyone may see
// (`<dataDir>/dev-previews/<id>.svg`, server/dev-previews.mjs). A board with no template is left empty, as before.
//
// The code is the app's own: Vite loads src/store.ts, src/templates.ts and the picture modules in Node (ssrLoadModule), so there is no
// second copy of the object model here. The write mirrors place() in src/templates.ts (the part that needs no BoardApp).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as Y from 'yjs';
import { writePreview } from '../server/dev-previews.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Texts a sticky may be re-worded to. A picture draws no words, so this only changes what the board says when opened. */
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
 * The objects of a template after the variation for board `id`. Stickies may go or be re-worded, one may be hidden for everyone,
 * and some frames lose their notes. Connectors whose bound end went are dropped with it. Mutates and returns the given objects.
 */
export function varyObjects(objs, id) {
  const rand = generatorFor(id);
  const emptied = new Set(objs.filter((o) => o.type === 'frame' && rand() < 0.3).map((o) => o.id));
  const removed = new Set();
  let hidden = false;
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
      if (!hidden && rand() < 0.05) {
        o.hidden = true;
        hidden = true;
      }
    }
    kept.push(o);
  }
  return kept.filter((o) => o.type !== 'connector' || [o.from, o.to].every((end) => end.kind !== 'bound' || !removed.has(end.id)));
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/**
 * Writes the content and the pictures of the seeded boards into `dataDir`. The directory rows must exist already (seed() in
 * scripts/dev-seed-boards.mjs makes them). Returns one entry per board written.
 * @param {{ dataDir: string, boards: { id: string, owner: string, template: string | null }[], people: { key: string, id: string }[], cacheDir?: string }} input
 */
export async function seedBoardContent({ dataDir, boards, people, cacheDir = path.join(root, '.dev-data', 'vite-seed-cache') }) {
  const vite = await createServer({
    root, configFile: false, cacheDir, logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const written = [];
  try {
    const storeMod = await vite.ssrLoadModule('/src/store.ts');
    const templates = await vite.ssrLoadModule('/src/templates.ts');
    const labels = await vite.ssrLoadModule('/src/labels.ts');
    const markup = await vite.ssrLoadModule('/src/markup.ts');
    const picture = await vite.ssrLoadModule('/src/preview-render.ts');
    const ownerIds = Object.fromEntries(people.map((p) => [p.key, p.id]));

    for (const seeded of boards) {
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
      writePreview(dataDir, seeded.id, picture.storePreviewSvg(store));
      written.push({ id: seeded.id, objects: store.cache.size, steps: builder.steps.length });
    }
  } finally {
    await vite.close();
  }
  return written;
}
