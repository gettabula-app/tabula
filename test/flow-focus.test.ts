import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { Flow } from '../src/flow';
import type { BaseObj, Step } from '../src/types';

/** The parts of BoardApp that Flow uses, with the camera calls recorded. */
function fakeApp(doc: Y.Doc, userId: string) {
  const store = new Store(doc);
  const calls = { flyTo: 0, flyToCenter: 0 };
  const app = {
    store,
    user: { id: userId, name: userId, color: '#000' },
    r: { invalidateAll() {}, setOverlay() {}, flyTo() { calls.flyTo++; }, flyToCenter() { calls.flyToCenter++; }, viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }) },
    zoom: 1,
    emit() {},
    participants: () => [],
  };
  const flow = new Flow(app as never);
  const announced: { step: Step; frame: unknown }[] = [];
  flow.onLocalStep = (step, frame) => announced.push({ step, frame });
  return { store, flow, calls, announced };
}

const frame = (id: string): BaseObj => ({ id, type: 'frame', x: 100, y: 200, w: 400, h: 300, rotation: 0, z: 'a0', name: id });

/** Two boards on one document, joined the way the relay joins them: every update reaches the other. */
function pair() {
  const docA = new Y.Doc(), docB = new Y.Doc();
  docA.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(docB, u, 'remote'));
  docB.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(docA, u, 'remote'));
  return { A: fakeApp(docA, 'ana'), B: fakeApp(docB, 'bo') };
}

const twoSteps = (A: ReturnType<typeof fakeApp>) => {
  A.store.transact(() => A.store.create(frame('f1')));
  A.flow.setSteps([
    { id: 's1', title: 'Write', instructions: '', mode: 'write', frameId: 'f1' },
    { id: 's2', title: 'Talk', instructions: '', mode: 'discuss' },
  ]);
};

describe('moving to a step', () => {
  it('flies the person who changed the step to its frame, and nobody else', async () => {
    const { A, B } = pair();
    await Promise.resolve();
    twoSteps(A);
    A.flow.goto(0);
    expect(B.flow.state().active).toBe(0);
    expect(A.calls.flyTo).toBe(1);
    expect(B.calls.flyTo).toBe(0);
    expect(B.calls.flyToCenter).toBe(0);
  });

  it('tells the others once, from the screen that changed the step, with the frame bounds', async () => {
    const { A, B } = pair();
    await Promise.resolve();
    twoSteps(A);
    A.flow.goto(0);
    expect(A.announced).toHaveLength(1);
    expect(A.announced[0].step.id).toBe('s1');
    expect(A.announced[0].frame).toEqual({ x: 100, y: 200, w: 400, h: 300 });
    expect(B.announced).toHaveLength(0);
  });

  it('does not fly or announce for a step without a frame', async () => {
    const { A, B } = pair();
    await Promise.resolve();
    twoSteps(A);
    A.flow.goto(1);
    expect(A.calls.flyTo).toBe(0);
    expect(A.announced).toHaveLength(0);
    expect(B.calls.flyTo).toBe(0);
  });

  it('does not fly or announce for a change that is not a step change', async () => {
    const { A } = pair();
    await Promise.resolve();
    twoSteps(A);
    A.flow.goto(0);
    A.flow.startTimer(60);
    A.flow.reveal();
    expect(A.calls.flyTo).toBe(1);
    expect(A.announced).toHaveLength(1);
  });

  it('flies again when the person changes the step again, and when they come back to it', async () => {
    const { A } = pair();
    await Promise.resolve();
    twoSteps(A);
    A.flow.goto(0);
    A.flow.goto(1);
    A.flow.goto(0);
    expect(A.calls.flyTo).toBe(2);
    expect(A.announced).toHaveLength(2);
  });

  it('does not move a person who loads a board that is already on a step', async () => {
    const doc = new Y.Doc();
    const first = fakeApp(doc, 'ana');
    twoSteps(first);
    first.flow.goto(0);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), 'remote');
    const late = fakeApp(copy, 'bo');
    await Promise.resolve();
    expect(late.flow.state().active).toBe(0);
    expect(late.calls.flyTo).toBe(0);
    expect(late.announced).toHaveLength(0);
  });
});

describe('a view written to the shared document', () => {
  it('moves nobody: the old bring-everyone behaviour is gone', async () => {
    const { A, B } = pair();
    await Promise.resolve();
    // What an old client wrote when it pressed "Bring everyone to my view".
    A.store.setFlow({ focus: { x: 900, y: 900, zoom: 2, ts: Date.now(), by: 'someone-else' } });
    expect(B.store.getFlow().focus).not.toBeNull();
    expect(A.calls.flyToCenter).toBe(0);
    expect(B.calls.flyToCenter).toBe(0);
    expect(B.calls.flyTo).toBe(0);
  });

  it('is not something Flow can write any more', () => {
    const { A } = pair();
    expect((A.flow as unknown as Record<string, unknown>).summon).toBeUndefined();
  });
});
