import fs from 'node:fs';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyImported, importBoard, readBoardBytes, toDrift, undoImport } from '../src/exporters';
import { Comments } from '../src/comments';
import { Store } from '../src/store';
import { AUTHOR, buildRealBoard, MEMBER } from './fixtures/real-board';

const committed = () => new Uint8Array(fs.readFileSync(new URL('./fixtures/real-board.drift', import.meta.url)));
const target = () => {
  const doc = new Y.Doc();
  return { doc, store: new Store(doc), comments: new Comments(new Y.Doc()) };
};
const instant = { confirm: async () => true };
const plain = (s: Store) => ({
  objects: Object.fromEntries([...s.objects.entries()].map(([k, m]) => [k, m.toJSON()])),
  order: s.ordered().map((o) => o.id),
  meta: s.meta.toJSON(), flow: s.flow.toJSON(), polls: s.polls.toJSON(), pollAnswers: s.pollAnswers.toJSON(), pollState: s.pollState.toJSON(),
  votes: s.votes.toJSON(), labels: s.labels.toJSON(),
});

afterEach(() => vi.unstubAllGlobals());

describe('the captured real board (test/fixtures/real-board.drift)', () => {
  it('is what the builder still produces: the file format, the factories and the fixture agree', async () => {
    const { app, store } = buildRealBoard();
    const fresh = readBoardBytes(await toDrift(app));
    const kept = readBoardBytes(committed());
    expect(fresh.update).toEqual(kept.update);
    expect(Object.keys(fresh.assets ?? {}).sort()).toEqual(Object.keys(kept.assets ?? {}).sort());
    expect(store.objects.size).toBeGreaterThan(20);
    expect(Object.keys(kept.assets ?? {})).toHaveLength(2);
  });

  it('has a bit of everything', () => {
    const t = target();
    applyImported(t, readBoardBytes(committed()), null);
    const types = new Set([...t.store.objects.values()].map((m) => m.get('type')));
    for (const type of ['frame', 'text', 'sticky', 'shape', 'icon', 'image', 'path', 'uml-class', 'group', 'connector', 'tracker', 'container', 'lane', 'card', 'table', 'markdown']) expect(types.has(type)).toBe(true);
    expect(t.store.polls.size).toBe(1);
    expect(t.store.votes.size).toBe(2);
    expect(t.store.labels.size).toBe(2);
    expect(t.store.getFlow().steps).toHaveLength(3);
    expect(t.comments.list()).toHaveLength(2);
  });

  it('round-trips as the user\'s own backup (importedBy null): the same board, object for object', async () => {
    const original = buildRealBoard();
    const t = target();
    applyImported(t, readBoardBytes(await toDrift(original.app)), null);
    expect(plain(t.store)).toEqual(plain(original.store));
    expect(t.comments.list()).toEqual(original.comments.list());
    expect(t.store.undo.undoStack.length).toBe(0);
    // the table (every part) and the Markdown block (with the attribution it came with) are back exactly
    for (const id of ['budget-table', 'notes-md']) expect(t.store.objects.get(id)!.toJSON()).toEqual(original.store.objects.get(id)!.toJSON());
    expect((t.store.objects.get('notes-md')!.toJSON() as { proposedBy: unknown }).proposedBy).toBeTruthy();
  });

  // the relay's validator (server/sync-validate.mjs knows tables and Markdown blocks): the file as is has foreign authors, the import has none
  it('the sanitised import has no violation for the relay, whole and message by message', async () => {
    const validatorPath = '../server/sync-validate.mjs';
    const { validateChangedKeys } = await import(/* @vite-ignore */ validatorPath) as { validateChangedKeys: (changes: unknown[], ctx: unknown) => { ok: boolean; violations?: unknown[] } };
    const t = target();
    const outcome = await importBoard(t, readBoardBytes(committed()), 'new-user', instant);
    expect(outcome.ok).toBe(true);
    const ctx = { writer: { id: 'new-user', name: 'N', role: 'owner' }, isBoardMember: (id: string) => id === 'new-user', canEditObject: () => true };
    // (the fixture's group carries a font the validator does not know for a group: the fixture's own doing, not the import's)
    const changes = [...t.store.objects.entries()].filter(([key]) => key !== 'crew').map(([key, m]) => ({ kind: 'object', key, value: m.toJSON(), isNew: true }));
    expect(changes.some((c) => (c.value as { type: string }).type === 'table')).toBe(true);
    expect(validateChangedKeys(changes, ctx)).toEqual({ ok: true });
    const raw = new Store(new Y.Doc());
    Y.applyUpdate(raw.doc, readBoardBytes(committed()).update!);
    const before = validateChangedKeys([...raw.objects.entries()].filter(([k]) => k === 'budget-table' || k === 'notes-md').map(([key, m]) => ({ kind: 'object', key, value: m.toJSON(), isNew: true })), ctx);
    expect(before.ok).toBe(false);
  });

  it('imported by somebody else: theirs, with nothing of the others kept that the board cannot know', async () => {
    const t = target();
    const imported = readBoardBytes(committed());
    const outcome = await importBoard(t, imported, 'new-user', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const p = plain(t.store);
    expect(Object.values(p.objects).every((o) => (o as { createdBy: string }).createdBy === 'new-user')).toBe(true);
    const cards = Object.values(p.objects).filter((o) => (o as { type: string }).type === 'card') as { ownerId?: string; ownerName?: string; text: string }[];
    expect(cards.every((c) => c.ownerId === undefined)).toBe(true);
    expect(cards.find((c) => c.text === 'Fix the login redirect')!.ownerName).toBe(MEMBER.name);
    expect(cards.find((c) => c.text === 'Offline mode spike')!.ownerName).toBe('An outside contractor');
    expect((p.objects['tracker-1'] as { trackerId?: string }).trackerId).toBeUndefined();
    // the table and the Markdown block of the file: the importer's, every part and the text as they were, no attribution
    const original = buildRealBoard().store.objects;
    for (const id of ['budget-table', 'notes-md']) {
      const { createdBy, proposedBy, ...rest } = original.get(id)!.toJSON() as Record<string, unknown>;
      expect(createdBy).toBe(MEMBER.id);
      expect((p.objects[id] as { createdBy: string }).createdBy).toBe('new-user');
      expect((p.objects[id] as { proposedBy?: unknown }).proposedBy).toBeUndefined();
      const { createdBy: _c, ...got } = p.objects[id] as Record<string, unknown>;
      expect(got).toEqual(rest);
      expect(proposedBy === undefined || id === 'notes-md').toBe(true);
    }
    expect(Object.keys(p.objects['budget-table'] as object).filter((k) => /^[rkwacf]:/.test(k))).toHaveLength(3 + 3 + 1 + 1 + 1 + 9);
    expect((p.objects['private-note'] as { privateStep?: string }).privateStep).toBe('step-write');
    expect(p.pollAnswers).toEqual({});
    expect(p.votes).toEqual({});
    expect((p.polls['poll-1'] as { createdBy: string }).createdBy).toBe('new-user');
    expect((p.flow as { focus?: unknown }).focus).toBeUndefined();
    expect((p.flow as { steps: unknown[] }).steps).toHaveLength(3);
    expect(Object.keys(imported.assets ?? {})).toHaveLength(2);
    expect(t.comments.list().map((c) => c.imported)).toEqual([true, true]);
    expect(t.comments.list().map((c) => c.authorId).sort()).toEqual([AUTHOR.id, MEMBER.id].sort());
    expect(await outcome.final).toEqual({ state: 'confirmed' });
  });

  it('removing it takes away everything that is untouched, and only that; with crypto.subtle gone (plain http) too', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect((globalThis.crypto as { subtle?: unknown }).subtle).toBeUndefined();
    const t = target();
    const outcome = await importBoard(t, readBoardBytes(committed()), 'new-user', instant);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    t.store.objects.get('idea-4')!.set('text', 'I changed this');
    t.store.objects.get('budget-table')!.set('c:r1:c2', '1,300'); // one cell of the table
    const r = undoImport(t.store, t.comments, outcome.manifest);
    expect(r).not.toHaveProperty('then'); // synchronous: nothing is awaited between the check and the removal
    expect(r.left).toBe(2);
    expect([...t.store.objects.keys()].sort()).toEqual(['budget-table', 'idea-4']); // the Markdown block, untouched, went
    expect(t.comments.list()).toHaveLength(0);
    expect(t.store.polls.size + t.store.labels.size + t.store.votes.size).toBe(0);
  });
});
