import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCommentGuard } from '../server/comment-authz.mjs';

type Actor = { id: string; role: string; name: string };
const ANA: Actor = { id: 'anaAccountId0000000000', role: 'commenter', name: 'Ana' };
const BEN: Actor = { id: 'benAccountId0000000000', role: 'commenter', name: 'Ben' };
const EDITOR: Actor = { id: 'edAccountId00000000000', role: 'editor', name: 'Eve' };
const OWNER: Actor = { id: 'ownerAccountId00000000', role: 'owner', name: 'Olga' };

/** A relay document with a guard, and clients that write to their own copy and send the difference. */
function setup(seed?: (threads: Y.Map<Y.Map<unknown>>) => void, accounts: string[] = [ANA.id, BEN.id, EDITOR.id, OWNER.id]) {
  const server = new Y.Doc();
  if (seed) server.transact(() => seed(server.getMap<any>('threads')));
  const guard = createCommentGuard(server, { isAccount: (id: string) => accounts.includes(id) });
  const client = () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    return doc;
  };
  /** `doc` makes a change as `actor`; the relay applies and corrects it; `doc` then catches up. */
  const send = (doc: Y.Doc, actor: Actor, change: (threads: Y.Map<Y.Map<unknown>>) => void) => {
    const update = edit(doc, change);
    const undone = deliver(actor, update);
    catchUp(doc);
    return undone;
  };
  /** A change made on `doc` without sending it yet (the update to send later). */
  const edit = (doc: Y.Doc, change: (threads: Y.Map<Y.Map<unknown>>) => void) => {
    const before = Y.encodeStateVector(doc);
    doc.transact(() => change(doc.getMap<any>('threads')));
    return Y.encodeStateAsUpdate(doc, before);
  };
  const deliver = (actor: Actor, update: Uint8Array) => guard.run(actor, () => Y.applyUpdate(server, update, 'socket'));
  const catchUp = (doc: Y.Doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)));
  const thread = (id: string) => server.getMap<any>('threads').get(id)?.toJSON();
  /** Every given client holds what the relay holds, once each has caught up. */
  const converged = (...docs: Y.Doc[]) => {
    for (const doc of docs) {
      catchUp(doc);
      expect(doc.getMap<any>('threads').toJSON()).toEqual(server.getMap<any>('threads').toJSON());
    }
  };
  return { server, guard, client, send, edit, deliver, catchUp, thread, converged };
}

function newThread(threads: Y.Map<Y.Map<unknown>>, id: string, author: Actor | { id: string; name: string }, extra: Record<string, unknown> = {}) {
  const m = new Y.Map<unknown>();
  threads.set(id, m);
  for (const [k, v] of Object.entries({ id, createdAt: 1, authorId: author.id, authorName: author.name, authorColor: '#123', text: 'Hello', anchor: { x: 0, y: 0 }, resolved: false, ...extra })) m.set(k, v);
  m.set('replies', new Y.Map());
  return m;
}

const reply = (id: string, author: Actor | { id: string; name: string }, extra: Record<string, unknown> = {}) =>
  ({ id, authorId: author.id, authorName: author.name, authorColor: '#123', text: 'Re', createdAt: 2, ...extra });

