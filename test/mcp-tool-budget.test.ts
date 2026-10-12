import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' }, env: { ROOM_UNLOAD_MS: '1200' } });
let person: Account;
let boardId: string;
let writeToken: string;
let readToken: string;

// Target: 40 tools and 12 KB. Before retry ids, today's list was 47 tools and 42,356 bytes; the byte cap rounds up to +3%.
// Seven optional clientRequestId schemas add exactly 1,281 bytes.
// Limits may only go down. A new tool must remove or merge another, or lower the other limit.
const TOOL_COUNT_LIMIT = 47;
const TOOL_BYTES_LIMIT = 44_908;
// Explicit exceptions for definitions over 700 characters; TODO: remove each name when it is shortened. Empty today.
const LONG_DESCRIPTION_ALLOWLIST: string[] = [];

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  person = await h.joinTeam(workspaceOwner.cookie, team.id);
  boardId = await h.newBoard(person.cookie);
  writeToken = (await h.newToken(person.cookie, { scope: 'write', boardIds: [boardId], tracker: 'write' })).token;
  readToken = (await h.newToken(person.cookie, { scope: 'read', boardIds: [boardId], tracker: 'read' })).token;
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('MCP tool definition budget', () => {
  it('keeps the scoped tool list small and every definition usable', async () => {
    const listed = await h.call(writeToken, 'tools/list');
    const tools = listed.body.result.tools;
    expect(tools).toHaveLength(TOOL_COUNT_LIMIT);
    expect(tools.map((tool: { description: string }) => tool.description).join(' ')).not.toMatch(/cannot be undone|cannot undo/i);
    const initialized = await h.call(writeToken, 'initialize');
    expect(initialized.body.result.instructions.match(/cannot be undone with Ctrl\+Z/g)).toHaveLength(1);

    for (const tool of tools) {
      expect(tool.title.trim().length).toBeGreaterThan(0);
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.readOnlyHint).toBeDefined();
    }
    const tooLong = tools
      .filter((tool: { description: string }) => Array.from(tool.description).length > 700)
      .map((tool: { name: string }) => tool.name)
      .sort();
    expect(tooLong).toEqual([...LONG_DESCRIPTION_ALLOWLIST].sort());

    const definitions = tools.map(({ name, title, description, inputSchema, annotations }: Record<string, unknown>) => ({
      name, title, description, inputSchema, annotations,
    }));
    const definitionBytes = Buffer.byteLength(JSON.stringify(definitions), 'utf8');
    expect(definitionBytes).toBeLessThanOrEqual(TOOL_BYTES_LIMIT);

    const readTools = (await h.call(readToken, 'tools/list')).body.result.tools;
    const mutatingNames = tools.filter((tool: { annotations: { readOnlyHint: boolean } }) => !tool.annotations.readOnlyHint)
      .map((tool: { name: string }) => tool.name);
    const readNames = new Set(readTools.map((tool: { name: string }) => tool.name));
    expect(mutatingNames.filter((name: string) => readNames.has(name))).toEqual([]);
  });
});
