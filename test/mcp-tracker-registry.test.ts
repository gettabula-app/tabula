import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// TAB-369: an AI can read, update and manage the tracker but cannot DELETE anything from it; archiving is the strongest thing it
// may do, and it is reversible. This is the registry that keeps it so: every tool a tracker token adds must be classified here,
// none may delete, and nothing in the MCP source may call a tracker delete function. A new tool fails this test until a person
// classifies it.

type Kind = 'read' | 'create' | 'change' | 'link';
const TRACKER_TOOLS: Record<string, Kind> = {
  get_ticket: 'read', list_tickets: 'read', search_tickets: 'read', list_ticket_states: 'read', list_ticket_labels: 'read',
  list_saved_views: 'read', get_saved_view: 'read', list_projects: 'read', list_milestones: 'read',
  create_ticket: 'create', create_ticket_label: 'create', create_saved_view: 'create', create_project: 'create', create_milestone: 'create',
  // 'change' tools edit or add; none of them removes a row. `archived` is the only way to hide something and it is a reversible flag.
  update_ticket: 'change', transition_ticket: 'change', comment_ticket: 'change', update_saved_view: 'change', update_project: 'change', update_milestone: 'change',
  // relate_tickets can remove a link (a relation row, not a ticket); it is undone by adding the link again and each change has an event
  relate_tickets: 'link',
};
// TAB-369 commit 3 removes delete_saved_view from the AI set (it deletes only the caller's own saved filter); delete this line then.
const KNOWN_DELETE_EXCEPTIONS = ['delete_saved_view'];
const DELETE_LIKE = /^(delete|remove|purge|destroy|erase|drop)(_|$)/;

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let tracker: Body[] = [];

beforeAll(async () => {
  await h.start();
  const owner = await h.signInOwner();
  await h.newTeam(owner.cookie);
  const make = async (name: string, tracker?: 'write') => {
    const made = await h.api(owner.cookie, 'POST', '/api/me/tokens', { name, scope: 'read', ...(tracker ? { tracker } : {}) });
    expect(made.status).toBe(201);
    return made.body.token as string;
  };
  const list = async (token: string): Promise<Body[]> => (await h.call(token, 'tools/list')).body.result.tools;
  const without = (await list(await make('registry without'))).map((tool) => tool.name);
  tracker = (await list(await make('registry tracker', 'write'))).filter((tool) => !without.includes(tool.name));
});

afterAll(async () => {
  await h.cleanup();
});

describe('the tracker tools an AI token gets', () => {
  it('are exactly the classified set, so a new tool must be classified before it passes', () => {
    expect(tracker.map((tool) => tool.name).sort()).toEqual([...Object.keys(TRACKER_TOOLS), ...KNOWN_DELETE_EXCEPTIONS].sort());
  });

  it('include no tool that deletes, removes, purges or destroys (the saved-view exception goes in TAB-369 commit 3)', () => {
    const offenders = tracker.map((tool) => tool.name as string).filter((name) => DELETE_LIKE.test(name) && !KNOWN_DELETE_EXCEPTIONS.includes(name));
    expect(offenders).toEqual([]);
    for (const name of KNOWN_DELETE_EXCEPTIONS) expect(DELETE_LIKE.test(name)).toBe(true); // the exception list only holds real exceptions
  });

  it('are none of them marked destructive, apart from the known exception', () => {
    const destructive = tracker.filter((tool) => !KNOWN_DELETE_EXCEPTIONS.includes(tool.name) && tool.annotations?.destructiveHint === true).map((tool) => tool.name);
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