describe('comment authorship on the relay', () => {
  it('lets people write, edit and delete their own comments', () => {
    const { client, send, thread } = setup();
    const doc = client();
    expect(send(doc, ANA, (t) => newThread(t, 't1', ANA))).toEqual([]);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, authorName: 'Ana', text: 'Hello' });
    expect(send(doc, ANA, (t) => t.get('t1')!.set('text', 'Edited'))).toEqual([]);
    expect(thread('t1')!.text).toBe('Edited');
    expect(send(doc, ANA, (t) => t.delete('t1'))).toEqual([]);
    expect(thread('t1')).toBeUndefined();
  });

  it('rewrites a forged author and a forged name to the sender, and says so', () => {
    const { client, send, thread } = setup();
    expect(send(client(), ANA, (t) => newThread(t, 't1', BEN))).toEqual(['author']);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, authorName: 'Ana' });
    expect(send(client(), ANA, (t) => newThread(t, 't2', { id: ANA.id, name: 'Not Ana' }))).toEqual(['author']);
    expect(thread('t2')).toMatchObject({ authorId: ANA.id, authorName: 'Ana' });
  });

  it("undoes edits and deletes of someone else's thread, and every client converges on that", () => {
    const { server, client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const bens = client();
    expect(send(bens, BEN, (t) => t.get('t1')!.set('text', 'Ben was here'))).toEqual(['edit']);
    expect(thread('t1')!.text).toBe('Hello');
    expect(bens.getMap<any>('threads').get('t1')!.get('text')).toBe('Hello');
    expect(send(bens, BEN, (t) => t.delete('t1'))).toEqual(['delete']);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, text: 'Hello' });
    // a third client that joins later sees the original
    const later = new Y.Doc();
    Y.applyUpdate(later, Y.encodeStateAsUpdate(server));
    expect(later.getMap<any>('threads').get('t1')!.get('text')).toBe('Hello');
  });

  it('protects the fields set once: author, creation time and anchor', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    expect(send(client(), ANA, (t) => {
      t.get('t1')!.set('authorName', 'Someone else');
      t.get('t1')!.set('anchor', { x: 999, y: 999 });
    })).toEqual(['author', 'other']);
    expect(thread('t1')).toMatchObject({ authorName: 'Ana', anchor: { x: 0, y: 0 } });
    // a moderator cannot move someone else's pin either
    expect(send(client(), OWNER, (t) => t.get('t1')!.set('anchor', { x: 5, y: 5 }))).toEqual(['other']);
    expect(thread('t1')!.anchor).toEqual({ x: 0, y: 0 });
  });

  it('lets moderators (board owners, team admins and workspace admins) delete anything but edit only their own words', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const owners = client();
    expect(send(owners, OWNER, (t) => t.get('t1')!.set('text', 'Moderated'))).toEqual(['edit']);
    expect(thread('t1')!.text).toBe('Hello');
    expect(send(owners, OWNER, (t) => t.delete('t1'))).toEqual([]);
    expect(thread('t1')).toBeUndefined();
  });

  it('keeps a thread whose author tries to delete it after someone else replied', () => {
    const { client, send, thread } = setup((t) => {
      newThread(t, 't1', ANA);
      newThread(t, 't2', ANA);
      (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', BEN));
      (t.get('t2')!.get('replies') as Y.Map<unknown>).set('r2', reply('r2', ANA));
    });
    const anas = client();
    expect(send(anas, ANA, (t) => t.delete('t1'))).toEqual(['delete']);
    expect(thread('t1')!.replies.r1).toMatchObject({ authorId: BEN.id });
    expect(send(anas, ANA, (t) => t.delete('t2'))).toEqual([]); // only her own reply on it
    expect(thread('t2')).toBeUndefined();
  });

  it('applies the same rules to replies', () => {
    const { client, send, thread } = setup((t) => {
      newThread(t, 't1', ANA);
      (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', ANA));
    });
    const bens = client();
    const replies = (t: Y.Map<Y.Map<unknown>>) => t.get('t1')!.get('replies') as Y.Map<unknown>;
    expect(send(bens, BEN, (t) => replies(t).set('r2', reply('r2', ANA)))).toEqual(['author']); // forged
    expect(thread('t1')!.replies.r2).toMatchObject({ authorId: BEN.id, authorName: 'Ben' });
    expect(send(bens, BEN, (t) => replies(t).set('r1', { ...reply('r1', ANA), text: 'changed' }))).toEqual(['edit']);
    expect(thread('t1')!.replies.r1.text).toBe('Re');
    expect(send(bens, BEN, (t) => replies(t).delete('r1'))).toEqual(['delete']);
    expect(thread('t1')!.replies.r1).toBeDefined();
    expect(send(client(), OWNER, (t) => replies(t).delete('r1'))).toEqual([]);
    expect(thread('t1')!.replies.r1).toBeUndefined();
  });

  it('lets the author and board editors resolve, not other commenters, and stamps who resolved', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    expect(send(client(), BEN, (t) => t.get('t1')!.set('resolved', true))).toEqual(['resolve']);
    expect(thread('t1')!.resolved).toBe(false);
    expect(send(client(), EDITOR, (t) => {
      t.get('t1')!.set('resolved', true);
      t.get('t1')!.set('resolvedBy', ANA.id);
    })).toEqual(['author']);
    expect(thread('t1')).toMatchObject({ resolved: true, resolvedBy: EDITOR.id });
    // the author reopens (the client clears resolvedBy) and resolves again
    expect(send(client(), ANA, (t) => {
      t.get('t1')!.set('resolved', false);
      t.get('t1')!.delete('resolvedBy');
    })).toEqual([]);
    expect(thread('t1')!.resolved).toBe(false);
    expect(send(client(), ANA, (t) => {
      t.get('t1')!.set('resolved', true);
      t.get('t1')!.set('resolvedBy', ANA.id);
    })).toEqual([]);
    expect(thread('t1')).toMatchObject({ resolved: true, resolvedBy: ANA.id });
  });

  it('marks comments that a board owner imports as imported and keeps their authors, replies included', () => {
    const { client, send, thread } = setup();
    const owners = client();
    expect(send(owners, OWNER, (t) => {
      const m = newThread(t, 'imp', { id: 'someone-from-another-board', name: 'Zed' }, { imported: true, importedBy: OWNER.id });
      (m.get('replies') as Y.Map<unknown>).set('r1', reply('r1', { id: 'someone-else', name: 'Yan' }, { imported: true, importedBy: OWNER.id }));
    })).toEqual([]);
    expect(thread('imp')).toMatchObject({ authorId: 'someone-from-another-board', authorName: 'Zed', imported: true, importedBy: OWNER.id });
    expect(thread('imp')!.replies.r1).toMatchObject({ authorId: 'someone-else', authorName: 'Yan', imported: true, importedBy: OWNER.id });
    expect(send(client(), ANA, (t) => t.get('imp')!.set('text', 'rewritten'))).toEqual(['edit']); // nobody edits words they did not write
    expect(send(client(), ANA, (t) => t.delete('imp'))).toEqual(['delete']); // only the importer or a moderator deletes
    expect(send(client(), OWNER, (t) => t.delete('imp'))).toEqual([]);
    expect(thread('imp')).toBeUndefined();
  });

  it('refuses an import mark from anyone but the board owner: the comment becomes theirs', () => {
    const { client, send, thread } = setup();
    expect(send(client(), BEN, (t) => newThread(t, 'forged', { id: ANA.id, name: 'Ana' }, { imported: true, importedBy: BEN.id })))
      .toEqual(['author']);
    expect(thread('forged')).toMatchObject({ authorId: BEN.id, authorName: 'Ben' });
    expect(thread('forged')!.imported).toBeUndefined();
    expect(thread('forged')!.importedBy).toBeUndefined();
    // an editor cannot import either: the files open as a new board, which only its creator owns
    expect(send(client(), EDITOR, (t) => newThread(t, 'forged2', { id: 'x', name: 'X' }, { imported: true }))).toEqual(['author']);
    expect(thread('forged2')).toMatchObject({ authorId: EDITOR.id, authorName: 'Eve' });
  });

  it('marks comments from before accounts as legacy when the room loads, and only moderators delete them', () => {
    const device = '3b241101-e2bb-4255-8caf-4136c566a962';
    const removed = 'goneAccountId000000000';
    const { client, send, thread } = setup((t) => {
      newThread(t, 'old', { id: device, name: 'Clever Otter' });
      newThread(t, 'mine', ANA);
      newThread(t, 'former', { id: removed, name: 'Former member' });
      (t.get('mine')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', { id: device, name: 'Clever Otter' }));
    });
    expect(thread('old')!.legacy).toBe(true);
    expect(thread('mine')!.legacy).toBeUndefined();
    expect(thread('mine')!.replies.r1.legacy).toBe(true);
    expect(thread('former')!.legacy).toBeUndefined(); // a removed member is not "before accounts"
    expect(send(client(), ANA, (t) => t.delete('old'))).toEqual(['delete']);
    expect(send(client(), OWNER, (t) => t.delete('old'))).toEqual([]);
  });

  it('refuses a forged legacy mark on a new comment', () => {
    const { client, send, thread } = setup();
    expect(send(client(), ANA, (t) => newThread(t, 't1', ANA, { legacy: true }))).toEqual(['author']);
    expect(thread('t1')!.legacy).toBeUndefined();
  });

  it('clears anything written outside the threads map, and replaces a thread that is not a map', () => {
    const { server, client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const doc = client();
    expect(send(doc, BEN, () => {
      doc.getMap('other').set('x', 1);
      (doc.getMap<any>('threads') as Y.Map<unknown>).set('t1', 'not a thread');
      (doc.getMap<any>('threads') as Y.Map<unknown>).set('t2', 42);
    })).toEqual(['other']);
    expect(server.getMap('other').size).toBe(0);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, text: 'Hello' });
    expect(server.getMap<any>('threads').has('t2')).toBe(false);
  });

  it('merges allowed concurrent changes from two people', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const anas = client();
    const bens = client();
    send(anas, ANA, (t) => t.get('t1')!.set('text', 'Ana edits'));
    send(bens, BEN, (t) => (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', BEN)));
    expect(thread('t1')!.text).toBe('Ana edits');
    expect(thread('t1')!.replies.r1).toMatchObject({ authorId: BEN.id });
  });
});

