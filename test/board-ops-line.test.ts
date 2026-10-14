import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  OpsError, applyPlan, getObjectsDetail, isLine, objectTypeOf, planCreate, planUpdate, summariseBoard, summarise,
} from '../server/board-ops.mjs';

// Lines (docs/lines.md): a connector with line: true, both ends free and a straight route. Stored as a connector; read as a line.

const who = { createdBy: 'user-1', now: 1000 };

function create(d: Y.Doc, items: unknown[]) {
  const plan = planCreate(d, items, who);
  d.transact(() => applyPlan(d, plan), 'mcp:test');
  return plan.result as { created: { ref?: string; id: string; type: string }[]; refs: Record<string, string> };
}

function update(d: Y.Doc, updates: unknown[], now = 2000) {
  const plan = planUpdate(d, updates, { now });
  d.transact(() => applyPlan(d, plan), 'mcp:test');
  return plan.result;
}

function failure(fn: () => unknown): OpsError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof OpsError)) throw new Error('expected an OpsError');
  return caught;
}

/** The stored object as the board holds it, by id. */
function stored(d: Y.Doc, id: string): Record<string, unknown> {
  const m = d.getMap('objects').get(id) as Y.Map<unknown>;
  return { ...m.toJSON(), id };
}

function shapeAndLine(d: Y.Doc) {
  const made = create(d, [
    { type: 'shape', ref: 'box', x: 0, y: 0, w: 100, h: 100 },
    { type: 'line', ref: 'l', from: { x: 10, y: 10 }, to: { x: 200, y: 40 } },
  ]);
  return { shape: made.refs.box as string, line: made.refs.l as string };
}

describe('lines: create', () => {
  it('type line is stored as a connector with line: true and the line defaults', () => {
    const d = new Y.Doc();
    const made = create(d, [{ type: 'line', ref: 'l', from: { x: 1, y: 2 }, to: { x: 30, y: 4 } }]);
    expect(made.created[0].type).toBe('line');
    const o = stored(d, made.refs.l);
    expect(o).toMatchObject({
      type: 'connector', line: true, route: 'straight', startHead: 'none', endHead: 'none', strokeWidth: 2, dash: 'solid',
      from: { kind: 'free', x: 1, y: 2 }, to: { kind: 'free', x: 30, y: 4 },
    });
    expect(o.label).toBeUndefined();
  });

  it('connector with line: true is the same as the synonym, and keeps the given style', () => {
    const d = new Y.Doc();
    const made = create(d, [{
      type: 'connector', line: true, from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, stroke: '#112233', strokeWidth: 6, dash: 'dotted', startHead: 'arrow', endHead: 'circle',
    }]);
    expect(made.created[0].type).toBe('line');
    expect(stored(d, made.created[0].id)).toMatchObject({
      type: 'connector', line: true, route: 'straight', stroke: '#112233', strokeWidth: 6, dash: 'dotted', startHead: 'arrow', endHead: 'circle',
    });
  });

  it('a line can be drawn from a point to an object (a bound end) only as an ordinary connector', () => {
    const d = new Y.Doc();
    const { shape } = shapeAndLine(d);
    const err = failure(() => planCreate(d, [{ type: 'line', from: { id: shape }, to: { x: 0, y: 0 } }], who));
    expect(err.path).toBe('objects[0]');
    const err2 = failure(() => planCreate(d, [{ type: 'connector', line: true, from: { id: shape }, to: { x: 0, y: 0 } }], who));
    expect(err2.message).toMatch(/free ends/);
  });

  it('refuses a line with a ref end, a curved route, a label, a width on a plain connector, or a non-boolean line', () => {
    const d = new Y.Doc();
    expect(failure(() => planCreate(d, [{ type: 'line', from: { ref: 'x' }, to: { x: 0, y: 0 } }], who)).path).toBe('objects[0].from.ref');
    expect(failure(() => planCreate(d, [{ type: 'connector', line: true, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, route: 'curved' }], who)).path).toBe('objects[0].route');
    expect(failure(() => planCreate(d, [{ type: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, label: 'no' }], who)).path).toBe('objects[0].label');
    expect(failure(() => planCreate(d, [{ type: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, strokeWidth: 3 }], who)).path).toBe('objects[0].strokeWidth');
    expect(failure(() => planCreate(d, [{ type: 'connector', line: 'yes', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }], who)).path).toBe('objects[0].line');
    expect(failure(() => planCreate(d, [{ type: 'line', line: false, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }], who)).path).toBe('objects[0].line');
    expect(failure(() => planCreate(d, [{ type: 'line', from: { x: 0, y: 0 } }], who)).path).toBe('objects[0].to');
  });

  it('a plain connector keeps its own defaults and is not a line', () => {
    const d = new Y.Doc();
    const made = create(d, [{ type: 'connector', ref: 'c', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } }]);
    const o = stored(d, made.refs.c);
    expect(o.line).toBeUndefined();
    expect(o.route).toBe('elbow');
    expect(o.endHead).toBe('arrow');
    expect(objectTypeOf(o)).toBe('connector');
  });
});

