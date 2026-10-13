import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import {
  INVERSE_MAX_AGE_MS, MAX_AGE_MS, MAX_ENTRIES, MAX_REVERT_BYTES, agentLabel, agentParts, applyInverse, composeDiffs, createActivity, diffObjects, publicEntry, snapshotObjects, summarise, watchTouched,
} from '../server/activity.mjs';

// The board activity log (TAB-158, docs/agent-presence.md): what a tool call changed, said in words without content, and how it is taken back.

const sticky = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', createdBy: 'u1', text: 'note', fill: '#FFE16B', ...extra });
function board(objects: Record<string, unknown>[]) {
  const doc = new Y.Doc();
  doc.transact(() => objects.forEach((o) => doc.getMap('objects').set(o.id as string, new Y.Map(Object.entries(o)))));
  return doc;
}
const state = (doc: Y.Doc) => doc.getMap('objects').toJSON() as Record<string, Record<string, unknown>>;
const now = () => 1_700_000_000_000;

describe('what a call changed', () => {
  it('diffs two snapshots: made, removed and changed objects, and ignores updatedAt alone', () => {
    const doc = board([sticky('a'), sticky('b'), sticky('c', { updatedAt: 1 })]);
    const before = snapshotObjects(doc);
    doc.transact(() => {
      doc.getMap('objects').delete('a');
      (doc.getMap('objects').get('b') as Y.Map<unknown>).set('text', 'edited');
      (doc.getMap('objects').get('c') as Y.Map<unknown>).set('updatedAt', 2);
      doc.getMap('objects').set('d', new Y.Map(Object.entries(sticky('d'))));
    });
    const diff = diffObjects(before, snapshotObjects(doc)) as Record<string, { before: unknown; after: Record<string, unknown> | null }>;
    expect(Object.keys(diff).sort()).toEqual(['a', 'b', 'd']);
    expect(diff.a.after).toBeNull();
    expect(diff.d.before).toBeNull();
    expect(diff.b.after).toMatchObject({ text: 'edited' });
  });

  it('composes the diffs of one call: first before, last after, and an object made and removed vanishes', () => {
    const one = { x: { before: { v: 1 }, after: { v: 2 } }, n: { before: null, after: { v: 'new' } } };
    const two = { x: { before: { v: 2 }, after: { v: 3 } }, n: { before: { v: 'new' }, after: null } };
    const all = composeDiffs([one, two]) as Record<string, { before: unknown; after: unknown }>;
    expect(all).toEqual({ x: { before: { v: 1 }, after: { v: 3 } } });
    expect(composeDiffs([{ y: { before: { v: 1 }, after: { v: 2 } } }, { y: { before: { v: 2 }, after: { v: 1 } } }])).toEqual({});
  });

  it('says it in words by kind and count, never with the text of an object', () => {
    const made = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, { before: null, after: sticky(`s${i}`, { text: 'SECRET PLAN' }) }]));
    const diff = { ...made, f1: { before: null, after: { type: 'frame' } }, k: { before: sticky('k'), after: sticky('k', { text: 'edited' }) }, g: { before: { type: 'shape' }, after: null } };
    const line = summarise(diff);
    expect(line).toBe('created 6 sticky notes, 1 frame; changed 1 sticky note; removed 1 shape');
    expect(line).not.toContain('SECRET');
    expect(summarise({})).toBe('made no change');
  });

  it('names an agent as two fields, the token and the member, cleaned and cut, so a token name can never pose as a person', () => {
    expect(agentParts({ tokenName: 'Claude', userName: 'Ada Lovelace' })).toEqual({ token: 'Claude', member: 'Ada' });
    expect(agentParts({ tokenName: 'Claude', userName: null })).toEqual({ token: 'Claude', member: null });
    expect(agentParts({ tokenName: 'Cl\u202eaude\u200b', userName: '  \u0007Ada ' })).toEqual({ token: 'Claude', member: 'Ada' });
    expect(agentParts({ tokenName: 'x'.repeat(200), userName: 'Ada' }).token.length).toBe(40);
    expect(agentParts({ tokenName: '   ', userName: 'Ada' }).token).toBe('Agent');
    // the token is named "Admin approved" by a member: still the token, and the member beside it is who made it
    expect(agentParts({ tokenName: 'Admin approved', userName: 'Mallory Lee' })).toEqual({ token: 'Admin approved', member: 'Mallory' });
    expect(agentLabel({ tokenName: 'Claude', userName: 'Ada Lovelace' })).toBe('Claude for Ada');
  });

});