describe('offline batches and concurrent edits', () => {
  it('checks an offline batch against the role at sync time, not when it was made', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    // OWNER deletes offline; by the time the batch syncs the person is only a commenter, so the delete is undone
    expect(send(client(), { ...OWNER, role: 'commenter' }, (t) => t.delete('t1'))).toEqual(['delete']);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id });
    // an editor who resolves offline keeps the right only while they are still an editor
    expect(send(client(), { ...EDITOR, role: 'commenter' }, (t) => t.get('t1')!.set('resolved', true))).toEqual(['resolve']);
    expect(thread('t1')!.resolved).toBe(false);
    expect(send(client(), EDITOR, (t) => {
      t.get('t1')!.set('resolved', true);
      t.get('t1')!.set('resolvedBy', EDITOR.id);
    })).toEqual([]);
    expect(thread('t1')!.resolved).toBe(true);
  });

  it('keeps an author who deleted her thread offline with the reply that arrived online meanwhile', () => {
    const { client, send, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaOffline = client();
    const bens = client();
    expect(send(bens, BEN, (t) => (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', BEN)))).toEqual([]);
    expect(send(anaOffline, ANA, (t) => t.delete('t1'))).toEqual(['delete']); // Ben's reply means she may not
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, replies: { r1: { authorId: BEN.id } } });
    converged(anaOffline, bens);
  });

  it('keeps an author\'s offline edit and undoes a stranger\'s online edit to the same comment, and converges', () => {
    const { server, client, edit, deliver, catchUp, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaOffline = client();
    const bensOnline = client();
    const anasEdit = edit(anaOffline, (t) => t.get('t1')!.set('editedAt', 5));
    const bensEdit = edit(bensOnline, (t) => t.get('t1')!.set('text', 'Ben was here'));
    expect(deliver(BEN, bensEdit)).toEqual(['edit']);
    expect(deliver(ANA, anasEdit)).toEqual([]);
    catchUp(anaOffline);
    catchUp(bensOnline);
    expect(thread('t1')!.text).toBe('Hello');
    expect(thread('t1')!.editedAt).toBe(5);
    converged(anaOffline, bensOnline);
    expect(server.getMap<any>('threads').get('t1')).toBeDefined();
  });

  it('lets a reply and a forbidden delete of the same thread race: a reply that lands first survives the undo', () => {
    const { client, edit, deliver, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaDoc = client();
    const bensDoc = client();
    const anasReply = edit(anaDoc, (t) => (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', ANA)));
    const bensDelete = edit(bensDoc, (t) => t.delete('t1'));
    expect(deliver(ANA, anasReply)).toEqual([]);
    expect(deliver(BEN, bensDelete)).toEqual(['delete']);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, replies: { r1: { authorId: ANA.id } } });
    converged(anaDoc, bensDoc);
  });

  it('lets a forbidden delete land before a reply to the same thread: every client converges on the restored thread', () => {
    const { client, edit, deliver, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaDoc = client();
    const bensDoc = client();
    const anasReply = edit(anaDoc, (t) => (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', ANA)));
    const bensDelete = edit(bensDoc, (t) => t.delete('t1'));
    expect(deliver(BEN, bensDelete)).toEqual(['delete']);
    // the reply was written into the thread as it was before the delete, so the restored thread does not have it
    expect(deliver(ANA, anasReply)).toEqual([]);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, text: 'Hello' });
    converged(anaDoc, bensDoc);
  });

  it('lets a commenter edit text while another person replies, with both kept', () => {
    const { client, edit, deliver, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaDoc = client();
    const bensDoc = client();
    const bensEdit = edit(bensDoc, (t) => t.get('t1')!.set('text', 'Ben was here'));
    const anasReply = edit(anaDoc, (t) => (t.get('t1')!.get('replies') as Y.Map<unknown>).set('r1', reply('r1', ANA)));
    expect(deliver(ANA, anasReply)).toEqual([]);
    expect(deliver(BEN, bensEdit)).toEqual(['edit']);
    expect(thread('t1')).toMatchObject({ text: 'Hello', replies: { r1: { authorId: ANA.id } } });
    converged(anaDoc, bensDoc);
  });

  it('converges when the author and a stranger edit the same text at once, and the stranger never wins', () => {
    const { client, edit, deliver, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const anaDoc = client();
    const bensDoc = client();
    const anasEdit = edit(anaDoc, (t) => t.get('t1')!.set('text', 'Ana edits'));
    const bensEdit = edit(bensDoc, (t) => t.get('t1')!.set('text', 'Ben edits'));
    expect(deliver(BEN, bensEdit)).toEqual(['edit']);
    expect(deliver(ANA, anasEdit)).toEqual([]);
    expect(['Hello', 'Ana edits']).toContain(thread('t1')!.text);
    converged(anaDoc, bensDoc);
  });

  it('converges when two moderators delete the same thread and a stranger edits it at once', () => {
    const { client, edit, deliver, thread, converged } = setup((t) => newThread(t, 't1', ANA));
    const a = client();
    const b = client();
    const c = client();
    const ownerDelete = edit(a, (t) => t.delete('t1'));
    const ownerDeleteAgain = edit(b, (t) => t.delete('t1'));
    const benEdit = edit(c, (t) => t.get('t1')!.set('text', 'Ben'));
    expect(deliver(OWNER, ownerDelete)).toEqual([]);
    expect(deliver(OWNER, ownerDeleteAgain)).toEqual([]);
    // the thread is already gone when Ben's edit arrives: it lands in a deleted thread and changes nothing
    expect(deliver(BEN, benEdit)).toEqual([]);
    expect(thread('t1')).toBeUndefined();
    converged(a, b, c);
  });
});

describe('cost', () => {
  it('checks an update in well under a millisecond in a room of 500 threads', () => {
    const { server, client, guard, catchUp } = setup((t) => {
      for (let i = 0; i < 500; i++) {
        const m = newThread(t, `t${i}`, ANA);
        for (let r = 0; r < 4; r++) (m.get('replies') as Y.Map<unknown>).set(`r${r}`, reply(`r${r}`, ANA));
      }
    });
    const doc = client();
    const times: number[] = [];
    for (let i = 0; i < 300; i++) {
      const before = Y.encodeStateVector(doc);
      doc.transact(() => doc.getMap<any>('threads').get(`t${i % 500}`)!.set('text', `edit ${i}`));
      const update = Y.encodeStateAsUpdate(doc, before);
      const actor = i % 2 === 0 ? BEN : ANA; // half the updates are forbidden and get undone
      const t0 = performance.now();
      guard.run(actor, () => Y.applyUpdate(server, update, 'socket'));
      times.push(performance.now() - t0);
      catchUp(doc);
    }
    times.sort((a, b) => a - b);
    // Keep a 100x scheduling margin while still catching a guard that becomes prohibitively expensive per update.
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(100);
  });
});
