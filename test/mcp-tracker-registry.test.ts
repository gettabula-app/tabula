import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// TAB-369: an AI can read, update and manage the tracker but cannot DELETE anything from it; archiving is the strongest thing it
// may do, and it is reversible. This is the registry that keeps it so: every tool a tracker token adds must be classified here,
// none may delete, and nothing in the MCP source may call a tracker delete function. A new tool fails this test until a person
// classifies it.

type Kind = 'read' | 'create' | 'change' | 'reversible-hard-delete-of-link';
const TRACKER_TOOLS: Record<string, Kind> = {
  get_ticket: 'read', list_tickets: 'read', search_tickets: 'read', ticket_meta: 'read',
  list_saved_views: 'read', get_saved_view: 'read', list_projects: 'read', list_milestones: 'read',
  create_ticket: 'create', create_ticket_label: 'create', create_saved_view: 'create', create_project: 'create', create_milestone: 'create',
  // 'change' tools edit or add; none of them removes a row. `archived` is the only way to hide something and it is a reversible flag.
  update_ticket: 'change', update_tickets: 'change', transition_ticket: 'change', comment_ticket: 'change', update_saved_view: 'change', update_project: 'change', update_milestone: 'change',
  // update_tickets is the only bulk form: up to 25 tickets, all or nothing. Its patch has no title, description, parent or ifUpdatedSeq
  // and refuses `archived: true` (tested below), so one call cannot hide a backlog.
  // relate_tickets can remove a link: a hard DELETE of one relation row, which carries no content of its own. It counts as reversible
  // only because the 'unrelated' event keeps both ticket keys and the kind (tested), so a person can add the link again. A tool
  // that deletes a row with real content must not use this label. It is also in the hourly cap set and has no bulk form.
  relate_tickets: 'reversible-hard-delete-of-link',
};
const DELETE_LIKE = /^(delete|remove|purge|destroy|erase|drop)(_|$)/;

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let tracker: Body[] = [];
let owner: Awaited<ReturnType<typeof h.signInOwner>>;
let writeToken = '';

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  await h.newTeam(owner.cookie);
  const make = async (name: string, tracker?: 'write') => {
    const made = await h.api(owner.cookie, 'POST', '/api/me/tokens', { name, scope: 'read', ...(tracker ? { tracker } : {}) });
    expect(made.status).toBe(201);
    return made.body.token as string;
  };
  const list = async (token: string): Promise<Body[]> => (await h.call(token, 'tools/list')).body.result.tools;
  const without = (await list(await make('registry without'))).map((tool) => tool.name);
  writeToken = await make('registry tracker', 'write');
  tracker = (await list(writeToken)).filter((tool) => !without.includes(tool.name));
});

afterAll(async () => {
  await h.cleanup();
});

describe('the tracker tools an AI token gets', () => {
  it('are exactly the classified set, so a new tool must be classified before it passes', () => {
    expect(tracker.map((tool) => tool.name).sort()).toEqual(Object.keys(TRACKER_TOOLS).sort());
  });

  it('include no tool that deletes, removes, purges or destroys', () => {
    const offenders = tracker.map((tool) => tool.name as string).filter((name) => DELETE_LIKE.test(name));
    expect(offenders).toEqual([]);
  });

  it('are none of them marked destructive', () => {
    const destructive = tracker.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name);
    expect(destructive).toEqual([]);
  });

  it('read tools are marked read-only and every other tool is not', () => {
    const wrong = tracker
      .filter((tool) => TRACKER_TOOLS[tool.name] && Boolean(tool.annotations?.readOnlyHint) !== (TRACKER_TOOLS[tool.name] === 'read'))
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });

  it('use a reversible boolean for archiving: only update_ticket, update_project and update_milestone take `archived`', () => {
    const withArchived = tracker.filter((tool) => tool.inputSchema?.properties && Object.hasOwn(tool.inputSchema.properties, 'archived'));
    expect(withArchived.map((tool) => tool.name).sort()).toEqual(['update_milestone', 'update_project', 'update_ticket']);
    for (const tool of withArchived) expect(tool.inputSchema.properties.archived).toEqual({ type: 'boolean' });
  });

  it('give the bulk tool a patch that cannot archive or edit text, parents or sequence guards', () => {
    const bulk = tracker.find((tool) => tool.name === 'update_tickets');
    expect(Object.keys(bulk?.inputSchema.properties).sort()).toEqual(['keys', 'patch']);
    const patch = bulk?.inputSchema.properties.patch.properties;
    for (const field of ['title', 'description', 'parent', 'ifUpdatedSeq']) expect(Object.keys(patch)).not.toContain(field);
    expect(patch.archived).toEqual({ type: 'boolean' });
    expect(bulk?.inputSchema.properties.keys).toMatchObject({ maxItems: 25, items: { maxLength: 128 } });
  });

  it('refuses archiving in bulk at runtime, and archives nothing', async () => {
    const made = await h.tool(writeToken, 'create_ticket', { title: 'Registry bulk archive', idempotencyKey: 'registry-bulk-archive' });
    const key = made.data.ticket.key as string;
    const refused = await h.tool(writeToken, 'update_tickets', { keys: [key], patch: { archived: true } });
    expect(refused.error).toBe('forbidden');
    expect((await h.tool(writeToken, 'get_ticket', { key })).data.ticket.archivedAt).toBeNull();
  });
});

