import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { frameInterior } from '../shared/layout-summary';
import { createHarness, until, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// TAB-379: get_board says where there is room, and create_objects can place objects itself. A 200-object board with frames, a hidden
// frame and a withheld private note; the layout must never name or expose what the reader may not see.
const h = createHarness({ accounts: true, settings: { MCP: 'on' } });
let owner: Account;
let board: string;
let token = '';

const box = (id: string, x: number, y: number, w = 192, h = 192, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', text: id, x, y, w, h, rotation: 0, z: 'a0', fill: '#FFE08A', ...extra });
const frame = (id: string, name: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({ id, type: 'frame', name, x, y, w, h, rotation: 0, z: 'a0', ...extra });
const hits = (a: Body, b: Body) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

beforeAll(async () => {
  await h.start();
  const workspaceOwner = await h.signInOwner();
  const team = await h.newTeam(workspaceOwner.cookie);
  owner = await h.joinTeam(workspaceOwner.cookie, team.id);
  board = await h.newBoard(owner.cookie);
  const editor = h.connect(board, owner.cookie);
  await editor.synced();
  editor.doc.transact(() => {
    const objects = editor.doc.getMap('objects');
    const put = (o: Record<string, any>) => objects.set(o.id, new Y.Map(Object.entries(o)));
    for (let i = 0; i < 150; i++) put(box(`s${i}`, (i % 15) * 220, Math.floor(i / 15) * 220));
    put(frame('f-room', 'Roadmap', 3600, 0, 900, 700));
    put(frame('f-tiny', 'Tiny', 3600, 800, 300, 200));
    put(frame('f-hidden', 'Secret plans', 3600, 1100, 600, 400, { hidden: true }));
    for (let i = 0; i < 30; i++) put(box(`x${i}`, 4800 + (i % 6) * 300, Math.floor(i / 6) * 300, 200, 200));
    put(box('f-room-note', 3624, 56, 192, 192, { parent: 'f-room' }));
    // a private note of a running session: withheld from the reader until it is revealed
    put(box('private-note', 1000, 5000, 192, 192, { privateStep: 'step-1', text: 'my secret' }));
    for (let i = 0; i < 12; i++) put(box(`k${i}`, 3624 + (i % 3) * 100, 806 + Math.floor(i / 3) * 40, 90, 30, { parent: 'f-tiny' }));
  }, 'local');
  await until(() => h.savedDoc(board).getMap('objects').has('k11'));
  editor.provider.destroy();
  token = (await h.newToken(owner.cookie, { name: 'layout', scope: 'write' })).token;
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

const getBoard = (args: Record<string, unknown> = {}) => h.tool(token, 'get_board', { boardId: board, ...args });

describe('get_board layout', () => {
  it('adds frames and free areas on the first page of a whole board, next to nextFree', async () => {
    const out = await getBoard();
    expect(out.error).toBeUndefined();
    expect(out.data.nextFree).toBeDefined();
    const { frames, free, occupied } = out.data.layout;
    expect(frames.map((f: Body) => f.id).sort()).toEqual(['f-room', 'f-tiny']);
    expect(frames.find((f: Body) => f.id === 'f-room')).toMatchObject({ name: 'Roadmap', x: 3600, y: 0, w: 900, h: 700, children: 1 });
    expect(frames.find((f: Body) => f.id === 'f-tiny').children).toBe(12);
    const wheres = free.map((a: Body) => a.where);
    expect(wheres).toContain('right of all content');
    expect(wheres).toContain('inside frame f-room');
    expect(wheres).not.toContain('inside frame f-tiny');
    expect(occupied.length).toBeGreaterThan(0);
  });

  it('every free area is clear of every object, including the private note and the hidden frame', async () => {
    const out = await getBoard({ limit: 500 });
    const objects = out.data.objects.filter((o: Body) => o.type !== 'connector' && o.w);
    const secret = { x: 1000, y: 5000, w: 192, h: 192 };
    const hiddenFrame = { x: 3600, y: 1100, w: 600, h: 400 };
    for (const area of out.data.layout.free) {
      for (const o of objects) {
        if (area.where === `inside frame ${o.id}`) continue;
        expect({ where: area.where, object: o.id, hit: hits(area, o) }).toMatchObject({ hit: false });
      }
      expect({ where: area.where, hit: hits(area, secret) }).toMatchObject({ hit: false });
      expect({ where: area.where, hit: hits(area, hiddenFrame) }).toMatchObject({ hit: false });
    }
  });

  it('counts the withheld note as space: the room below all content starts past it', async () => {
    const below = (await getBoard()).data.layout.free.find((a: Body) => a.where === 'below all content');
    expect(below.y).toBeGreaterThanOrEqual(5000 + 192);
  });

  it('never names the withheld note or lists a hidden frame', async () => {
    const out = await getBoard();
    const layout = JSON.stringify(out.data.layout);
    expect(layout).not.toContain('private-note');
    expect(layout).not.toContain('my secret');
    expect(layout).not.toContain('f-hidden');
    expect(layout).not.toContain('Secret plans');
  });

  it('is left out of later pages and of a frame or area read', async () => {
    const first = await getBoard({ limit: 10 });
    expect(first.data.layout).toBeDefined();
    expect(first.data.nextCursor).toBeTruthy();
    const second = await getBoard({ limit: 10, cursor: first.data.nextCursor });
    expect(second.data.layout).toBeUndefined();
    expect((await getBoard({ frameId: 'f-room' })).data.layout).toBeUndefined();
    expect((await getBoard({ bounds: { x: 0, y: 0, w: 500, h: 500 } })).data.layout).toBeUndefined();
  });
});

describe('create_objects without x and y', () => {
  const create = (objects: Body[]) => h.tool(token, 'create_objects', { boardId: board, objects });
  const read = async () => (await getBoard({ limit: 500 })).data.objects.filter((o: Body) => o.type !== 'connector' && o.w) as Body[];

  it('places repeated batches in free space, never on each other or on existing objects', async () => {
    const before = await read();
    const placed: Body[] = [];
    for (let round = 0; round < 3; round++) {
      const made = await create(Array.from({ length: 6 }, (_, i) => ({ type: 'sticky', text: `auto ${round}-${i}` })));
      expect(made.error).toBeUndefined();
      for (const c of made.data.created) {
        expect(typeof c.x).toBe('number');
        expect(typeof c.y).toBe('number');
        placed.push({ x: c.x, y: c.y, w: 192, h: 192, id: c.id });
      }
    }
    const overlapping = placed.flatMap((a, i) => placed.filter((b, j) => i < j && hits(a, b)).map((b) => [a.id, b.id]));
    expect(overlapping).toEqual([]);
    for (const a of placed) for (const o of before) expect({ id: a.id, over: o.id, hit: hits(a, o) }).toMatchObject({ hit: false });
    expect(hits(placed[0], { x: 1000, y: 5000, w: 192, h: 192 })).toBe(false);
  });

  it('places an object inside the frame it names, within its interior', async () => {
    const made = await create([{ type: 'sticky', text: 'inside', parent: 'f-room' }]);
    expect(made.error).toBeUndefined();
    const { x, y } = made.data.created[0];
    const interior = frameInterior({ x: 3600, y: 0, w: 900, h: 700 });
    expect(x).toBeGreaterThanOrEqual(interior.x);
    expect(y).toBeGreaterThanOrEqual(interior.y);
    expect(x + 192).toBeLessThanOrEqual(interior.x + interior.w);
    expect(y + 192).toBeLessThanOrEqual(interior.y + interior.h);
    expect(hits({ x, y, w: 192, h: 192 }, { x: 3624, y: 56, w: 192, h: 192 })).toBe(false);
  });

  it('places a frame and its children from one call, the children inside the new frame', async () => {
    const made = await create([
      { type: 'frame', ref: 'f', name: 'New area', w: 800, h: 500 },
      { type: 'sticky', text: 'a', parent: { ref: 'f' } },
      { type: 'sticky', text: 'b', parent: { ref: 'f' } },
    ]);
    expect(made.error).toBeUndefined();
    const [f, a, b] = made.data.created;
    const interior = frameInterior({ x: f.x, y: f.y, w: 800, h: 500 });
    for (const c of [a, b]) {
      expect(c.x).toBeGreaterThanOrEqual(interior.x);
      expect(c.y).toBeGreaterThanOrEqual(interior.y);
      expect(c.x + 192).toBeLessThanOrEqual(interior.x + interior.w);
      expect(c.y + 192).toBeLessThanOrEqual(interior.y + interior.h);
    }
    expect(hits({ ...a, w: 192, h: 192 }, { ...b, w: 192, h: 192 })).toBe(false);
  });

  it('refuses the whole call when the named frame has no room, and writes nothing', async () => {
    const before = (await read()).length;
    const refused = await create([{ type: 'sticky', text: 'outside call' }, { type: 'sticky', text: 'does not fit', parent: 'f-tiny' }]);
    expect(refused.error).toBe('invalid_input');
    expect(refused.text).toMatch(/no free room inside frame f-tiny/);
    expect((await read()).length).toBe(before);
  });

  it('keeps explicit positions as given, and mixes them with placed objects without overlap', async () => {
    const made = await create([
      { type: 'sticky', text: 'fixed', x: 90_000, y: 90_000 },
      { type: 'sticky', text: 'placed' },
    ]);
    expect(made.error).toBeUndefined();
    expect(made.data.created[0]).not.toHaveProperty('x');
    const got = (await getBoard({ limit: 500 })).data.objects.find((o: Body) => o.id === made.data.created[0].id);
    expect(got).toMatchObject({ x: 90_000, y: 90_000 });
    expect(hits({ ...made.data.created[1], w: 192, h: 192 }, { x: 90_000, y: 90_000, w: 192, h: 192 })).toBe(false);
  });

  it('needs both x and y or neither', async () => {
    for (const bad of [{ x: 10 }, { y: 10 }]) {
      const refused = await create([{ type: 'sticky', text: 'half', ...bad }]);
      expect(refused.error).toBe('invalid_input');
    }
  });

  it('still needs connector ends, and leaves use_template and nextFree as they were', async () => {
    expect((await create([{ type: 'connector' }])).error).toBe('invalid_input');
    expect((await getBoard()).data.nextFree).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });
});
