import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
let boardId: string;
let writeToken: string;

beforeAll(async () => {
  await h.start();
  const owner = await h.signInOwner();
  boardId = await h.newBoard(owner.cookie);
  writeToken = (await h.newToken(owner.cookie, { scope: 'write', boardIds: [boardId] })).token;
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('MCP code blocks', () => {
  it('lists the code type in the create and update schemas', async () => {
    const tools = (await h.call(writeToken, 'tools/list')).body.result.tools as { name: string; inputSchema: any }[];
    const create = tools.find((t) => t.name === 'create_objects')!;
    const item = create.inputSchema.properties.objects.items;
    expect(item.properties.type.enum).toContain('code');
    expect(item.properties.lang).toBeDefined();
    const update = tools.find((t) => t.name === 'update_objects')!;
    expect(update.inputSchema.properties.updates.items.properties.lang).toBeDefined();
  });

  it('creates, reads, updates and exports a code block; an alias is stored as the id and an unknown language is refused', async () => {
    const made = await h.tool(writeToken, 'create_objects', {
      boardId, objects: [{ type: 'code', text: 'def f():\n\treturn "```"', lang: 'py', title: 'Demo', lines: true, x: 0, y: 0 }],
    });
    expect(made.error).toBeUndefined();
    const id = made.data.created[0].id as string;

    const got = await h.tool(writeToken, 'get_objects', { boardId, ids: [id] });
    expect(got.error).toBeUndefined();
    expect(got.data.objects[0]).toMatchObject({ type: 'code', lang: 'python', title: 'Demo', lines: true, text: 'def f():\n\treturn "```"' });

    const changed = await h.tool(writeToken, 'update_objects', { boardId, updates: [{ id, lang: 'typescript', wrap: true, text: 'const a = 1;' }] });
    expect(changed.error).toBeUndefined();
    const after = await h.tool(writeToken, 'get_objects', { boardId, ids: [id] });
    expect(after.data.objects[0]).toMatchObject({ lang: 'ts', wrap: true, text: 'const a = 1;' });

    const exported = await h.tool(writeToken, 'export', { boardId, format: 'markdown' });
    expect(exported.data.content).toContain('```ts\nconst a = 1;\n```');

    const bad = await h.tool(writeToken, 'create_objects', { boardId, objects: [{ type: 'code', text: 'x', lang: 'klingon', x: 0, y: 0 }] });
    expect(bad.error).toBe('invalid_input');
    const badUpdate = await h.tool(writeToken, 'update_objects', { boardId, updates: [{ id, lang: 'klingon' }] });
    expect(badUpdate.error).toBe('invalid_input');
    const other = await h.tool(writeToken, 'create_objects', { boardId, objects: [{ type: 'sticky', text: 'x', lang: 'ts', x: 0, y: 0 }] });
    expect(other.error).toBe('invalid_input');
  });
});