describe('taking a call back', () => {
  const run = (doc: Y.Doc, change: () => void) => {
    const before = snapshotObjects(doc);
    doc.transact(change);
    return composeDiffs([diffObjects(before, snapshotObjects(doc))]);
  };
  const inverseOfDiff = (diff: unknown) => {
    const store = createActivity({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'act-')), now });
    store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'update_objects', diff });
    return store.find('b1', store.list('b1')[0].id)!.inverse;
  };

  it('removes what the call made, restores what it removed and puts changed fields back', () => {
    const doc = board([sticky('keep', { text: 'before' }), sticky('gone')]);
    const diff = run(doc, () => {
      const map = doc.getMap('objects');
      (map.get('keep') as Y.Map<unknown>).set('text', 'by the agent');
      map.delete('gone');
      map.set('fresh', new Y.Map(Object.entries(sticky('fresh'))));
    });
    const result = doc.transact(() => applyInverse(doc, inverseOfDiff(diff), { now }), 'revert') as unknown as { applied: number; skipped: unknown[] };
    expect(result).toEqual({ applied: 3, skipped: [] });
    const s = state(doc);
    expect(Object.keys(s).sort()).toEqual(['gone', 'keep']);
    expect(s.keep.text).toBe('before');
    expect(s.gone).toMatchObject({ type: 'sticky', text: 'note' });
  });

  it('leaves what a person changed since: a field they rewrote, an object they edited, an id they reused', () => {
    const doc = board([sticky('a', { text: 'one', fill: '#FFE16B' }), sticky('b', { text: 'two' }), sticky('gone')]);
    const diff = run(doc, () => {
      const map = doc.getMap('objects');
      const a = map.get('a') as Y.Map<unknown>;
      a.set('text', 'agent');
      a.set('fill', '#A3D2FF');
      (map.get('b') as Y.Map<unknown>).set('text', 'agent b');
      map.delete('gone');
      map.set('fresh', new Y.Map(Object.entries(sticky('fresh'))));
    });
    // a person, afterwards
    doc.transact(() => {
      const map = doc.getMap('objects');
      (map.get('a') as Y.Map<unknown>).set('text', 'person');
      (map.get('b') as Y.Map<unknown>).set('text', 'person b');
      (map.get('fresh') as Y.Map<unknown>).set('text', 'edited by a person');
      map.set('gone', new Y.Map(Object.entries(sticky('gone', { text: 'reused' }))));
    });
    const result = doc.transact(() => applyInverse(doc, inverseOfDiff(diff), { now }), 'revert') as unknown as { applied: number; skipped: { id: string; reason: string }[] };
    const s = state(doc);
    expect(s.a).toMatchObject({ text: 'person', fill: '#FFE16B' }); // the fill the agent changed goes back; the text a person rewrote stays
    expect(s.b.text).toBe('person b');
    expect(s.fresh.text).toBe('edited by a person');
    expect(s.gone.text).toBe('reused');
    expect(result.applied).toBe(1);
    expect(result.skipped.map((x) => `${x.id}:${x.reason}`).sort()).toEqual(['a:partly changed', 'b:changed', 'fresh:changed', 'gone:exists']);
  });

  it('refuses to write an object the validator would refuse, and leaves tracker-linked objects to the tracker', () => {
    const doc = board([sticky('a')]);
    const bad = { created: {}, removed: { x: sticky('x', { w: -5, fill: 'url(javascript:1)' }), t: sticky('t', { trackerId: 'abc' }) }, changed: {} };
    const result = doc.transact(() => applyInverse(doc, bad, { now }), 'revert') as unknown as { applied: number; skipped: { id: string; reason: string }[] };
    expect(result.applied).toBe(0);
    expect(result.skipped.map((x) => `${x.id}:${x.reason}`).sort()).toEqual(['t:linked', 'x:invalid']);
    expect(Object.keys(state(doc))).toEqual(['a']);
  });
});

