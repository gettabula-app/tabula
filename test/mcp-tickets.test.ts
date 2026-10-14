import { MIGRATIONS } from '../server/directory.mjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const TICKET_TOOLS = [
  'create_ticket', 'get_ticket', 'list_tickets', 'search_tickets', 'update_ticket', 'transition_ticket',
  'comment_ticket', 'list_ticket_states', 'list_ticket_labels', 'create_ticket_label',
  'relate_tickets', 'list_saved_views', 'get_saved_view', 'create_saved_view', 'update_saved_view', 'delete_saved_view',
  'list_projects', 'create_project', 'update_project', 'list_milestones', 'create_milestone', 'update_milestone',
].sort();
const TICKET_READ_TOOLS = [
  'get_ticket', 'list_tickets', 'search_tickets', 'list_ticket_states', 'list_ticket_labels',
  'list_saved_views', 'get_saved_view', 'list_projects', 'list_milestones',
].sort();
const CLOUD_TOKEN = 'c'.repeat(48);

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let owner: Account;
let member: Account;
let guest: Account;
let teamId: string;
let baseline: { token: string; id: string };
let baselineTicket: Body;
const issued: { cookie: string; id: string }[] = [];

async function makeToken(account: Account, tracker?: 'read' | 'write' | null) {
  const body = { name: `tracker ${Math.random().toString(36).slice(2)}`, scope: 'read', ...(tracker === undefined ? {} : { tracker }) };
  const made = await h.api(account.cookie, 'POST', '/api/me/tokens', body);
  expect(made.status).toBe(201);
  issued.push({ cookie: account.cookie, id: made.body.id });
  return made.body as { id: string; token: string; tracker: string | null };
}

function ticketCounts(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try {
    return {
      tickets: db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n,
      events: db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n,
      comments: db.prepare('SELECT COUNT(*) AS n FROM ticket_comments').get()!.n,
      labels: db.prepare('SELECT COUNT(*) AS n FROM labels').get()!.n,
      ticketLabels: db.prepare('SELECT COUNT(*) AS n FROM ticket_labels').get()!.n,
      subscriptions: db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get()!.n,
      notifications: db.prepare('SELECT COUNT(*) AS n FROM notifications').get()!.n,
      versions: db.prepare('SELECT COUNT(*) AS n FROM ticket_field_versions').get()!.n,
      searchRows: db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n,
      projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n,
      milestones: db.prepare('SELECT COUNT(*) AS n FROM milestones').get()!.n,
      relations: db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get()!.n,
      savedViews: db.prepare('SELECT COUNT(*) AS n FROM saved_views').get()!.n,
      nextNumber: db.prepare("SELECT next_number AS n FROM ticket_counters WHERE scope = 'trk_default' AND prefix = 'TAB'").get()!.n,
    };
  } finally {
    db.close();
  }
}

// A 429 from the MCP endpoint: the JSON-RPC error carries the reason and the wait, and the Retry-After header repeats the wait.
function expectRateLimited(res: { status: number; body: Body; headers: Headers }) {
  expect(res.status).toBe(429);
  expect(res.body.error.data).toMatchObject({ error: 'rate_limited' });
  expect(res.body.error.data.retryAfterSec).toBeGreaterThan(0);
  expect(res.headers.get('retry-after')).toBe(String(res.body.error.data.retryAfterSec));
}

// The mcp.limit audit rows written for one token, oldest first, with the actor they were written under.
function limitAuditRows(directory: string, tokenId: string) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try {
    return db.prepare("SELECT actor_id, detail FROM audit WHERE action = 'mcp.limit' ORDER BY id").all()
      .map((row) => ({ actorId: row.actor_id, ...JSON.parse(String(row.detail)) }))
      .filter((row) => row.tokenId === tokenId);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);
  guest = await h.joinTeam(owner.cookie, teamId);
  const guestRole = await h.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (guestRole.status !== 200) throw new Error(`could not make a guest (${guestRole.status})`);
  baseline = await makeToken(owner, 'write');
  const made = await h.tool(baseline.token, 'create_ticket', { title: 'Tracker baseline', idempotencyKey: 'baseline-ticket-key' });
  if (made.error) throw new Error(`could not create baseline ticket (${made.error})`);
  baselineTicket = made.data.ticket;
});

afterEach(async () => {
  for (const token of issued.splice(0)) await h.api(token.cookie, 'DELETE', `/api/me/tokens/${token.id}`);
});

afterAll(async () => {
  await h.cleanup();
});