describe('the MCP source', () => {
  it('does not import or call any tracker function that deletes a ticket, comment, project, milestone or label', () => {
    const source = fs.readFileSync(new URL('../server/mcp.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(deleteTicket|deleteTicketComment|deleteComment|deleteProject|deleteMilestone|deleteLabel|deleteTicketLabel)\b/);
  });

  it('does not let a retention job purge archived tickets, projects, milestones or labels', () => {
    // archive must never be a delete in disguise: no server code removes those rows
    const files = fs.readdirSync(new URL('../server/tracker/', import.meta.url)).filter((name) => name.endsWith('.mjs'));
    const deletes = files.flatMap((name) => {
      const text = fs.readFileSync(new URL(`../server/tracker/${name}`, import.meta.url), 'utf8');
      return [...text.matchAll(/DELETE\s+FROM\s+(tickets|projects|milestones|labels|ticket_comments)\b/gi)].map((match) => `${name}: ${match[0]}`);
    });
    expect(deletes).toEqual([]);
  });
});

// the sqlite file of the harness, for events the tools do not return (the token id) and for the rows that must still exist
function events(ticketKey: string) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    return db.prepare(`SELECT e.event_type, e.actor_type, e.actor_id, e.details_json FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.key = ? ORDER BY e.id`)
      .all(ticketKey) as Body[];
  } finally {
    db.close();
  }
}

describe('archiving by an AI token', () => {
  it('hides a ticket and restores it, both recorded with the token, and nothing is deleted', async () => {
    const made = await h.tool(writeToken, 'create_ticket', { title: 'Archive me', idempotencyKey: 'archive-me-ticket-key' });
    const key = made.data.ticket.key as string;
    expect((await h.tool(writeToken, 'update_ticket', { key, archived: true })).error).toBeUndefined();
    expect((await h.tool(writeToken, 'get_ticket', { key })).data.ticket.archivedAt).not.toBeNull();
    expect((await h.tool(writeToken, 'update_ticket', { key, archived: false })).error).toBeUndefined();
    expect((await h.tool(writeToken, 'get_ticket', { key })).data.ticket.archivedAt).toBeNull();
    const rows = events(key).filter((row) => ['archived', 'restored'].includes(row.event_type));
    expect(rows.map((row) => row.event_type)).toEqual(['archived', 'restored']);
    for (const row of rows) {
      expect(row.actor_type).toBe('mcp_token');
      expect(typeof row.actor_id).toBe('string');
    }
  });

  it('may restore a project and a milestone but not archive them', async () => {
    const createdProject = await h.tool(writeToken, 'create_project', { name: 'Archive guard project' });
    const project = createdProject.data.project;
    const refusedProject = await h.tool(writeToken, 'update_project', { projectId: project.id, archived: true });
    expect(refusedProject.error).toBe('forbidden');
    const createdMilestone = await h.tool(writeToken, 'create_milestone', { projectId: project.id, name: 'Archive guard milestone', due: '2026-12-01' });
    const milestone = createdMilestone.data.milestone;
    expect((await h.tool(writeToken, 'update_milestone', { milestoneId: milestone.id, archived: true })).error).toBe('forbidden');
    // a person archives them; the AI can restore them
    expect((await h.api(owner.cookie, 'PATCH', `/api/tracker/milestones/${milestone.id}`, { archived: true })).status).toBe(200);
    expect((await h.api(owner.cookie, 'PATCH', `/api/tracker/projects/${project.id}`, { archived: true })).status).toBe(200);
    expect((await h.tool(writeToken, 'update_project', { projectId: project.id, archived: false })).error).toBeUndefined();
    expect((await h.tool(writeToken, 'update_milestone', { milestoneId: milestone.id, archived: false })).error).toBeUndefined();
  });
});

describe('removing a link by an AI token', () => {
  it('keeps both ticket keys and the relation kind on the unrelated event, so a person can add the link again', async () => {
    const a = (await h.tool(writeToken, 'create_ticket', { title: 'Link A', idempotencyKey: 'link-a-ticket-key' })).data.ticket.key as string;
    const b = (await h.tool(writeToken, 'create_ticket', { title: 'Link B', idempotencyKey: 'link-b-ticket-key' })).data.ticket.key as string;
    expect((await h.tool(writeToken, 'relate_tickets', { key: a, relation: 'blocks', otherKey: b })).error).toBeUndefined();
    expect((await h.tool(writeToken, 'relate_tickets', { key: a, relation: 'blocks', otherKey: b, remove: true })).error).toBeUndefined();
    const forA = events(a).filter((row) => row.event_type === 'unrelated').map((row) => JSON.parse(String(row.details_json)));
    const forB = events(b).filter((row) => row.event_type === 'unrelated').map((row) => JSON.parse(String(row.details_json)));
    expect(forA).toEqual([expect.objectContaining({ relatedTicketKey: b, relationKind: 'blocks' })]);
    expect(forB).toEqual([expect.objectContaining({ relatedTicketKey: a, relationKind: 'blocked_by' })]);
  });
});