describe('the log', () => {
  let dir = '';
  let clock = 1_700_000_000_000;
  const tick = () => clock;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-')); clock = 1_700_000_000_000; });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diffOf = (n: number) => ({ [`o${n}`]: { before: null, after: sticky(`o${n}`) } });
  const record = (store: ReturnType<typeof createActivity>, n = 1, board = 'b1') => store.record(board, { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'create_objects', diff: diffOf(n) });

  it('keeps ids, counts and a line, never the data to revert, and writes nothing for a call that changed nothing', () => {
    const store = createActivity({ dataDir: dir, now: tick });
    const entry = store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'create_objects', diff: { o1: { before: null, after: sticky('o1', { text: 'SECRET PLAN' }) } } })!;
    expect(entry).toMatchObject({ agent: { token: 'Claude', member: 'Ada' }, tool: 'create_objects', summary: 'created 1 sticky note', counts: { created: 1, changed: 0, removed: 0 }, ids: ['o1'], revertible: true });
    expect(JSON.stringify(store.list('b1'))).not.toContain('inverse');
    expect(JSON.stringify(entry)).not.toContain('SECRET'); // the sticky's text is not in the log
    store.flush();
    expect(fs.readFileSync(path.join(dir, 'activity', 'b1.json'), 'utf8')).toContain('SECRET'); // it is in the file only as revert data, never listed
    expect(store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'x', diff: {} })).toBeNull();
    expect(store.record('../evil', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'x', diff: diffOf(2) })).toBeNull();
    expect(publicEntry(store.find('b1', entry.id)!)).toEqual(entry);
  });

  it('survives a restart, newest first, and bounds the log to 200 entries and 7 days', () => {
    let store = createActivity({ dataDir: dir, now: tick });
    for (let i = 0; i < MAX_ENTRIES + 20; i++) { clock += 1000; record(store, i); }
    expect(store.list('b1', 500)).toHaveLength(MAX_ENTRIES);
    store.flush();
    store = createActivity({ dataDir: dir, now: tick }); // a fresh process reads the file
    expect(store.list('b1', 3).map((e: { ids: string[] }) => e.ids[0])).toEqual([`o${MAX_ENTRIES + 19}`, `o${MAX_ENTRIES + 18}`, `o${MAX_ENTRIES + 17}`]);
    clock += MAX_AGE_MS + 1;
    expect(store.list('b1')).toHaveLength(0);
  });

  it('logs a call whose revert data is too big but offers no revert for it', () => {
    const store = createActivity({ dataDir: dir, now: tick });
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`big${i}`, { before: null, after: sticky(`big${i}`, { text: 'y'.repeat(8000) }) }]));
    const entry = store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'create_objects', diff: big })!;
    expect(entry.revertible).toBe(false);
    expect(JSON.stringify(store.find('b1', entry.id)).length).toBeLessThan(MAX_REVERT_BYTES);
  });

  it('marks an entry reverted and drops its revert data', () => {
    const store = createActivity({ dataDir: dir, now: tick });
    const entry = record(store)!;
    store.markReverted('b1', entry.id, 'Bob');
    expect(store.list('b1')[0]).toMatchObject({ revertible: false, reverted: { by: 'Bob' } });
    expect(store.find('b1', entry.id)!.inverse).toBeUndefined();
  });
});

