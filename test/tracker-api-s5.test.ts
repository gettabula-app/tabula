import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { createHarness, until, type Account } from './mcp-harness';

const objs = (doc: { getMap(name: string): unknown }): any => doc.getMap('objects');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_TOKEN = 's'.repeat(48);
const h = createHarness({
  accounts: true,
  settings: { TRACKER: 'on' },
  dir: path.join(ROOT, `.tracker-api-s5-${process.pid}-${Date.now()}`),
});
let owner: Account;
let editor: Account;
let viewer: Account;
let boardId: string;
let linkId: string;
let live: ReturnType<typeof h.connect>;

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  objs(doc).set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}

const api = (who: Account, method: string, route: string, body?: unknown) => h.api(who.cookie, method, route, body);

function eventCount(ticketId: string) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?').get(ticketId)!.n); }
  finally { db.close(); }
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  editor = await h.joinTeam(owner.cookie, teamId);
  viewer = await h.joinTeam(owner.cookie, teamId);
  boardId = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, boardId, editor.user.id, 'editor');
  await h.share(owner.cookie, boardId, viewer.user.id, 'viewer');
  const doc = new Y.Doc();
  put(doc, 'kanban-1', 'container', { layout: 'kanban' });
  put(doc, 'lane-todo', 'lane', { parent: 'kanban-1', name: 'To do', stage: 'todo', rank: 'a0@kanban-1' });
  put(doc, 'lane-doing', 'lane', { parent: 'kanban-1', name: 'Doing', stage: 'doing', rank: 'a1@kanban-1' });
  put(doc, 'lane-free', 'lane', { parent: 'kanban-1', name: 'Free', rank: 'a2@kanban-1' });
  put(doc, 'card-1', 'card', { parent: 'lane-todo', rank: 'a0@lane-todo', text: 'Initial title' });
  put(doc, 'card-2', 'card', { parent: 'lane-todo', rank: 'a1@lane-todo', text: 'Second ticket' });
  put(doc, 'card-free', 'card', { parent: 'lane-free', rank: 'a0@lane-free', text: 'Plain card' });
  fs.writeFileSync(h.roomFile(boardId), Y.encodeStateAsUpdate(doc));
  doc.destroy();
  live = h.connect(boardId, owner.cookie);
  await live.synced();
  const linked = await api(owner, 'POST', '/api/tracker/links', {
    boardId, kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' },
    createTickets: true, idempotencyKey: 'tracker-s5-link-key-123',
  });
  if (linked.status !== 201) throw new Error(`could not create slice 5 test link (${linked.status})`);
  linkId = linked.body.link.id;
  await until(() => objs(live.doc).get('card-1')?.get('trackerId') === 'trk_default');
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('tracker slice 5 HTTP routes', () => {
  it('detaches one card, projects the latest title, and leaves its ticket unchanged', async () => {
    live.doc.transact(() => {
      const card = objs(live.doc).get('card-1');
      card?.set('text', 'Initial title\nBody line');
    }, 'test');
    await until(() => objs(live.doc).get('card-1')?.get('text') === 'Initial title\nBody line');
    const updated = await api(owner, 'PATCH', '/api/tracker/tickets/TAB-1', { title: 'Latest SQL title' });
    expect(updated.status).toBe(200);
    await until(() => objs(live.doc).get('card-1')?.get('text') === 'Latest SQL title\nBody line');
    const beforeEvents = eventCount(updated.body.ticket.id);

    const detached = await api(owner, 'DELETE', `/api/tracker/links/${linkId}/cards/card-1`);
    expect(detached).toMatchObject({
      status: 200,
      body: { cardId: 'card-1', projectionPending: false, ticket: { id: updated.body.ticket.id, title: 'Latest SQL title' } },
    });
    await until(() => !objs(live.doc).get('card-1')?.has('trackerId'));
    const card = objs(live.doc).get('card-1');
    expect(card?.toJSON()).toMatchObject({ text: 'Latest SQL title\nBody line', parent: 'lane-todo' });
    for (const field of ['extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'trackerUnmappedState']) {
      expect(card?.toJSON()).not.toHaveProperty(field);
    }
    expect(eventCount(updated.body.ticket.id)).toBe(beforeEvents);
    expect(await api(owner, 'DELETE', `/api/tracker/links/${linkId}/cards/card-1`))
      .toMatchObject({ status: 404, body: { error: 'not_found', message: expect.any(String) } });
    expect(await api(owner, 'DELETE', `/api/tracker/links/${linkId}/cards/card-free`))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await api(owner, 'DELETE', '/api/tracker/links/unknown-link/cards/card-1'))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await api(viewer, 'DELETE', `/api/tracker/links/${linkId}/cards/card-2`))
      .toMatchObject({ status: 403, body: { error: 'forbidden', message: expect.any(String) } });
  });

  it('opens, extends, conflicts, and closes a per-user restore window with board access checks', async () => {
    expect(await api(owner, 'POST', '/api/tracker/boards/missing-board/restore-window'))
      .toMatchObject({ status: 404, body: { error: 'not_found', message: expect.any(String) } });
    expect(await api(viewer, 'POST', `/api/tracker/boards/${boardId}/restore-window`))
      .toMatchObject({ status: 403, body: { error: 'forbidden', message: expect.any(String) } });
    const before = Date.now();
    const first = await api(owner, 'POST', `/api/tracker/boards/${boardId}/restore-window`);
    expect(first).toMatchObject({ status: 200, body: { expiresAt: expect.any(Number) } });
    await until(() => Date.now() > before);
    const extended = await api(owner, 'POST', `/api/tracker/boards/${boardId}/restore-window`);
    expect(extended.body.expiresAt).toBeGreaterThan(first.body.expiresAt);
    expect(await api(editor, 'POST', `/api/tracker/boards/${boardId}/restore-window`))
      .toMatchObject({ status: 409, body: { error: 'conflict', message: expect.any(String) } });
    expect(await api(owner, 'DELETE', `/api/tracker/boards/${boardId}/restore-window`))
      .toMatchObject({ status: 200, body: { closed: true, projectionPending: false } });
  });
});

describe('tracker slice 5 hosted read-only', () => {
  const cloud = createHarness({
    accounts: true,
    settings: { TRACKER: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-s5-readonly' },
    dir: path.join(ROOT, `.tracker-api-s5-readonly-${process.pid}-${Date.now()}`),
  });

  it('returns read_only for card detach and restore-window mutations', async () => {
    try {
      await cloud.start();
      const account = await cloud.signInOwner();
      const board = await cloud.newBoard(account.cookie);
      const limits = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(limits.status).toBe(200);
      expect(await cloud.api(account.cookie, 'DELETE', '/api/tracker/links/unknown/cards/card-1'))
        .toMatchObject({ status: 403, body: { error: 'read_only', message: expect.any(String) } });
      expect(await cloud.api(account.cookie, 'POST', `/api/tracker/boards/${board}/restore-window`))
        .toMatchObject({ status: 403, body: { error: 'read_only', message: expect.any(String) } });
    } finally {
      await cloud.cleanup();
    }
  });
});