describe('MCP tracker capability', () => {
  it('lists token capability in self and admin views and hides tools without it', async () => {
    const without = await makeToken(owner);
    expect(without.tracker).toBeNull();
    const read = await makeToken(owner, 'read');
    const write = await makeToken(owner, 'write');

    const own = await h.api(owner.cookie, 'GET', '/api/me/tokens');
    expect(own.body.find((token: Body) => token.id === read.id).tracker).toBe('read');
    const admin = await h.api(owner.cookie, 'GET', '/api/admin/tokens');
    expect(admin.body.find((token: Body) => token.id === write.id).tracker).toBe('write');

    const names = async (token: string) => (await h.call(token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name).sort();
    expect((await names(without.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual([]);
    expect((await names(read.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual(TICKET_READ_TOOLS);
    expect((await names(write.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual(TICKET_TOOLS);

    const hidden = await h.call(without.token, 'tools/call', { name: 'list_ticket_states', arguments: {} });
    const missing = await h.call(without.token, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
    expect(hidden.body.error).toEqual(missing.body.error);
    expect(hidden.body.error).toMatchObject({ code: -32602, message: 'Unknown tool' });
  });

  it('supports ticket CRUD, search, workflow, labels, idempotency, history and fenced text', async () => {
    const writer = await makeToken(owner, 'write');
    const states = await h.tool(writer.token, 'list_ticket_states');
    expect(states.data.states.map((state: Body) => state.name)).toEqual(['To do', 'In progress', 'In review', 'Done', 'Cancelled']);
    expect(states.data).toMatchObject({ cleaned: false, truncated: false });

    const madeLabel = await h.tool(writer.token, 'create_ticket_label', { name: 'Bug', color: '#D02020' });
    expect(madeLabel.error).toBeUndefined();
    const labelId = madeLabel.data.label.id;
    expect((await h.tool(writer.token, 'list_ticket_labels')).data.labels).toContainEqual(expect.objectContaining({ id: labelId, name: 'Bug' }));

    const project = await h.tool(writer.token, 'create_project', { name: 'Platform', owner: 'me', state: 'started', description: 'Project description' });
    expect(project.error).toBeUndefined();
    expect(project.data.project).toMatchObject({ name: 'Platform', state: 'started', owner: { userId: owner.user.id } });
    expect(project.text).toContain('[board-content nonce=');
    expect(project.data).toMatchObject({ cleaned: false, truncated: false });
    const milestone = await h.tool(writer.token, 'create_milestone', {
      projectId: project.data.project.id, name: 'Release 1', due: '2099-04-01', state: 'planned',
    });
    expect(milestone.error).toBeUndefined();
    expect((await h.tool(writer.token, 'list_projects')).data.projects).toContainEqual(expect.objectContaining({ id: project.data.project.id }));
    expect((await h.tool(writer.token, 'list_milestones', { projectId: project.data.project.id })).data.milestones)
      .toContainEqual(expect.objectContaining({ id: milestone.data.milestone.id, due: '2099-04-01' }));

    const root = await h.tool(writer.token, 'create_ticket', {
      title: 'Private title for audit test', description: 'Parent description', state: 'in_progress', priority: 'urgent',
      assignee: 'me', labels: ['Bug'], due: '2099-02-03', project: 'platform', milestone: 'release 1', idempotencyKey: 'root-ticket-idem',
    });
    expect(root.error).toBeUndefined();
    expect(root.data.ticket).toMatchObject({ title: 'Private title for audit test', state: { key: 'in_progress', name: 'In progress' }, priority: 'urgent', due: '2099-02-03', project: { id: project.data.project.id, name: 'Platform' }, milestone: { id: milestone.data.milestone.id, name: 'Release 1', due: '2099-04-01' }, labels: [expect.objectContaining({ id: labelId, name: 'Bug' })] });
    const retried = await h.tool(writer.token, 'create_ticket', { title: 'ignored on retry', idempotencyKey: 'root-ticket-idem' });
    expect(retried.data.ticket.id).toBe(root.data.ticket.id);
    expect(retried.data.ticket.key).toBe(root.data.ticket.key);

    const child = await h.tool(writer.token, 'create_ticket', {
      title: 'Search needle child', description: 'Child description', parent: root.data.ticket.key,
      labels: ['Bug'], idempotencyKey: 'child-ticket-idem',
    });
    expect(child.error).toBeUndefined();
    expect(child.data.ticket.parent).toBe(root.data.ticket.key);
    const list = await h.tool(writer.token, 'list_tickets', { filter: ['state:In progress'], limit: 50 });
    expect(list.data.tickets.some((ticket: Body) => ticket.id === root.data.ticket.id)).toBe(true);
    expect(list.data.nextCursor).toBeNull();
    const search = await h.tool(writer.token, 'search_tickets', { query: 'needle', filter: ['label:Bug'] });
    expect(search.data.tickets.map((ticket: Body) => ticket.id)).toContain(child.data.ticket.id);
    expect((await h.tool(writer.token, 'list_tickets', { filter: ['nonsense:value'] })).error).toBe('invalid_filter');

    const updated = await h.tool(writer.token, 'update_ticket', {
      key: child.data.ticket.key, title: 'Search needle updated', assignee: 'me', due: '2099-03-04',
      project: 'Platform', milestone: 'Release 1', ifUpdatedSeq: child.data.ticket.updatedSeq,
    });
    expect(updated.error).toBeUndefined();
    expect(updated.data.ticket).toMatchObject({ title: 'Search needle updated', due: '2099-03-04', assignee: { userId: owner.user.id }, project: { name: 'Platform' }, milestone: { name: 'Release 1' } });
    const stale = await h.tool(writer.token, 'update_ticket', {
      key: child.data.ticket.key, title: 'stale update', ifUpdatedSeq: child.data.ticket.updatedSeq,
    });
    expect(stale.error).toBe('conflict');

    const transitioned = await h.tool(writer.token, 'transition_ticket', { key: child.data.ticket.key, state: 'Done' });
    expect(transitioned.data.ticket.state.name).toBe('Done');
    const linked = await h.tool(writer.token, 'relate_tickets', { key: root.data.ticket.key, relation: 'blocks', otherKey: child.data.ticket.key });
    expect(linked.error).toBeUndefined();
    expect(linked.data.ticket.relations).toContainEqual({ kind: 'blocks', key: child.data.ticket.key });
    await h.tool(writer.token, 'relate_tickets', { key: child.data.ticket.key, relation: 'blocked_by', otherKey: root.data.ticket.key });
    const relatedDb = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      expect(relatedDb.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get()!.n).toBe(1);
      expect(relatedDb.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE event_type = 'related'").get()!.n).toBe(2);
    } finally { relatedDb.close(); }

    const saved = await h.tool(writer.token, 'create_saved_view', { name: 'Done tickets', filter: ['state:done'], shared: true });
    expect(saved.error).toBeUndefined();
    expect((await h.tool(writer.token, 'list_saved_views')).data.views).toContainEqual(expect.objectContaining({ id: saved.data.view.id, shared: true }));
    const savedRun = await h.tool(writer.token, 'get_saved_view', { viewId: saved.data.view.id, limit: 50 });
    expect(savedRun.data.tickets.map((ticket: Body) => ticket.id)).toContain(child.data.ticket.id);
    const savedUpdate = await h.tool(writer.token, 'update_saved_view', { viewId: saved.data.view.id, name: 'Renamed view', shared: false });
    expect(savedUpdate.data.view.name).toBe('Renamed view');
    expect((await h.tool(writer.token, 'delete_saved_view', { viewId: saved.data.view.id })).data.deleted).toBe(true);

    const changedProject = await h.tool(writer.token, 'update_project', { projectId: project.data.project.id, state: 'paused' });
    expect(changedProject.data.project.state).toBe('paused');
    const changedMilestone = await h.tool(writer.token, 'update_milestone', { milestoneId: milestone.data.milestone.id, state: 'started' });
    expect(changedMilestone.data.milestone.state).toBe('started');

    const comment = await h.tool(writer.token, 'comment_ticket', { key: child.data.ticket.key, body: 'A private comment', clientId: 'comment-client-1' });
    expect(comment.error).toBeUndefined();
    const commentRetry = await h.tool(writer.token, 'comment_ticket', { key: child.data.ticket.key, body: 'ignored on retry', clientId: 'comment-client-1' });
    expect(commentRetry.data.comment.id).toBe(comment.data.comment.id);

    const detail = await h.tool(writer.token, 'get_ticket', { key: child.data.ticket.key });
    expect(detail.error).toBeUndefined();
    expect(detail.data.ticket).toMatchObject({ id: child.data.ticket.id, state: { name: 'Done' }, parent: root.data.ticket.key });
    expect(detail.data.comments).toEqual([expect.objectContaining({ id: comment.data.comment.id, body: 'A private comment' })]);
    expect(detail.data.events.map((event: Body) => event.eventType)).toEqual(expect.arrayContaining(['created', 'updated', 'transitioned', 'commented']));
    expect(detail.text).toContain('[board-content nonce=');
    expect(detail.data).toMatchObject({ cleaned: false, truncated: false });

    const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      const createdEvent = db.prepare("SELECT actor_type, actor_id, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'created'").get(root.data.ticket.id) as Body;
      expect(createdEvent).toMatchObject({ actor_type: 'mcp_token', actor_id: writer.id });
      expect(JSON.parse(createdEvent.details_json)).toMatchObject({ ownerUserId: owner.user.id });
      expect(db.prepare('SELECT actor_type, actor_id, COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? GROUP BY actor_type, actor_id').get(child.data.ticket.id)).toMatchObject({ actor_type: 'mcp_token', actor_id: writer.id, n: 1 });
    } finally {
      db.close();
    }

    const audit = await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.create_ticket');
    const ticketAudit = audit.body.entries.find((entry: Body) => entry.detail.ids?.includes(root.data.ticket.id));
    expect(ticketAudit).toMatchObject({ actorId: owner.user.id, action: 'mcp.create_ticket', detail: { tokenId: writer.id, room: 'tracker', ids: [root.data.ticket.id] } });
    expect(JSON.stringify(ticketAudit.detail)).not.toContain('Private title for audit test');
    expect(JSON.stringify(ticketAudit.detail)).not.toContain('Parent description');

    // Simulate legacy/imported text that bypassed command validation: MCP output removes invisible code points and clips long text.
    const raw = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      raw.prepare('UPDATE tickets SET title = ?, description = ? WHERE id = ?').run('Injected\u200B title', 'x'.repeat(20_500), child.data.ticket.id);
    } finally {
      raw.close();
    }
    const fenced = await h.tool(writer.token, 'get_ticket', { key: child.data.ticket.key });
    expect(fenced.text).toContain('[board-content nonce=');
    expect(fenced.data.ticket.title).toBe('Injected title');
    expect(fenced.data.ticket.description.length).toBeLessThan(20_500);
    expect(fenced.data).toMatchObject({ cleaned: true, truncated: true });
  });

  it('rejects empty and punctuation-only search queries with the query path', async () => {
    const reader = await makeToken(member, 'read');
    for (const query of ['', '... ---']) {
      const result = await h.tool(reader.token, 'search_tickets', { query });
      expect(result.error).toBe('invalid_input');
      expect(result.data).toMatchObject({ message: 'Enter something to search for', path: 'query' });
    }
  });

  it('returns not_found for every ticket operation by a guest owner with a tracker capability', async () => {
    const guestToken = await makeToken(guest, 'write');
    const memberRead = await makeToken(member, 'read');
    const absent = await h.tool(memberRead.token, 'get_ticket', { key: 'TAB-999999' });
    const concealed = await h.tool(guestToken.token, 'get_ticket', { key: baselineTicket.key });
    expect(concealed.text).toBe(absent.text);
    const names = (await h.call(guestToken.token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
    expect(names).toEqual(expect.arrayContaining(TICKET_TOOLS));
    const attempts: [string, Record<string, unknown>][] = [
      ['get_ticket', { key: baselineTicket.key }],
      ['list_tickets', {}],
      ['search_tickets', { query: 'baseline' }],
      ['list_ticket_states', {}],
      ['list_ticket_labels', {}],
      ['create_ticket', { title: 'hidden', idempotencyKey: 'guest-create-key' }],
      ['update_ticket', { key: baselineTicket.key, title: 'hidden update' }],
      ['transition_ticket', { key: baselineTicket.key, state: 'Done' }],
      ['comment_ticket', { key: baselineTicket.key, body: 'hidden comment' }],
      ['create_ticket_label', { name: 'Hidden' }],
      ['relate_tickets', { key: baselineTicket.key, relation: 'relates_to', otherKey: baselineTicket.key }],
      ['list_saved_views', {}],
      ['get_saved_view', { viewId: 'hidden-view' }],
      ['create_saved_view', { name: 'Hidden' }],
      ['update_saved_view', { viewId: 'hidden-view', name: 'Hidden' }],
      ['delete_saved_view', { viewId: 'hidden-view' }],
      ['list_projects', {}],
      ['create_project', { name: 'Hidden' }],
      ['update_project', { projectId: 'hidden-project', name: 'Hidden' }],
      ['list_milestones', { projectId: 'hidden-project' }],
      ['create_milestone', { projectId: 'hidden-project', name: 'Hidden', due: '2099-01-01' }],
      ['update_milestone', { milestoneId: 'hidden-milestone', name: 'Hidden' }],
    ];
    for (const [name, args] of attempts) expect((await h.tool(guestToken.token, name, args)).error).toBe('not_found');
  });

  it('does not charge idempotent create retries against the 10 per minute cap', async () => {
    const writer = await makeToken(member, 'write');
    let firstId = '';
    for (let i = 0; i < 10; i++) {
      const made = await h.tool(writer.token, 'create_ticket', { title: `Rate cap ${i}`, idempotencyKey: `rate-cap-${i}-key` });
      expect(made.error).toBeUndefined();
      if (i === 0) firstId = made.data.ticket.id;
    }
    const retry = await h.tool(writer.token, 'create_ticket', { title: 'Ignored retry title', idempotencyKey: 'rate-cap-0-key' });
    expect(retry.error).toBeUndefined();
    expect(retry.data.ticket.id).toBe(firstId);
    const limited = await h.call(writer.token, 'tools/call', { name: 'create_ticket', arguments: { title: 'Rate cap extra' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.data).toMatchObject({ error: 'rate_limited' });
    expect(limited.body.error.data.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('agent ticket text limits and tool surface (TAB-330)', () => {
  it('refuses a 20,001 character description or comment with invalid_input and writes nothing, and takes exactly 20,000', async () => {
    const writer = await makeToken(member, 'write');
    const target = await h.tool(writer.token, 'create_ticket', { title: 'Comment target', idempotencyKey: 'comment-target-ticket' });
    expect(target.error).toBeUndefined();
    const key = target.data.ticket.key as string;
    const countsBefore = ticketCounts(h.dir);

    const tooLong = 'a'.repeat(20_001);
    const created = await h.tool(writer.token, 'create_ticket', { title: 'Too long', description: tooLong, idempotencyKey: 'too-long-description' });
    expect(created.error).toBe('invalid_input');
    expect(created.data.path).toBe('description');
    const commented = await h.tool(writer.token, 'comment_ticket', { key, body: tooLong });
    expect(commented.error).toBe('invalid_input');
    expect(commented.data.path).toBe('body');
    expect(ticketCounts(h.dir)).toEqual(countsBefore);

    const longest = await h.tool(writer.token, 'comment_ticket', { key, body: 'a'.repeat(20_000) });
    expect(longest.error).toBeUndefined();
  });

  it('gives the tracker toolset no delete_ tool except delete_saved_view, and no bulk tool', async () => {
    const plain = await makeToken(owner);
    const writer = await makeToken(owner, 'write');
    const names = async (token: string): Promise<string[]> => (await h.call(token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name as string);
    const withoutTracker = new Set(await names(plain.token));
    // the tracker tools are the ones a write-capable token sees and a token without the capability does not
    const trackerTools = (await names(writer.token)).filter((name: string) => !withoutTracker.has(name)).sort();
    expect(trackerTools).toEqual(TICKET_TOOLS);
    expect(trackerTools.filter((name) => name.startsWith('delete_'))).toEqual(['delete_saved_view']);
    expect(trackerTools.filter((name) => name.includes('bulk'))).toEqual([]);
  });
});

describe('hourly cap on agent ticket edits and token attribution (TAB-330)', () => {
  // three update, transition or comment calls an hour per token; the count is in memory, so a restart starts it again
  const capped = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on', MCP_TICKET_HOURLY: '3', MCP_TICKET_CREATE_HOURLY: '4' } });
  let cappedOwner: Account;

  beforeAll(async () => {
    await capped.start();
    cappedOwner = await capped.signInOwner();
    await capped.newTeam(cappedOwner.cookie);
  });

  afterAll(async () => {
    await capped.cleanup();
  });

  async function tokenFor(name: string, tracker: 'read' | 'write' = 'write') {
    const made = await capped.api(cappedOwner.cookie, 'POST', '/api/me/tokens', { name, scope: 'read', tracker });
    expect(made.status).toBe(201);
    return { id: made.body.id as string, token: made.body.token as string };
  }

  async function ticketFor(token: string, title: string) {
    const made = await capped.tool(token, 'create_ticket', { title, idempotencyKey: `${title.replace(/\W/g, '-').toLowerCase()}-ticket` });
    expect(made.error).toBeUndefined();
    return made.data.ticket.key as string;
  }

  it('update_ticket: three calls succeed, the fourth is refused and the ticket is unchanged', async () => {
    const writer = await tokenFor('Update cap bot');
    const key = await ticketFor(writer.token, 'Update cap');
    for (const title of ['Update 1', 'Update 2', 'Update 3']) expect((await capped.tool(writer.token, 'update_ticket', { key, title })).error).toBeUndefined();
    const before = (await capped.tool(writer.token, 'get_ticket', { key })).data.ticket;
    const countsBefore = ticketCounts(capped.dir);

    expectRateLimited(await capped.call(writer.token, 'tools/call', { name: 'update_ticket', arguments: { key, title: 'Update 4' } }));
    expect(ticketCounts(capped.dir)).toEqual(countsBefore);
    const after = (await capped.tool(writer.token, 'get_ticket', { key })).data.ticket;
    expect(after).toEqual(before);
    expect(after.title).toBe('Update 3');
  });

  it('transition_ticket: three calls succeed, the fourth is refused and the state stays', async () => {
    const mover = await tokenFor('Transition cap bot');
    const key = await ticketFor(mover.token, 'Transition cap');
    for (const state of ['In progress', 'In review', 'Done']) expect((await capped.tool(mover.token, 'transition_ticket', { key, state })).error).toBeUndefined();
    const before = (await capped.tool(mover.token, 'get_ticket', { key })).data.ticket;
    const countsBefore = ticketCounts(capped.dir);

    expectRateLimited(await capped.call(mover.token, 'tools/call', { name: 'transition_ticket', arguments: { key, state: 'Cancelled' } }));
    expect(ticketCounts(capped.dir)).toEqual(countsBefore);
    const after = (await capped.tool(mover.token, 'get_ticket', { key })).data.ticket;
    expect(after).toEqual(before);
    expect(after.state.name).toBe('Done');
  });

  it('comment_ticket: three calls succeed, the fourth is refused and no comment is written', async () => {
    const commenter = await tokenFor('Comment cap bot');
    const key = await ticketFor(commenter.token, 'Comment cap');
    for (let i = 1; i <= 3; i++) expect((await capped.tool(commenter.token, 'comment_ticket', { key, body: `Comment ${i}` })).error).toBeUndefined();
    const countsBefore = ticketCounts(capped.dir);

    expectRateLimited(await capped.call(commenter.token, 'tools/call', { name: 'comment_ticket', arguments: { key, body: 'Comment 4' } }));
    expect(ticketCounts(capped.dir)).toEqual(countsBefore);
    expect((await capped.tool(commenter.token, 'get_ticket', { key })).data.comments).toHaveLength(3);
  });

  it('a refused call does not spend the per-minute write budget: a comment after 28 refusals still succeeds', async () => {
    const bot = await tokenFor('Refusal budget bot');
    const key = await ticketFor(bot.token, 'Refusal budget');
    for (let i = 1; i <= 3; i++) expect((await capped.tool(bot.token, 'update_ticket', { key, title: `Refusal ${i}` })).error).toBeUndefined();
    // 1 create and 3 updates are 4 of the 30 writes a minute; if the 28 refusals spent writes too, the comment would be the 33rd
    for (let i = 4; i <= 31; i++) expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'update_ticket', arguments: { key, title: `Refusal ${i}` } }));
    expect((await capped.tool(bot.token, 'comment_ticket', { key, body: 'After refusals' })).error).toBeUndefined();
  });

  it('keeps a budget per tool: a refused update leaves comments and transitions working, and create and reads are unaffected', async () => {
    const bot = await tokenFor('Separate budgets bot');
    const key = await ticketFor(bot.token, 'Separate budgets');
    for (let i = 1; i <= 3; i++) expect((await capped.tool(bot.token, 'update_ticket', { key, title: `Budget ${i}` })).error).toBeUndefined();
    expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'update_ticket', arguments: { key, title: 'Budget 4' } }));

    expect((await capped.tool(bot.token, 'comment_ticket', { key, body: 'Still allowed' })).error).toBeUndefined();
    expect((await capped.tool(bot.token, 'transition_ticket', { key, state: 'In progress' })).error).toBeUndefined();
    for (let i = 1; i <= 2; i++) expect((await capped.tool(bot.token, 'create_ticket', { title: `Unaffected ${i}`, idempotencyKey: `unaffected-${i}-key` })).error).toBeUndefined();
    expect((await capped.tool(bot.token, 'get_ticket', { key })).error).toBeUndefined();
    expect((await capped.tool(bot.token, 'list_tickets')).error).toBeUndefined();
    expect((await capped.tool(bot.token, 'search_tickets', { query: 'Unaffected' })).error).toBeUndefined();
  });

  it('create_ticket: four new tickets are allowed, the fifth is refused, a replay of an existing one still works', async () => {
    const bot = await tokenFor('Create cap bot');
    const keys: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const made = await capped.tool(bot.token, 'create_ticket', { title: `Create cap ${i}`, idempotencyKey: `create-cap-${i}-key` });
      expect(made.error).toBeUndefined();
      keys.push(made.data.ticket.key);
    }
    const countsBefore = ticketCounts(capped.dir);
    expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'create_ticket', arguments: { title: 'Create cap 5', idempotencyKey: 'create-cap-5-key' } }));
    expect(ticketCounts(capped.dir)).toEqual(countsBefore);

    // the same idempotency key returns the original ticket and costs nothing
    const replay = await capped.tool(bot.token, 'create_ticket', { title: 'Create cap 1', idempotencyKey: 'create-cap-1-key' });
    expect(replay.error).toBeUndefined();
    expect(replay.data.ticket.key).toBe(keys[0]);
    expect(ticketCounts(capped.dir)).toEqual(countsBefore);
    // updates are a different budget
    expect((await capped.tool(bot.token, 'update_ticket', { key: keys[0], title: 'Still editable' })).error).toBeUndefined();
    // one audit row, naming the tool and its cap
    for (let i = 6; i <= 8; i++) expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'create_ticket', arguments: { title: `Create cap ${i}`, idempotencyKey: `create-cap-${i}-key` } }));
    expect(limitAuditRows(capped.dir, bot.id)).toEqual([
      expect.objectContaining({ tool: 'create_ticket', cap: 4, window: 'hour' }),
    ]);
  });

  it('relate_tickets: three calls succeed, the fourth is refused, and it has its own budget (TAB-369)', async () => {
    const bot = await tokenFor('Relate cap bot');
    const a = await ticketFor(bot.token, 'Relate cap A');
    const b = await ticketFor(bot.token, 'Relate cap B');
    for (const remove of [false, true, false]) expect((await capped.tool(bot.token, 'relate_tickets', { key: a, relation: 'relates_to', otherKey: b, ...(remove ? { remove } : {}) })).error).toBeUndefined();
    expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'relate_tickets', arguments: { key: a, relation: 'relates_to', otherKey: b, remove: true } }));
    // the link is still there, and the other tools have their own budgets
    expect((await capped.tool(bot.token, 'get_ticket', { key: a })).data.ticket.relations).toHaveLength(1);
    expect((await capped.tool(bot.token, 'update_ticket', { key: a, title: 'Relate cap A edited' })).error).toBeUndefined();
  });

  it('writes one mcp.limit audit row per token and tool, however many calls are refused', async () => {
    const bot = await tokenFor('Audit cap bot');
    const key = await ticketFor(bot.token, 'Audit cap');
    for (let i = 1; i <= 3; i++) expect((await capped.tool(bot.token, 'update_ticket', { key, title: `Audit ${i}` })).error).toBeUndefined();
    for (let i = 4; i <= 8; i++) expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'update_ticket', arguments: { key, title: `Audit ${i}` } }));
    for (let i = 1; i <= 3; i++) expect((await capped.tool(bot.token, 'comment_ticket', { key, body: `Audit ${i}` })).error).toBeUndefined();
    for (let i = 4; i <= 5; i++) expectRateLimited(await capped.call(bot.token, 'tools/call', { name: 'comment_ticket', arguments: { key, body: `Audit ${i}` } }));

    expect(limitAuditRows(capped.dir, bot.id)).toEqual([
      { actorId: cappedOwner.user.id, tokenId: bot.id, tool: 'update_ticket', cap: 3, window: 'hour' },
      { actorId: cappedOwner.user.id, tokenId: bot.id, tool: 'comment_ticket', cap: 3, window: 'hour' },
    ]);
  });

  it('records the token id and token name on the events of its tickets, and sends the name to no REST or MCP reader', async () => {
    const named = await tokenFor('Attribution bot 7');
    const key = await ticketFor(named.token, 'Attribution');
    expect((await capped.tool(named.token, 'comment_ticket', { key, body: 'Looks good' })).error).toBeUndefined();

    const db = new DatabaseSync(path.join(capped.dir, 'directory.sqlite'));
    let events: Body[];
    try {
      const ticketId = (db.prepare('SELECT id FROM tickets WHERE key = ?').get(key) as Body).id;
      events = db.prepare('SELECT event_type, actor_type, actor_id, details_json FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(ticketId) as Body[];
    } finally {
      db.close();
    }
    expect(events.map((event) => event.event_type)).toEqual(['created', 'commented']);
    for (const event of events) {
      expect(event).toMatchObject({ actor_type: 'mcp_token', actor_id: named.id });
      expect(JSON.parse(String(event.details_json))).toMatchObject({ tokenName: 'Attribution bot 7', ownerUserId: cappedOwner.user.id });
    }

    const rest = await capped.api(cappedOwner.cookie, 'GET', `/api/tracker/tickets/${key}`);
    expect(rest.status).toBe(200);
    expect(rest.body.events.map((event: Body) => event.actor.id)).toContain(named.id);
    // the page labels an agent by the token owner's name (the agent member), never by the token's own name
    expect(rest.body.events.filter((event: Body) => event.actor.type === 'mcp_token').map((event: Body) => event.actor.name)).toEqual([cappedOwner.user.name, cappedOwner.user.name]);
    expect(JSON.stringify(rest.body)).not.toContain('Attribution bot 7');
    const mcp = await capped.tool(named.token, 'get_ticket', { key });
    expect(mcp.data.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(mcp.data.events)).not.toContain('Attribution bot 7');
  });

  it('with TABULA_MCP_TICKET_HOURLY=0 there is no cap, after a restart that starts the count again', async () => {
    await capped.stop();
    await capped.start({ TABULA_MCP_TICKET_HOURLY: '0', MIRA_MCP_TICKET_HOURLY: '0' });
    const free = await tokenFor('No cap bot');
    const key = await ticketFor(free.token, 'No cap');
    for (let i = 1; i <= 5; i++) expect((await capped.tool(free.token, 'update_ticket', { key, title: `Free ${i}` })).error).toBeUndefined();
    expect((await capped.tool(free.token, 'get_ticket', { key })).data.ticket.title).toBe('Free 5');
  });
});

describe('tracker disabled and open mode', () => {
  it('leaves ticket tools unknown when the flag is off and in open mode, while migrations still run', async () => {
    const disabled = createHarness({ accounts: true, settings: { MCP: 'on' } });
    try {
      await disabled.start();
      const signedIn = await disabled.signInOwner();
      const rejected = await disabled.api(signedIn.cookie, 'POST', '/api/me/tokens', { name: 'not enabled', scope: 'read', tracker: 'read' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.message).toBe('The tracker is not turned on');
      const ordinary = await disabled.newToken(signedIn.cookie, { scope: 'read' });
      const before = ticketCounts(disabled.dir);
      const names = (await disabled.call(ordinary.token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
      expect(names).not.toEqual(expect.arrayContaining(TICKET_TOOLS));
      const hidden = await disabled.call(ordinary.token, 'tools/call', { name: 'create_ticket', arguments: { title: 'no write' } });
      const missing = await disabled.call(ordinary.token, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
      expect(hidden.body.error).toEqual(missing.body.error);
      const after = ticketCounts(disabled.dir);
      expect(after).toEqual(before);
      const version = new DatabaseSync(path.join(disabled.dir, 'directory.sqlite'));
      try { expect(version.prepare('PRAGMA user_version').get()!.user_version).toBe(MIGRATIONS.length); } finally { version.close(); }
    } finally {
      await disabled.cleanup();
    }

    const shared = 'o'.repeat(48);
    const open = createHarness({ settings: { MCP: 'on', MCP_TOKEN: shared, TRACKER: 'on' } });
    try {
      await open.start();
      const names = (await open.call(shared, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
      expect(names).not.toEqual(expect.arrayContaining(TICKET_TOOLS));
      const hidden = await open.call(shared, 'tools/call', { name: 'create_ticket', arguments: { title: 'open no write' } });
      const missing = await open.call(shared, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
      expect(hidden.body.error).toEqual(missing.body.error);
    } finally {
      await open.cleanup();
    }
  });
});

describe('read-only hosted tracker', () => {
  it('refuses every mutation before writes and keeps ticket reads available', async () => {
    const cloud = createHarness({
      accounts: true,
      settings: { MCP: 'on', TRACKER: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-readonly' },
    });
    try {
      await cloud.start();
      const cloudOwner = await cloud.signInOwner();
      const writer = await cloud.newToken(cloudOwner.cookie, { scope: 'read', tracker: 'write' });
      const baseline = await cloud.tool(writer.token, 'create_ticket', { title: 'Read-only baseline', idempotencyKey: 'readonly-baseline' });
      expect(baseline.error).toBeUndefined();
      const project = await cloud.tool(writer.token, 'create_project', { name: 'Read-only project' });
      const milestone = await cloud.tool(writer.token, 'create_milestone', { projectId: project.data.project.id, name: 'Read-only milestone', due: '2099-01-01' });
      const view = await cloud.tool(writer.token, 'create_saved_view', { name: 'Read-only view', filter: [] });
      const limits = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(limits.status).toBe(200);
      const before = ticketCounts(cloud.dir);
      const attempts: [string, Record<string, unknown>][] = [
        ['create_ticket', { title: 'must not persist' }],
        ['update_ticket', { key: baseline.data.ticket.key, title: 'must not persist' }],
        ['transition_ticket', { key: baseline.data.ticket.key, state: 'Done' }],
        ['comment_ticket', { key: baseline.data.ticket.key, body: 'must not persist' }],
        ['create_ticket_label', { name: 'must not persist' }],
        ['relate_tickets', { key: baseline.data.ticket.key, relation: 'relates_to', otherKey: baseline.data.ticket.key }],
        ['create_project', { name: 'must not persist' }],
        ['update_project', { projectId: project.data.project.id, name: 'must not persist' }],
        ['create_milestone', { projectId: project.data.project.id, name: 'must not persist', due: '2099-01-01' }],
        ['update_milestone', { milestoneId: milestone.data.milestone.id, name: 'must not persist' }],
        ['create_saved_view', { name: 'must not persist', filter: [] }],
        ['update_saved_view', { viewId: view.data.view.id, name: 'must not persist' }],
        ['delete_saved_view', { viewId: view.data.view.id }],
      ];
      for (const [name, args] of attempts) {
        const result = await cloud.tool(writer.token, name, args);
        expect(result.error).toBe('read_only');
      }
      expect((await cloud.tool(writer.token, 'list_ticket_states')).error).toBeUndefined();
      expect((await cloud.tool(writer.token, 'list_tickets')).error).toBeUndefined();
      expect(ticketCounts(cloud.dir)).toEqual(before);
    } finally {
      await cloud.cleanup();
    }
  });
});

describe('tracker restore gate over MCP', () => {
  it('refuses every tracker write with tracker_restoring and its floor, keeps reads, and works again when the gate opens', async () => {
    const gated = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
    const setGate = (value: string | null) => {
      const db = new DatabaseSync(path.join(gated.dir, 'directory.sqlite'));
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        if (value === null) db.prepare("DELETE FROM settings WHERE key = 'tracker.restore_gate'").run();
        else db.prepare("INSERT INTO settings (key, value) VALUES ('tracker.restore_gate', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(value);
      } finally {
        db.close();
      }
    };
    // the relay caches the gate for about a second
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1300));
    try {
      await gated.start();
      const gatedOwner = await gated.signInOwner();
      const writer = await gated.newToken(gatedOwner.cookie, { scope: 'read', tracker: 'write' });
      const baseline = await gated.tool(writer.token, 'create_ticket', { title: 'Gate baseline', idempotencyKey: 'gate-baseline' });
      expect(baseline.error).toBeUndefined();
      const project = await gated.tool(writer.token, 'create_project', { name: 'Gate project' });
      const milestone = await gated.tool(writer.token, 'create_milestone', { projectId: project.data.project.id, name: 'Gate milestone', due: '2099-01-01' });
      const view = await gated.tool(writer.token, 'create_saved_view', { name: 'Gate view', filter: [] });
      const key = baseline.data.ticket.key;
      const before = ticketCounts(gated.dir);

      setGate(JSON.stringify({ since: Date.now(), reason: 'restore', floor: 'pending' }));
      await settle();
      const attempts: [string, Record<string, unknown>][] = [
        ['create_ticket', { title: 'must not persist' }],
        ['update_ticket', { key, title: 'must not persist' }],
        ['transition_ticket', { key, state: 'Done' }],
        ['comment_ticket', { key, body: 'must not persist' }],
        ['create_ticket_label', { name: 'must not persist' }],
        ['relate_tickets', { key, relation: 'relates_to', otherKey: key }],
        ['create_project', { name: 'must not persist' }],
        ['update_project', { projectId: project.data.project.id, name: 'must not persist' }],
        ['create_milestone', { projectId: project.data.project.id, name: 'must not persist', due: '2099-01-01' }],
        ['update_milestone', { milestoneId: milestone.data.milestone.id, name: 'must not persist' }],
        ['create_saved_view', { name: 'must not persist', filter: [] }],
        ['update_saved_view', { viewId: view.data.view.id, name: 'must not persist' }],
        ['delete_saved_view', { viewId: view.data.view.id }],
      ];
      for (const [name, args] of attempts) {
        const result = await gated.tool(writer.token, name, args);
        expect({ name, error: result.error, floor: result.data.floor }).toEqual({ name, error: 'tracker_restoring', floor: 'pending' });
      }
      expect((await gated.tool(writer.token, 'list_tickets')).error).toBeUndefined();
      expect((await gated.tool(writer.token, 'get_ticket', { key })).error).toBeUndefined();
      expect(ticketCounts(gated.dir)).toEqual(before);

      setGate(null);
      await settle();
      const after = await gated.tool(writer.token, 'create_ticket', { title: 'Gate open again', idempotencyKey: 'gate-open-again' });
      expect(after.error).toBeUndefined();
    } finally {
      await gated.cleanup();
    }
  });
});