describe('lines: read', () => {
  it('reads a line as type line with points, style and heads, and a connector as a connector', () => {
    const d = new Y.Doc();
    const made = create(d, [
      { type: 'line', ref: 'l', from: { x: 1, y: 2 }, to: { x: 30, y: 4 }, stroke: '#FF0000', dash: 'dashed', startHead: 'arrow', endHead: 'triangle' },
      { type: 'shape', ref: 'a', x: 0, y: 0, w: 10, h: 10 },
      { type: 'shape', ref: 'b', x: 50, y: 50, w: 10, h: 10 },
      { type: 'connector', from: { ref: 'a' }, to: { ref: 'b' } },
    ]);
    expect(made.refs.l).toBeDefined();
    const board = summariseBoard(d);
    const line = board.objects.find((o: { id: string }) => o.id === made.refs.l);
    expect(line).toEqual({
      id: made.refs.l, type: 'line', from: { x: 1, y: 2 }, to: { x: 30, y: 4 }, strokeWidth: 2, dash: 'dashed',
      startHead: 'arrow', endHead: 'triangle', stroke: '#FF0000',
    });
    const connector = board.objects.find((o: { type: string; from: { kind: string } }) => o.type === 'connector');
    expect(connector.from.kind).toBe('bound');
    expect(board.counts.byType).toMatchObject({ line: 1, connector: 1 });
  });

  it('filters by type: connector leaves lines out and line selects only lines', () => {
    const d = new Y.Doc();
    create(d, [
      { type: 'line', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } },
      { type: 'connector', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } },
    ]);
    expect(summariseBoard(d, { types: ['line'] }).objects.map((o: { type: string }) => o.type)).toEqual(['line']);
    expect(summariseBoard(d, { types: ['connector'] }).objects.map((o: { type: string }) => o.type)).toEqual(['connector']);
  });

  it('a stored connector with line but a bound end is read as a connector, never as a line', () => {
    const bad = { id: 'x', type: 'connector', line: true, route: 'straight', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'free', x: 1, y: 1 } };
    expect(isLine(bad)).toBe(false);
    expect(summarise(bad, 200).type).toBe('connector');
  });

  it('get_objects (detail) returns the line with the same type', () => {
    const d = new Y.Doc();
    const made = create(d, [{ type: 'line', ref: 'l', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }]);
    const detail = getObjectsDetail(d, [made.refs.l]);
    expect(JSON.stringify(detail)).toContain('"type":"line"');
  });
});

describe('lines: update', () => {
  it('changes stroke, strokeWidth, dash, heads and free points of a line and keeps it a line', () => {
    const d = new Y.Doc();
    const { line } = shapeAndLine(d);
    update(d, [{ id: line, stroke: '#0000FF', strokeWidth: 4, dash: 'dotted', startHead: 'bar', endHead: 'arrow', from: { x: 5, y: 5 }, to: { x: 6, y: 7 } }]);
    expect(stored(d, line)).toMatchObject({
      line: true, route: 'straight', stroke: '#0000FF', strokeWidth: 4, dash: 'dotted', startHead: 'bar', endHead: 'arrow',
      from: { kind: 'free', x: 5, y: 5 }, to: { kind: 'free', x: 6, y: 7 },
    });
  });

  it('a bound end clears line, and the object becomes a connector', () => {
    const d = new Y.Doc();
    const { shape, line } = shapeAndLine(d);
    update(d, [{ id: line, to: { id: shape, side: 'left' } }]);
    const o = stored(d, line);
    expect(o.line).toBeUndefined();
    expect(o.to).toEqual({ kind: 'bound', id: shape, anchor: 'left' });
    expect(objectTypeOf(o)).toBe('connector');
  });

  it('a curved or elbow route clears line; a straight route keeps it', () => {
    const d = new Y.Doc();
    const { line } = shapeAndLine(d);
    update(d, [{ id: line, route: 'straight' }]);
    expect(stored(d, line).line).toBe(true);
    update(d, [{ id: line, route: 'curved' }]);
    expect(stored(d, line).line).toBeUndefined();
    expect(stored(d, line).route).toBe('curved');
  });

  it('a plain connector refuses strokeWidth; a line accepts it', () => {
    const d = new Y.Doc();
    const made = create(d, [
      { type: 'connector', ref: 'c', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
    ]);
    expect(failure(() => planUpdate(d, [{ id: made.refs.c, strokeWidth: 3 }], { now: 1 })).message).toMatch(/field_not_allowed_for_type/);
  });

  it('refuses the line flag itself as an update field', () => {
    const d = new Y.Doc();
    const { line } = shapeAndLine(d);
    expect(failure(() => planUpdate(d, [{ id: line, line: false }], { now: 1 })).message).toMatch(/Unknown field/);
  });
});
