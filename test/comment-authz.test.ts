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
  if (seed) server.transact(() => seed(server.getMap('threads')));
  const guard = createCommentGuard(server, { isAccount: (id: string) => accounts.includes(id) });
  const client = () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    return doc;
  };
  /** `doc` makes a change as `actor`; the relay applies and corrects it; `doc` then catches up. */
  const send = (doc: Y.Doc, actor: Actor, change: (threads: Y.Map<Y.Map<unknown>>) => void) => {
    const before = Y.encodeStateVector(doc);
    doc.transact(() => change(doc.getMap('threads')));
    const update = Y.encodeStateAsUpdate(doc, before);
    const undone = guard.run(actor, () => Y.applyUpdate(server, update, 'socket'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)));
    return undone;
  };
  const thread = (id: string) => server.getMap('threads').get(id)?.toJSON();
  return { server, guard, client, send, thread };
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
  it('lets people write, edit and delete their own comments, and stamps their account name', () => {
    const { client, send, thread } = setup();
    const doc = client();
    expect(send(doc, ANA, (t) => newThread(t, 't1', { id: ANA.id, name: 'Not Ana' }))).toEqual([]);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, authorName: 'Ana', text: 'Hello' });
    expect(send(doc, ANA, (t) => t.get('t1')!.set('text', 'Edited'))).toEqual([]);
    expect(thread('t1')!.text).toBe('Edited');
    expect(send(doc, ANA, (t) => t.delete('t1'))).toEqual([]);
    expect(thread('t1')).toBeUndefined();
  });

  it('rewrites a forged author to the sender', () => {
    const { client, send, thread } = setup();
    send(client(), ANA, (t) => newThread(t, 't1', BEN));
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, authorName: 'Ana' });
  });

  it("undoes edits and deletes of someone else's thread, and every client converges on that", () => {
    const { server, client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const bens = client();
    expect(send(bens, BEN, (t) => t.get('t1')!.set('text', 'Ben was here'))).toEqual(['edit']);
    expect(thread('t1')!.text).toBe('Hello');
    expect(bens.getMap('threads').get('t1')!.get('text')).toBe('Hello');
    expect(send(bens, BEN, (t) => t.delete('t1'))).toEqual(['delete']);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, text: 'Hello' });
    // a third client that joins later sees the original
    const later = new Y.Doc();
    Y.applyUpdate(later, Y.encodeStateAsUpdate(server));
    expect(later.getMap('threads').get('t1')!.get('text')).toBe('Hello');
  });

  it('protects the fields set once: author, creation time and anchor', () => {
    const { client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    send(client(), ANA, (t) => {
      t.get('t1')!.set('authorName', 'Someone else');
      t.get('t1')!.set('anchor', { x: 999, y: 999 });
    });
    expect(thread('t1')).toMatchObject({ authorName: 'Ana', anchor: { x: 0, y: 0 } });
  });

  it('lets moderators delete anything but edit only their own words', () => {
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
    send(bens, BEN, (t) => replies(t).set('r2', reply('r2', ANA))); // forged
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
    })).toEqual([]);
    expect(thread('t1')).toMatchObject({ resolved: true, resolvedBy: EDITOR.id });
    expect(send(client(), ANA, (t) => t.get('t1')!.set('resolved', false))).toEqual([]);
    expect(thread('t1')!.resolved).toBe(false);
  });

  it('keeps the authors of imported comments, records the importer, and lets only them or a moderator delete', () => {
    const { client, send, thread } = setup();
    const anas = client();
    send(anas, ANA, (t) => newThread(t, 'imp', { id: 'someone-from-another-board', name: 'Zed' }, { imported: true }));
    expect(thread('imp')).toMatchObject({ authorId: 'someone-from-another-board', authorName: 'Zed', imported: true, importedBy: ANA.id });
    expect(send(anas, ANA, (t) => t.get('imp')!.set('text', 'rewritten'))).toEqual(['edit']); // nobody edits words they did not write
    expect(send(client(), BEN, (t) => t.delete('imp'))).toEqual(['delete']);
    expect(send(client(), ANA, (t) => t.delete('imp'))).toEqual([]); // a client that has seen the thread put back
    expect(thread('imp')).toBeUndefined();
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

  it('refuses a forged legacy or import mark on a new comment', () => {
    const { client, send, thread } = setup();
    send(client(), ANA, (t) => newThread(t, 't1', ANA, { legacy: true, importedBy: BEN.id }));
    expect(thread('t1')!.legacy).toBeUndefined();
    expect(thread('t1')!.importedBy).toBeUndefined();
  });

  it('clears anything written outside the threads map, and replaces a thread that is not a map', () => {
    const { server, client, send, thread } = setup((t) => newThread(t, 't1', ANA));
    const doc = client();
    send(doc, BEN, () => {
      doc.getMap('other').set('x', 1);
      (doc.getMap('threads') as Y.Map<unknown>).set('t1', 'not a thread');
      (doc.getMap('threads') as Y.Map<unknown>).set('t2', 42);
    });
    expect(server.getMap('other').size).toBe(0);
    expect(thread('t1')).toMatchObject({ authorId: ANA.id, text: 'Hello' });
    expect(server.getMap('threads').has('t2')).toBe(false);
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
