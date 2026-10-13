import * as Y from 'yjs';
import { strToU8, zipSync } from 'fflate';
import fs from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { generateNKeysBetween } from 'fractional-indexing';
import { describe, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import { applyImported, ImportError, importBoard, IMPORT_LIMITS, missingFromImport, readBoardBytes, readFileLimited, toDrift, undoImport, type ImportedBoard, type UnzipStats } from '../src/exporters';
import { Comments } from '../src/comments';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import type { BoardApp } from '../src/app';
import type { Obj } from '../src/types';

const target = () => {
  const doc = new Y.Doc();
  return { doc, store: new Store(doc), comments: new Comments(new Y.Doc()) };
};
const file = (objects: Obj[], extra: Record<string, unknown> = {}) => ({ json: { format: 'driftboard', schemaVersion: 1, exportedAt: '', meta: { name: 'Theirs' }, objects, flow: {}, ...extra } }) as unknown as ImportedBoard;
const sticky = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 1, y: 2, w: 10, h: 10, rotation: 0, z: `z${id}`, text: id, createdBy: 'src', ...extra }) as unknown as Obj;
const instant = { confirm: async () => true };

describe('importBoard', () => {
  it('writes a large board in several messages, each within the budget, keeping families and connector ends together', async () => {
    const objs: Obj[] = [{ id: 'grp', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a' } as unknown as Obj];
    for (let i = 0; i < 9000; i++) objs.push(sticky(`s${i}`, { text: 'x'.repeat(100), ...(i < 3 ? { parent: 'grp' } : {}) }));
    objs.push({ id: 'ln', type: 'connector', z: 'zz', from: { kind: 'bound', id: 's8000', anchor: 'auto' }, to: { kind: 'bound', id: 's1', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' } as unknown as Obj);
    const t = target();
    const sizes: number[] = [];
    const chunkIds: string[][] = [];
    t.doc.on('update', (u: Uint8Array) => sizes.push(u.length));
    t.store.objects.observe((e) => chunkIds.push([...e.keysChanged]));
    const outcome = await importBoard(t, file(objs), 'me', instant);
    expect(outcome.ok).toBe(true);
    expect(t.store.objects.size).toBe(9002);
    expect(t.store.objects.has('grp')).toBe(true);
    expect(Math.max(...sizes)).toBeLessThan(2 * 1024 * 1024);
    expect(sizes.length).toBeGreaterThan(3);
    const together = (ids: string[]) => chunkIds.filter((c) => ids.some((id) => c.includes(id))).length === 1;
    expect(together(['grp', 's0', 's1', 's2', 's8000', 'ln'])).toBe(true);
  });

  it('puts the importer\'s identity on everything and drops the others', async () => {
    const t = target();
    const imported = file([sticky('a', { ownerId: 'stranger', ownerName: 'S' })], {
      polls: [{ id: 'p', question: 'q', options: [{ id: 'o', text: 't' }, { id: 'o2', text: 'u' }], multiple: false, anonymous: false, revealed: false, createdAt: 1, createdBy: 'src' }],
      pollAnswers: [{ pollId: 'p', userId: 'src', optionIds: ['o'], updatedAt: 1 }, { pollId: 'p', userId: 'me', optionIds: ['o'], updatedAt: 1 }],
    });
    const outcome = await importBoard(t, imported, 'me', instant);
    expect(outcome.ok).toBe(true);
    expect(t.store.objects.get('a')!.get('createdBy')).toBe('me');
    expect(t.store.objects.get('a')!.get('ownerId')).toBeUndefined();
    expect(t.store.polls.get('p')!.createdBy).toBe('me');
    expect([...t.store.pollAnswers.keys()]).toEqual(['p:me']);
  });

  it('is one undo step: settings and objects go in a single Undo, however many messages it took', async () => {
    const objs: Obj[] = Array.from({ length: 6000 }, (_, i) => sticky(`s${i}`, { text: 'x'.repeat(100) }));
    const t = target();
    await importBoard(t, file(objs), 'me', { confirm: async () => { await new Promise((r) => setTimeout(r, 400)); return true; } });
    expect(t.store.objects.size).toBe(6000);
    expect(t.store.undo.undoStack.length).toBe(1);
    t.store.undo.undo();
    expect(t.store.objects.size).toBe(0);
    expect(t.store.meta.get('name')).toBeUndefined();
  });

  it('stops at the first step the relay took back, says which part, and can remove exactly what was written', async () => {
    const objs: Obj[] = Array.from({ length: 6000 }, (_, i) => sticky(`s${i}`, { text: 'x'.repeat(100) }));
    const t = target();
    t.store.objects.set('mine', new Y.Map([['type', 'sticky']]));
    let calls = 0;
    const outcome = await importBoard(t, file(objs), 'me', {
      confirm: async () => {
        calls++;
        // the relay refuses the second objects message and reverts it
        if (calls === 3) for (const key of [...t.store.objects.keys()].slice(-50)) t.store.objects.delete(key);
        return true;
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refused');
    expect(outcome.failed).toMatch(/^objects \(\d+ of \d+\)$/);
    expect(t.store.objects.size).toBeLessThan(6000);
    expect(missingFromImport(t.store, outcome.manifest)).toEqual(['objects']);
    const removed = await undoImport(t.store, t.comments, outcome.manifest);
    expect(removed.removed).toBeGreaterThan(0);
    expect([...t.store.objects.keys()]).toEqual(['mine']);
    expect(t.store.meta.get('name')).toBeUndefined();
  });

  it('does not stop when the relay cannot be reached: it finishes on this device, pending, and can be removed', async () => {
    const t = target();
    let clock = 0;
    const objs = Array.from({ length: 6000 }, (_, i) => sticky(`s${i}`, { text: 'x'.repeat(100) }));
    const outcome = await importBoard(t, file(objs), 'me', { confirm: async () => false, firstWindowMs: 1000, finalWindowMs: 3000, retryMs: 1, now: () => (clock += 500) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pending).toBe(true);
    expect(t.store.objects.size).toBe(6000);
    expect(await outcome.final).toEqual({ state: 'unconfirmed' });
    const r = await undoImport(t.store, t.comments, outcome.manifest);
    expect(r.removed).toBeGreaterThan(5000);
    expect(t.store.objects.size).toBe(0);
  });

  it('confirms the last step too: refused later (a reconnect), unconfirmed after the window, confirmed when all arrived', async () => {
    const objs = [sticky('a'), sticky('b')];
    // all arrived
    let t = target();
    const ok = await importBoard(t, file(objs), 'me', instant);
    expect(ok.ok).toBe(true);
    expect(ok.ok && (await ok.final)).toEqual({ state: 'confirmed' });
    // the relay is unreachable at first, then answers after reverting the last step
    t = target();
    let asks = 0;
    const late = await importBoard(t, file(objs), 'me', {
      retryMs: 1,
      confirm: async () => {
        asks++;
        if (asks < 3) return false;
        t.store.objects.delete('b'); // the relay reverts the last step, then answers
        return true;
      },
      stepWindowMs: 60_000,
    });
    expect(late.ok).toBe(true);
    expect(late.ok && (await late.final)).toEqual({ state: 'refused', missing: ['objects'] });
    // never reachable
    t = target();
    let clock = 0;
    const never = await importBoard(t, file(objs), 'me', { retryMs: 1, now: () => (clock += 20_000), finalWindowMs: 60_000, stepWindowMs: 60_000, confirm: async () => t.store.objects.size === 0 });
    expect(never.ok).toBe(true);
    expect(never.ok && (await never.final)).toEqual({ state: 'unconfirmed' });
  });

  it('refuses a board with too many objects', async () => {
    const t = target();
    await expect(importBoard(t, file([sticky('a')]), 'me', { ...instant, limits: { ...IMPORT_LIMITS, objects: 0 } })).rejects.toThrow(ImportError);
  });
});

describe('file limits', () => {
  const tiny = { compressed: 1024 * 1024, expanded: 1024 * 1024, state: 512 * 1024, objects: 100, clients: 100, structs: 1_000_000 };
  const board = JSON.stringify({ format: 'driftboard', schemaVersion: 1, meta: {}, objects: [], flow: {} });

  it('refuses a file larger than the compressed limit, with a clear message', () => {
    expect(() => readBoardBytes(new Uint8Array(tiny.compressed + 1), tiny)).toThrow(/larger than 1 MiB/);
  });

  it('stops a zip bomb while it inflates: 40 MiB of zeros in 40 KB', () => {
    const bomb = zipSync({ 'board.json': strToU8(board), 'junk.bin': new Uint8Array(40 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => readBoardBytes(bomb, tiny)).toThrow(/expands to more than 1 MiB/);
  });

  it('stops a zip whose header lies about the size', () => {
    const bomb = zipSync({ 'board.json': strToU8(board), 'junk.bin': new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    // lower the original size in every header (local at offset 22 and central at offset 24 of each record) to look small
    const lying = bomb.slice();
    const view = new DataView(lying.buffer);
    for (let i = 0; i + 30 < lying.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 10, true);
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
    }
    let thrown: unknown = null;
    try { readBoardBytes(lying, tiny); } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
  });

  it('refuses a saved state larger than the limit and a state with too many objects', () => {
    const t = { ...tiny, state: 100 };
    const zip = zipSync({ 'board.json': strToU8(board), 'doc.yjs': new Uint8Array(500).map((_, i) => i % 251) });
    expect(() => readBoardBytes(zip, t)).toThrow(/board data in this file is larger/);
    const big = new Y.Doc();
    big.transact(() => { for (let i = 0; i < 150; i++) big.getMap('objects').set(`o${i}`, new Y.Map([['type', 'sticky']])); });
    const update = Y.encodeStateAsUpdate(big);
    const imported = readBoardBytes(zipSync({ 'board.json': strToU8(board), 'doc.yjs': update }), { ...tiny, state: 1024 * 1024 });
    return expect(importBoard(target(), imported, 'me', { ...instant, limits: tiny })).rejects.toThrow(/more than 100 objects/);
  });

  it('opens an ordinary file and the largest realistic one is far below the limits', () => {
    expect(IMPORT_LIMITS.compressed).toBeGreaterThan(20.6 * 1024 * 1024 * 4);
    const imported = readBoardBytes(strToU8(board));
    expect(imported.json.format).toBe('driftboard');
  });
});

/** A board with a bit of everything, for the round trip. */
function richApp(): BoardApp {
  const store = new Store(new Y.Doc());
  const comments = new Comments(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 600 }, { z: 'a5', createdBy: 'u1', headingFont: 'cabinet-grotesk', bodyFont: 'satoshi' });
  store.transact(() => {
    store.create({ id: 'frame', type: 'frame', x: 0, y: 0, w: 500, h: 400, rotation: 0, z: 'a0', name: 'Frame', createdBy: 'u1' } as unknown as Obj);
    store.create({ id: 'grp', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', parent: 'frame', createdBy: 'u1' } as unknown as Obj);
    store.create({ id: 'm1', type: 'sticky', x: 20, y: 30, w: 100, h: 100, rotation: 0, z: 'a2', parent: 'grp', text: 'One', createdBy: 'u1' } as unknown as Obj);
    store.create({ id: 'm2', type: 'sticky', x: 180, y: 30, w: 100, h: 100, rotation: 0, z: 'a3', parent: 'grp', text: 'Two', createdBy: 'u2', ownerId: 'u2', ownerName: 'Ula' } as unknown as Obj);
    store.create({ id: 'line', type: 'connector', z: 'a4', from: { kind: 'bound', id: 'm1', anchor: 'auto' }, to: { kind: 'bound', id: 'm2', anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow', createdBy: 'u1' } as unknown as Obj);
    store.create({ id: 'trk', type: 'tracker', x: 900, y: 0, w: 480, h: 360, rotation: 0, z: 'a6', trackerId: 'ws-1', view: 'inbox', createdBy: 'u1' } as unknown as Obj);
    store.create(container as unknown as Obj);
    lanes.forEach((l) => store.create(l as unknown as Obj));
  });
  addCard(store, lanes[0].id, 'A card', { createdBy: 'u1', font: 'satoshi' });
  store.setMeta({ name: 'Rich board', gridType: 'lines', stickyColors: ['#112233'] });
  store.polls.set('poll1', { id: 'poll1', question: 'Which?', options: [{ id: 'o1', text: 'A' }, { id: 'o2', text: 'B' }], multiple: false, anonymous: false, revealed: true, createdAt: 5, createdBy: 'u1', openedAt: 6 });
  store.pollState.set('poll1:revealed', true);
  store.pollAnswers.set('poll1:u2', { pollId: 'poll1', userId: 'u2', optionIds: ['o1'], updatedAt: 7, name: 'Ula', color: '#326DD3' });
  store.votes.set('s1:u2:v1', { itemId: 'm1', userId: 'u2', stepId: 's1' });
  store.labels.set('l1', { id: 'l1', name: 'Bug', color: 'pink', order: 0 });
  store.setFlow({ steps: [{ id: 's1', title: 'Vote', instructions: '', mode: 'vote' }], active: 0, reveal: false, timer: { startedAt: 1, durationMs: 1000 }, stepStartedAt: 3, results: null, focus: null });
  comments.addThread({ id: 'u2', name: 'Ula', color: '#326DD3' }, { x: 1, y: 2, obj: 'm1' }, 'A comment');
  return {
    store,
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [...store.polls.values()], answers: [...store.pollAnswers.values()] }) } },
    conn: { comments },
    images: { blobOf: async () => null },
  } as unknown as BoardApp;
}

describe('the user\'s own backup round trip', () => {
  it('exports a board and imports it into a fresh one (importedBy null) as the same board', async () => {
    const app = richApp();
    const bytes = await toDrift(app);
    const imported = readBoardBytes(bytes);
    const fresh = target();
    applyImported(fresh, imported, null);
    const plain = (s: Store) => ({
      objects: s.ordered().map((o) => o),
      raw: Object.fromEntries([...s.objects.entries()].map(([k, m]) => [k, m.toJSON()])),
      meta: s.meta.toJSON(), flow: s.flow.toJSON(), polls: s.polls.toJSON(), pollAnswers: s.pollAnswers.toJSON(),
      pollState: s.pollState.toJSON(), votes: s.votes.toJSON(), labels: s.labels.toJSON(),
    });
    const a = plain(app.store);
    const b = plain(fresh.store);
    expect(b.raw).toEqual(a.raw);
    expect(b.objects.map((o) => o.id)).toEqual(a.objects.map((o) => o.id)); // paint order (z-order) is the same
    expect(b.meta).toEqual(a.meta);
    expect(b.flow).toEqual(a.flow);
    expect(b.polls).toEqual(a.polls);
    expect(b.pollAnswers).toEqual(a.pollAnswers);
    expect(b.pollState).toEqual(a.pollState);
    expect(b.votes).toEqual(a.votes);
    expect(b.labels).toEqual(a.labels);
    // authors, owners and tracker frame fields are untouched in the user's own copy
    expect(b.raw.m2).toMatchObject({ createdBy: 'u2', ownerId: 'u2' });
    expect(b.raw.trk).toMatchObject({ trackerId: 'ws-1' });
    expect(fresh.comments.list().map((t) => t.text)).toEqual(['A comment']);
    expect(fresh.comments.list()[0].authorId).toBe('u2');
    expect(fresh.store.undo.undoStack.length).toBe(0);
  });

  it('the same file imported by someone else becomes theirs', async () => {
    const bytes = await toDrift(richApp());
    const t = target();
    const outcome = await importBoard(t, readBoardBytes(bytes), 'me', instant);
    expect(outcome.ok).toBe(true);
    const raw = Object.fromEntries([...t.store.objects.entries()].map(([k, m]) => [k, m.toJSON() as Record<string, unknown>]));
    expect(Object.values(raw).every((o) => o.createdBy === 'me')).toBe(true);
    expect(raw.m2.ownerId).toBeUndefined();
    expect(raw.m2.ownerName).toBe('Ula');
    expect(raw.trk.trackerId).toBeUndefined();
    expect(t.store.votes.size).toBe(0);
    expect(t.store.pollAnswers.size).toBe(0);
    expect(t.store.polls.get('poll1')!.createdBy).toBe('me');
    expect(t.store.getFlow().steps).toHaveLength(1);
    expect(t.comments.list()[0].imported).toBe(true);
  });

  // the relay's validator lives on another branch (cybersec/sync-validator): when it is here, show what it says before and after
  it.skipIf(!fs.existsSync(new URL('../server/sync-validate.mjs', import.meta.url)))('the relay\'s validator flags the file applied as is and accepts what importBoard wrote', async () => {
    const validatorPath = '../server/sync-validate.mjs';
    const { validateChangedKeys } = await import(/* @vite-ignore */ validatorPath) as { validateChangedKeys: (changes: unknown[], ctx: unknown) => { ok: boolean } };
    const bytes = await toDrift(richApp());
    const imported = readBoardBytes(bytes);
    const changesOf = (s: Store) => [
      ...[...s.objects.entries()].map(([key, m]) => ({ kind: 'object', key, value: m.toJSON(), isNew: true })),
      ...[...s.votes.entries()].map(([key, value]) => ({ kind: 'vote', key, value, isNew: true })),
      ...[...s.polls.entries()].map(([key, value]) => ({ kind: 'poll', key, value, isNew: true })),
      ...[...s.pollAnswers.entries()].map(([key, value]) => ({ kind: 'pollAnswer', key, value, isNew: true })),
    ];
    const ctx = { writer: { id: 'me', name: 'Me', role: 'owner' }, isBoardMember: (id: string) => id === 'me', canEditObject: () => true };
    const raw = new Store(new Y.Doc());
    Y.applyUpdate(raw.doc, imported.update!);
    const before = validateChangedKeys(changesOf(raw), ctx);
    expect(before.ok).toBe(false);
    const t = target();
    await importBoard(t, imported, 'me', instant);
    expect(validateChangedKeys(changesOf(t.store), ctx)).toEqual({ ok: true });
  });
});

describe('tables and Markdown blocks', () => {
  const ranks = (n: number) => generateNKeysBetween(null, null, n);
  const table = (id: string, rows: number, cols: number, extra: Record<string, unknown> = {}, text = (r: number, c: number) => `cell ${id} ${r}.${c}`): Obj => {
    const rr = ranks(rows), cc = ranks(cols);
    const o: Record<string, unknown> = { id, type: 'table', x: 0, y: 0, w: 400, h: 200, rotation: 0, z: `z${id}`, createdBy: 'src', headerRow: true, headerCol: false, ...extra };
    for (let r = 0; r < rows; r++) o[`r:r${r}`] = rr[r];
    for (let c = 0; c < cols; c++) { o[`k:c${c}`] = cc[c]; o[`w:c${c}`] = 120; }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) o[`c:r${r}:c${c}`] = text(r, c);
    return o as unknown as Obj;
  };
  const markdown = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'markdown', x: 0, y: 0, w: 300, h: 100, rotation: 0, z: `z${id}`, text: '# Plan\n\n- [ ] [one](#obj:abc)', createdBy: 'src', ...extra }) as unknown as Obj;
  const stored = (t: ReturnType<typeof target>, id: string) => t.store.objects.get(id)!.toJSON() as Record<string, unknown>;
  const withoutAuthor = (o: Record<string, unknown>) => { const { createdBy: _c, ...rest } = o; return rest; };
  const validatorPath = '../server/sync-validate.mjs';
  const ctx = { writer: { id: 'me', name: 'Me', role: 'owner' }, isBoardMember: (id: string) => id === 'me', canEditObject: () => true };
  const changesOf = (s: Store) => [...s.objects.entries()].map(([key, m]) => ({ kind: 'object', key, value: m.toJSON(), isNew: true }));

  it('imports nine 3,000-cell tables identically, in several messages that each stay within the budget, none split', async () => {
    const tables = [table('t1', 100, 30, { createdBy: 'stranger', proposedBy: { feature: 'generate', by: { id: 'stranger', name: 'S' } }, ownerId: 'stranger' }), ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => table(`t${i}`, 100, 30))];
    const t = target();
    const sizes: number[] = [];
    const perMessage: string[][] = [];
    t.doc.on('update', (u: Uint8Array) => sizes.push(u.length));
    t.store.objects.observe((e) => perMessage.push([...e.keysChanged]));
    const outcome = await importBoard(t, file(tables), 'me', instant);
    expect(outcome.ok).toBe(true);
    for (const src of tables) {
      const { proposedBy: _p, ownerId: _o, ...expected } = src as unknown as Record<string, unknown>;
      expect(withoutAuthor(stored(t, src.id))).toEqual(withoutAuthor(expected));
      expect(stored(t, src.id).createdBy).toBe('me');
    }
    expect(stored(t, 't1').proposedBy).toBeUndefined();
    expect(Object.keys(stored(t, 't1')).filter((k) => k.startsWith('c:'))).toHaveLength(3000);
    expect(perMessage.length).toBeGreaterThan(1);
    expect(perMessage.flat().sort()).toEqual(tables.map((o) => o.id));
    expect(Math.max(...sizes)).toBeLessThan(2 * 1024 * 1024);
    // what the relay's validator reads: no violation, one message at a time within its node budget
    const { validateChangedKeys } = await import(/* @vite-ignore */ validatorPath) as { validateChangedKeys: (changes: unknown[], ctx: unknown) => { ok: boolean } };
    expect(validateChangedKeys(changesOf(t.store), ctx)).toEqual({ ok: true });
    for (const ids of perMessage) expect(validateChangedKeys(changesOf(t.store).filter((c) => ids.includes(c.key)), { ...ctx, budget: { bytes: 2 * 1024 * 1024, nodes: 50_000, exhausted: false } })).toEqual({ ok: true });
  });

  it('maps the identity fields of a table and a Markdown block, and the validator accepts the result', async () => {
    const t = target();
    const outcome = await importBoard(t, file([
      table('t', 2, 2, { createdBy: 'stranger', ownerId: 'stranger', ownerName: 'Sam', ownerKind: 'agent', trackerId: 'w1', proposedBy: { feature: 'cluster', by: { id: 'stranger', name: 'Sam' } } }),
      markdown('m', { createdBy: 'stranger', ownerId: 'stranger', ownerName: 'Sam', proposedBy: { feature: 'summarise', by: { id: 'stranger', name: 'Sam' } } }),
    ]), 'me', instant);
    expect(outcome.ok).toBe(true);
    for (const id of ['t', 'm']) {
      const o = stored(t, id);
      expect(o.createdBy).toBe('me');
      for (const f of ['ownerId', 'ownerName', 'ownerKind', 'trackerId', 'proposedBy']) expect(o[f]).toBeUndefined();
    }
    expect(stored(t, 'm').text).toBe('# Plan\n\n- [ ] [one](#obj:abc)');
    const { validateChangedKeys } = await import(/* @vite-ignore */ validatorPath) as { validateChangedKeys: (changes: unknown[], ctx: unknown) => { ok: boolean } };
    expect(validateChangedKeys(changesOf(t.store), ctx)).toEqual({ ok: true });
  });

  it('drops forbidden keys inside a table, also those in a part key, and writes the rest', async () => {
    const src = JSON.parse(JSON.stringify(table('t', 2, 2)));
    Object.assign(src, JSON.parse('{"__proto__":{"polluted":1},"c:__proto__:c0":"x","c:r0:constructor":"y","c:r0:c0":"kept"}'));
    const t = target();
    const outcome = await importBoard(t, file([src as Obj]), 'me', instant);
    expect(outcome.ok).toBe(true);
    const o = stored(t, 't');
    expect(Object.keys(o).filter((k) => /proto|constructor/.test(k))).toEqual([]);
    expect(o['c:r0:c0']).toBe('kept');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a file with a table past the limits of the editor, before anything is written', async () => {
    const t = target();
    await expect(importBoard(t, file([sticky('s'), table('big', 101, 3)]), 'me', instant)).rejects.toThrow(/101 rows \(up to 100\)/);
    expect(t.store.objects.size).toBe(0);
    expect(() => applyImported(t, file([table('wide', 2, 31)]), 'me')).toThrow(/31 columns/);
    expect(t.store.objects.size).toBe(0);
  });

  it('Remove imported content takes away an untouched table and Markdown block, and leaves a table whose cell was edited since', async () => {
    const t = target();
    const outcome = await importBoard(t, file([table('edited', 3, 3), table('untouched', 3, 3), markdown('md-edited'), markdown('md-untouched')]), 'me', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    t.store.objects.get('edited')!.set('c:r1:c1', 'changed by someone');
    t.store.objects.get('md-edited')!.set('text', 'rewritten');
    const r = undoImport(t.store, t.comments, outcome.manifest);
    expect(r.left).toBe(2);
    expect([...t.store.objects.keys()].sort()).toEqual(['edited', 'md-edited']);
    expect(stored(t, 'edited')['c:r1:c1']).toBe('changed by someone');
  });

  it('a table is digested by all its parts: a new row, a removed cell, a width or a fill each make it edited since', async () => {
    for (const edit of [(m: Y.Map<unknown>) => m.set('r:rnew', 'a5'), (m: Y.Map<unknown>) => m.delete('c:r0:c0'), (m: Y.Map<unknown>) => m.set('w:c0', 300), (m: Y.Map<unknown>) => m.set('f:r0:c0', '#FFE16B'), (m: Y.Map<unknown>) => m.set('headerRow', false)]) {
      const t = target();
      const outcome = await importBoard(t, file([table('t', 2, 2)]), 'me', instant);
      if (!outcome.ok) throw new Error('import failed');
      edit(t.store.objects.get('t') as Y.Map<unknown>);
      expect(undoImport(t.store, t.comments, outcome.manifest).left).toBe(1);
      expect(t.store.objects.has('t')).toBe(true);
    }
  });

  it('the user\'s own backup brings a table and a Markdown block back unchanged, identity and all', async () => {
    const t0 = target();
    const originals = [table('t', 4, 3, { createdBy: 'ana', proposedBy: { feature: 'generate', by: { id: 'ana', name: 'Ana' } } }), markdown('m', { createdBy: 'ana' })];
    t0.store.transact(() => originals.forEach((o) => t0.store.create(o)));
    const app = { store: t0.store, flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } }, conn: { comments: t0.comments }, images: { blobOf: async () => null } } as unknown as BoardApp;
    const t = target();
    applyImported(t, readBoardBytes(await toDrift(app)), null);
    for (const o of originals) expect(stored(t, o.id)).toEqual(t0.store.objects.get(o.id)!.toJSON());
    expect(stored(t, 't').createdBy).toBe('ana');
    expect(stored(t, 't').proposedBy).toEqual({ feature: 'generate', by: { id: 'ana', name: 'Ana' } });
  });
});

/** Live ArrayBuffer memory (after a collection) at its highest while `run` goes, minus what was live before. */
function peakArrayBuffers(run: (stats: UnzipStats) => void): { peak: number; stats: UnzipStats } {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const stats: UnzipStats = { total: 0, maxChunk: 0, onChunk: () => { gc(); peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); } };
  try { run(stats); } catch { /* the caller asserts on the stats */ }
  return { peak, stats };
}

describe('what a file may expand to is enforced while it inflates', () => {
  const board = strToU8(JSON.stringify({ format: 'driftboard', schemaVersion: 1, meta: {}, objects: [], flow: {} }));
  const limits = { compressed: 8 * 1024 * 1024, expanded: 8 * 1024 * 1024, state: 4 * 1024 * 1024, objects: 100, clients: 100, structs: 1_000_000 };
  const MARGIN = 8 * 1024 * 1024;

  it('stops a 256 MiB zero bomb after about the cap, and the live memory it needed stays near the cap', () => {
    // a header that tells the truth is caught before one byte inflates; the lie below is the real test
    const bomb = zipSync({ 'board.json': board, 'junk.bin': new Uint8Array(256 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => readBoardBytes(bomb, limits)).toThrow(/expands to more than 8 MiB/);
  });

  it('an understated header cannot hide a bomb: the declared sizes are 10 bytes, the data is 256 MiB', () => {
    const bomb = zipSync({ 'board.json': board, 'junk.bin': new Uint8Array(256 * 1024 * 1024) }, { level: 9 });
    const lying = bomb.slice();
    const view = new DataView(lying.buffer);
    for (let i = 0; i + 30 < lying.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 10, true);
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
    }
    const { peak, stats } = peakArrayBuffers((st) => readBoardBytes(lying, limits, st));
    expect(stats.total).toBeGreaterThan(limits.expanded); // it did inflate past the cap, and stopped there
    expect(stats.total).toBeLessThan(limits.expanded + 4 * 1024 * 1024);
    expect(stats.maxChunk).toBeLessThan(4 * 1024 * 1024);
    // live memory (measured after a collection at every piece; about 19 MiB for the 8 MiB cap here): the pieces kept so far, the piece
    // being produced, the inflater's own buffers and the compressed input. It does not grow with the 256 MiB the file claims.
    expect(peak).toBeLessThan(limits.expanded * 2 + 2 * stats.maxChunk + MARGIN);
  });

  it('the 409 KB zip that expands to 419 MB: an honest header is refused before inflating, a lying one stops at the cap with memory near the cap', () => {
    const bomb = zipSync({ 'board.json': board, 'junk.bin': new Uint8Array(419_430_400) }, { level: 9 });
    expect(bomb.length).toBeLessThan(450_000);
    const cap = { ...limits, expanded: 16 * 1024 * 1024 };
    expect(() => readBoardBytes(bomb, cap)).toThrow(/expands to more than 16 MiB/);
    const lying = bomb.slice();
    const view = new DataView(lying.buffer);
    for (let i = 0; i + 30 < lying.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 10, true);
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
    }
    const { peak, stats } = peakArrayBuffers((st) => readBoardBytes(lying, cap, st));
    expect(stats.total).toBeGreaterThan(cap.expanded);
    expect(stats.total).toBeLessThan(cap.expanded + 4 * 1024 * 1024);
    expect(peak).toBeLessThan(cap.expanded * 2 + 2 * stats.maxChunk + MARGIN);
  });

  it('a data file over the state limit is stopped while it inflates, not after', () => {
    const wide = { ...limits, expanded: 64 * 1024 * 1024 };
    const zip = zipSync({ 'board.json': board, 'doc.yjs': new Uint8Array(40 * 1024 * 1024) }, { level: 9 });
    const lying = zip.slice();
    const view = new DataView(lying.buffer);
    for (let i = 0; i + 30 < lying.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 10, true);
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true);
    }
    const stats: UnzipStats = { total: 0, maxChunk: 0 };
    expect(() => readBoardBytes(lying, wide, stats)).toThrow(/board data in this file is larger than 4 MiB/);
    expect(stats.total).toBeLessThan(wide.state + 4 * 1024 * 1024 + board.length);
  });

  it('accepts a file exactly at each limit and refuses one byte over', () => {
    const exact = (n: number) => new Uint8Array(n).fill(0x20);
    // compressed: a JSON file of exactly the limit (spaces around a board), then one byte more
    const json = (n: number) => { const out = exact(n); out.set(board, 0); return out; };
    expect(readBoardBytes(json(limits.state), { ...limits, compressed: limits.state }).json.format).toBe('driftboard');
    expect(() => readBoardBytes(json(limits.state + 1), { ...limits, compressed: limits.state + 1 })).toThrow(/larger than 4 MiB/);
    expect(() => readBoardBytes(json(limits.compressed + 1), limits)).toThrow(/larger than 8 MiB/);
    // expanded: all files together exactly at the limit, then one byte over
    const at = (extra: number) => zipSync({ 'board.json': board, 'a.bin': new Uint8Array(limits.expanded - board.length + extra) }, { level: 9 });
    expect(Object.keys(readBoardBytes(at(0), limits).assets ?? {})).toEqual([]);
    expect(() => readBoardBytes(at(1), limits)).toThrow(/expands to more than 8 MiB/);
  });

  it('a Yjs state that declares a huge structure is refused from its header, before anything is decoded', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, 900_000_000); // structs of the first client
    const huge = encoding.toUint8Array(enc);
    const imported = { json: { format: 'driftboard', schemaVersion: 1, exportedAt: '', meta: {}, objects: [], flow: {} }, update: huge } as unknown as ImportedBoard;
    return expect(importBoard(target(), imported, 'me', instant)).rejects.toThrow(/board data in this file is larger/);
  });

  it('checks the file size before reading a byte, and stops a stream that outgrows its size', async () => {
    const big = { size: 200 * 1024 * 1024, arrayBuffer: vi.fn<() => void>(), stream: vi.fn<() => void>() } as unknown as Blob;
    await expect(readFileLimited(big, IMPORT_LIMITS.compressed, 'too big')).rejects.toThrow('too big');
    expect((big as unknown as { arrayBuffer: ReturnType<typeof vi.fn<() => void>> }).arrayBuffer).not.toHaveBeenCalled();
    expect((big as unknown as { stream: ReturnType<typeof vi.fn<() => void>> }).stream).not.toHaveBeenCalled();
    let pulled = 0;
    let cancelled = false;
    const lying = {
      size: 10,
      stream: () => new ReadableStream<Uint8Array>({
        pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); },
        cancel() { cancelled = true; },
      }),
    } as unknown as Blob;
    await expect(readFileLimited(lying, 4096, 'too big')).rejects.toThrow('too big');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    const real = await readFileLimited(new Blob([new Uint8Array(5000).fill(7)]), 10_000, 'x');
    expect(real.length).toBe(5000);
  });
});

