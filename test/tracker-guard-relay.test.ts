import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
let owner: Account;
let guest: Account;
let boardId: string;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie);
  guest = await h.joinTeam(owner.cookie, team.id);
  const changed = await h.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (changed.status !== 200) throw new Error(`could not make relay test user a guest (${changed.status})`);
  boardId = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, boardId, guest.user.id, 'editor');

  const doc = new Y.Doc();
  const objects = doc.getMap('objects');
  const put = (id: string, type: string, fields: Record<string, unknown> = {}) => {
    objects.set(id, new Y.Map(Object.entries({ id, type, ...fields })));
  };
  put('relay-kanban', 'container', { layout: 'kanban' });
  put('relay-todo', 'lane', { parent: 'relay-kanban', rank: 'a0@relay', stage: 'todo' });
  put('relay-doing', 'lane', { parent: 'relay-kanban', rank: 'a1@relay', stage: 'doing' });
  put('relay-card', 'card', { parent: 'relay-todo', rank: 'a0@todo', text: 'Relay ticket' });
  fs.writeFileSync(h.roomFile(boardId), Y.encodeStateAsUpdate(doc));
  doc.destroy();

  const linked = await h.api(owner.cookie, 'POST', '/api/tracker/links', {
    boardId,
    kanbanId: 'relay-kanban',
    mapping: { 'relay-todo': 'todo', 'relay-doing': 'in_progress' },
    createTickets: true,
    idempotencyKey: 'tracker-relay-guard-123',
  });
  if (linked.status !== 201) throw new Error(`could not link relay test kanban (${linked.status})`);
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('tracker linked-card relay guard', () => {
  it('corrects a guest editor drag before broadcast and sends the sender a tracker notice', async () => {
    const observer = h.connect(boardId, owner.cookie);
    const client = h.connect(boardId, guest.cookie);
    await Promise.all([observer.synced(), client.synced()]);
    const notices: { undone: { cardId: string; reason: string }[] }[] = [];
    (client.provider as any).messageHandlers[7] = (_encoder: unknown, decoder: ReturnType<typeof decoding.createDecoder>) => {
      notices.push(JSON.parse(decoding.readVarString(decoder)));
    };
    const observerParents: unknown[] = [];
    let observerUpdates = 0;
    observer.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== observer.provider) return;
      observerUpdates++;
      observerParents.push(((observer.doc.getMap('objects').get('relay-card')) as Y.Map<unknown> | undefined)?.get('parent'));
    });

    const card = client.doc.getMap('objects').get('relay-card') as Y.Map<unknown>;
    client.doc.transact(() => card.set('parent', 'relay-doing'), 'guest-drag');
    expect(card.get('parent')).toBe('relay-doing');
    await until(() => observerUpdates > 0 && card.get('parent') === 'relay-todo' && notices.some((notice) =>
      notice.undone.some((entry) => entry.cardId === 'relay-card' && entry.reason === 'forbidden')));
    expect(card.get('parent')).toBe('relay-todo');
    expect(notices).toContainEqual({ undone: [{ cardId: 'relay-card', reason: 'forbidden' }] });
    expect(observerParents).not.toContain('relay-doing');

    const fresh = h.connect(boardId, owner.cookie);
    await fresh.synced();
    expect(((fresh.doc.getMap('objects').get('relay-card')) as Y.Map<unknown>).get('parent')).toBe('relay-todo');
    await until(() => {
      try {
        const saved = new Y.Doc();
        Y.applyUpdate(saved, fs.readFileSync(h.roomFile(boardId)));
        const savedCard = saved.getMap('objects').get('relay-card') as Y.Map<unknown> | undefined;
        const ready = savedCard?.get('trackerId') === 'trk_default' && savedCard.get('parent') === 'relay-todo';
        saved.destroy();
        return ready;
      } catch { return false; }
    });
    expect(((fresh.doc.getMap('objects').get('relay-card')) as Y.Map<unknown>).get('parent')).toBe('relay-todo');
    fresh.provider.destroy();
    client.provider.destroy();
    observer.provider.destroy();
  });
});