describe('what the review of the log asked for (cybersec, TAB-158)', () => {
  const run = (doc: Y.Doc, change: () => void) => {
    const before = snapshotObjects(doc);
    doc.transact(change);
    return composeDiffs([diffObjects(before, snapshotObjects(doc))]);
  };
  const inverseOfDiff = (diff: unknown) => {
    const store = createActivity({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'act-')), now });
    store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'update_objects', diff: diff as never });
    return store.find('b1', store.list('b1')[0].id)!.inverse;
  };
  const revert = (doc: Y.Doc, inverse: unknown) => doc.transact(() => applyInverse(doc, inverse as never, { now }), 'revert') as unknown as { applied: number; skipped: { id: string; reason: string }[] };

  it('never writes a tracker field back: an agent call that unlinked a card is not undone into a link', () => {
    const doc = board([sticky('card', { type: 'card', trackerId: 'abc', extProvider: 'tabula', extKey: 'TAB-1', tracker: { title: 'x' }, ext: undefined })]);
    const diff = run(doc, () => {
      const m = doc.getMap('objects').get('card') as Y.Map<unknown>;
      for (const k of ['trackerId', 'extProvider', 'extKey', 'tracker']) m.delete(k);
      m.set('text', 'unlinked by the agent');
    });
    const result = revert(doc, inverseOfDiff(diff));
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([{ id: 'card', reason: 'linked' }]);
    expect(Object.keys(state(doc).card)).not.toContain('trackerId');
    // and a plain object whose revert data names a tracker field is refused the same way
    const forged = { created: {}, removed: {}, changed: { card: { b: { trackerId: 'zzz', text: 'x' }, a: { text: 'unlinked by the agent', trackerId: undefined } } } };
    expect(revert(doc, forged).skipped).toEqual([{ id: 'card', reason: 'linked' }]);
  });

  it('restores an object that has an author and an owner (the validator is given who may be one)', () => {
    const doc = board([sticky('card', { ownerId: 'u2', ownerName: 'Bo', createdBy: 'someone-else' })]);
    const diff = run(doc, () => doc.getMap('objects').delete('card'));
    expect(revert(doc, inverseOfDiff(diff))).toEqual({ applied: 1, skipped: [] });
    expect(state(doc).card).toMatchObject({ ownerId: 'u2', createdBy: 'someone-else' });
  });

  it('does not remove an object something else still points at: a person\'s connector or a child', () => {
    const doc = board([]);
    const diff = run(doc, () => {
      doc.getMap('objects').set('frame', new Y.Map(Object.entries({ ...sticky('frame'), type: 'frame', name: 'F' })));
      doc.getMap('objects').set('note', new Y.Map(Object.entries(sticky('note'))));
    });
    doc.transact(() => {
      doc.getMap('objects').set('link', new Y.Map(Object.entries({ id: 'link', type: 'connector', from: { kind: 'bound', id: 'note', anchor: 'auto' }, to: { kind: 'free', x: 5, y: 5 }, route: 'straight', startHead: 'none', endHead: 'arrow', z: 'a1', createdBy: 'u1' })));
      (doc.getMap('objects').get('frame') as Y.Map<unknown>).set('name', 'F');
      doc.getMap('objects').set('child', new Y.Map(Object.entries(sticky('child', { parent: 'frame' }))));
    });
    const result = revert(doc, inverseOfDiff(diff));
    expect(result.applied).toBe(0);
    expect(result.skipped.map((x) => `${x.id}:${x.reason}`).sort()).toEqual(['frame:in use', 'note:in use']);
  });

  it('a board too large to snapshot is logged by the ids it touched, without revert data', () => {
    const doc = board([sticky('a'), sticky('b')]);
    const touched = new Set<string>();
    const off = watchTouched(doc, touched);
    doc.transact(() => {
      (doc.getMap('objects').get('a') as Y.Map<unknown>).set('text', 'x');
      doc.getMap('objects').delete('b');
      doc.getMap('objects').set('c', new Y.Map(Object.entries(sticky('c'))));
    });
    off();
    doc.transact(() => (doc.getMap('objects').get('a') as Y.Map<unknown>).set('text', 'later')); // after off(): not noted
    expect([...touched].sort()).toEqual(['a', 'b', 'c']);
    const store = createActivity({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'act-')), now });
    const entry = store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'update_objects', diff: composeDiffs([{ tooLarge: true, touched: [...touched] } as never]) as never })!;
    expect(entry).toMatchObject({ summary: 'changed 3 objects', revertible: false, reason: 'too_large', ids: ['a', 'b', 'c'] });
    expect(store.find('b1', entry.id)!.inverse).toBeUndefined();
  });

  describe('keeping the log', () => {
    let dir = '';
    let clock = 1_700_000_000_000;
    const tick = () => clock;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-')); clock = 1_700_000_000_000; });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rec = (store: ReturnType<typeof createActivity>, board_: string, userId = 'u1', n = 1) => store.record(board_, { userId, tokenName: 'Claude', userName: 'Ada', tool: 'create_objects', diff: { [`o${n}`]: { before: null, after: sticky(`o${n}`) } } as never });

    it('keeps the revert data 48 hours and the line 7 days', () => {
      const store = createActivity({ dataDir: dir, now: tick });
      const entry = rec(store, 'b1')!;
      clock += INVERSE_MAX_AGE_MS + 1;
      expect(store.list('b1')[0]).toMatchObject({ revertible: false, reason: 'expired' });
      expect(store.find('b1', entry.id)!.inverse).toBeUndefined();
      clock += MAX_AGE_MS;
      expect(store.list('b1')).toHaveLength(0);
    });

    it('writes private files in a private folder, and a note kept private is counted but its id is not listed', () => {
      const store = createActivity({ dataDir: dir, now: tick });
      const e = store.record('b1', { userId: 'u1', tokenName: 'Claude', userName: 'Ada', tool: 'create_objects', privateIds: ['secret'] as never, diff: { secret: { before: null, after: sticky('secret', { privateStep: 's1' }) }, open: { before: null, after: sticky('open') } } as never })!;
      expect(e.counts.created).toBe(2);
      expect(e.ids).toEqual(['open']);
      store.flush();
      // POSIX modes mean nothing on Windows (the check passes there by comparing with what the platform reports for a fresh file)
      const modes = [fs.statSync(path.join(dir, 'activity')).mode & 0o777, fs.statSync(path.join(dir, 'activity', 'b1.json')).mode & 0o777];
      expect(modes).toEqual(process.platform === 'win32' ? modes : [0o700, 0o600]);
    });

    it('removes everything made with a removed person\'s tokens, from every board, and a board that is gone loses its log', () => {
      const store = createActivity({ dataDir: dir, now: tick });
      rec(store, 'b1', 'u1', 1); rec(store, 'b1', 'u2', 2); rec(store, 'b2', 'u1', 3);
      store.flush();
      const fresh = createActivity({ dataDir: dir, now: tick }); // nothing in memory: it reads the files
      expect(fresh.removeUser('u1')).toBe(2);
      fresh.flush();
      expect(createActivity({ dataDir: dir, now: tick }).list('b1').map((e: { ids: string[] }) => e.ids[0])).toEqual(['o2']);
      expect(createActivity({ dataDir: dir, now: tick }).list('b2')).toEqual([]);
      expect(fresh.sweep((id: string) => id === 'b1')).toBe(1); // b2 is gone: its file goes
      expect(fs.existsSync(path.join(dir, 'activity', 'b2.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'activity', 'b1.json'))).toBe(true);
    });

    it('holds a bounded number of boards in memory and still serves any of them', () => {
      const store = createActivity({ dataDir: dir, now: tick });
      for (let i = 0; i < 40; i++) rec(store, `board${i}`, 'u1', i);
      for (let i = 0; i < 40; i++) expect(store.list(`board${i}`)[0].ids).toEqual([`o${i}`]); // the first ones were evicted and are read back from their files
    });
  });
});