describe('removing an import', () => {
  it('keeps a board name the person changed since, restores a setting that is still as imported, and removes the imported comments', async () => {
    const source = richApp();
    const bytes = await toDrift(source);
    const t = target();
    t.store.setMeta({ name: 'My new board', gridType: 'dots' });
    t.store.undo.clear();
    const outcome = await importBoard(t, readBoardBytes(bytes), 'me', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(t.store.meta.get('name')).toBe('Rich board');
    expect(t.comments.list()).toHaveLength(1);
    // the person renames the board after the import
    t.store.setMeta({ name: 'Renamed by me' });
    const r = await undoImport(t.store, t.comments, outcome.manifest);
    expect(t.store.meta.get('name')).toBe('Renamed by me');
    expect(t.store.meta.get('gridType')).toBe('dots'); // was 'lines' from the file; restored to the value it had before the import
    expect(r.left).toBeGreaterThanOrEqual(1);
    expect(r.restored).toBeGreaterThanOrEqual(1);
    expect(t.comments.list()).toHaveLength(0);
    expect(r.comments).toBe(1);
    expect(t.store.objects.size).toBe(0);
    expect(t.store.votes.size + t.store.polls.size + t.store.pollAnswers.size).toBe(0);
  });

  it('leaves an imported object the person has edited since, and a comment thread somebody replied to keeps its reply', async () => {
    const bytes = await toDrift(richApp());
    const t = target();
    const outcome = await importBoard(t, readBoardBytes(bytes), 'me', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    t.store.objects.get('m1')!.set('text', 'I edited this');
    const thread = t.comments.list()[0];
    t.comments.reply(thread.id, { id: 'me', name: 'Me', color: '#326DD3' }, 'my reply');
    const r = await undoImport(t.store, t.comments, outcome.manifest);
    expect(t.store.objects.has('m1')).toBe(true);
    expect(r.left).toBeGreaterThanOrEqual(1);
    expect(t.store.objects.has('m2')).toBe(false);
    const left = t.comments.list();
    expect(left).toHaveLength(1);
    expect(left[0].replies.map((x) => x.text)).toEqual(['my reply']);
  });
});
