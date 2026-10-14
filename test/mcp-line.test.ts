import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// Lines over MCP (docs/lines.md, docs/mcp.md): created as type line or as a connector with line: true, read back as type line.
const h = createHarness({ accounts: true, settings: { MCP: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
let owner: Account;
let boardId: string;
let writeToken: string;
let readToken: string;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const team = await h.newTeam(owner.cookie);
  const person = await h.joinTeam(owner.cookie, team.id);
  boardId = await h.newBoard(person.cookie);
  writeToken = (await h.newToken(person.cookie, { scope: 'write', boardIds: [boardId] })).token;
  readToken = (await h.newToken(person.cookie, { scope: 'read', boardIds: [boardId] })).token;
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('MCP lines', () => {
  it('creates a line as type line and as a connector with line true, with the line defaults', async () => {
    const made = await h.tool(writeToken, 'create_objects', {
      boardId,
      objects: [
        { type: 'line', ref: 'a', from: { x: 10, y: 10 }, to: { x: 120, y: 60 } },
        { type: 'connector', line: true, ref: 'b', from: { x: 0, y: 200 }, to: { x: 80, y: 200 }, stroke: '#112233', dash: 'dashed' },
      ],
    });
    expect(made.error).toBeUndefined();
    expect(made.data.created.map((c: { type: string }) => c.type)).toEqual(['line', 'line']);

    const ids = made.data.created.map((c: { id: string }) => c.id);
    const read = await h.tool(readToken, 'get_objects', { boardId, ids });
    expect(read.error).toBeUndefined();
    const [first, second] = read.data.objects as Record<string, unknown>[];
    expect(first).toEqual({
      id: ids[0], type: 'line', from: { x: 10, y: 10 }, to: { x: 120, y: 60 }, strokeWidth: 2, dash: 'solid', startHead: 'none', endHead: 'none',
    });
    expect(second).toMatchObject({ type: 'line', stroke: '#112233', dash: 'dashed', strokeWidth: 2 });
    expect(second.from).toEqual({ x: 0, y: 200 });
  });

  it('refuses a line with an attached end, with the field named', async () => {
    const shape = await h.tool(writeToken, 'create_objects', { boardId, objects: [{ type: 'shape', ref: 'box', x: 300, y: 300, w: 100, h: 100 }] });
    expect(shape.error).toBeUndefined();
    const id = shape.data.created[0].id as string;
    const refused = await h.tool(writeToken, 'create_objects', { boardId, objects: [{ type: 'line', from: { id }, to: { x: 0, y: 0 } }] });
    expect(refused.error).toBeDefined();
    expect(JSON.stringify(refused)).toMatch(/objects\[0\]/);
  });

  it('a line stays a line when restyled and becomes a connector when an end is attached', async () => {
    const made = await h.tool(writeToken, 'create_objects', {
      boardId,
      objects: [
        { type: 'line', ref: 'l', from: { x: 400, y: 10 }, to: { x: 500, y: 10 } },
        { type: 'shape', ref: 'box', x: 600, y: 300, w: 100, h: 100 },
      ],
    });
    const [lineId, boxId] = made.data.created.map((c: { id: string }) => c.id) as string[];
    const restyled = await h.tool(writeToken, 'update_objects', {
      boardId,
      updates: [{ id: lineId, strokeWidth: 5, endHead: 'arrow', dash: 'dotted' }],
    });
    expect(restyled.error).toBeUndefined();
    const after = await h.tool(readToken, 'get_objects', { boardId, ids: [lineId] });
    expect(after.data.objects[0]).toMatchObject({ type: 'line', strokeWidth: 5, endHead: 'arrow', dash: 'dotted' });

    const attached = await h.tool(writeToken, 'update_objects', { boardId, updates: [{ id: lineId, to: { id: boxId } }] });
    expect(attached.error).toBeUndefined();
    const connector = await h.tool(readToken, 'get_objects', { boardId, ids: [lineId] });
    expect(connector.data.objects[0].type).toBe('connector');
    expect(connector.data.objects[0].to).toMatchObject({ kind: 'bound', id: boxId });
  });

  it('shows lines in the Markdown export as lines, and lists them under the line type', async () => {
    const exported = await h.tool(readToken, 'export', { boardId, format: 'markdown' });
    expect(exported.error).toBeUndefined();
    expect(exported.data.content).toMatch(/- Line \(10, 10\) to \(120, 60\)/);
    const board = await h.tool(readToken, 'get_board', { boardId });
    expect(board.data.counts.byType.line).toBeGreaterThanOrEqual(2);
  });

  it('advertises the line type in the create and filter schemas', async () => {
    const listed = await h.call(writeToken, 'tools/list');
    const create = listed.body.result.tools.find((t: { name: string }) => t.name === 'create_objects');
    const item = create.inputSchema.properties.objects.items;
    expect(item.properties.type.enum).toContain('line');
    expect(item.properties.line.type).toBe('boolean');
  });
});
