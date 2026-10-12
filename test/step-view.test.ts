import { describe, expect, it } from 'vitest';
import { Builder, TEMPLATES } from '../src/templates';
import { HEADING_REACH, stepViewBounds } from '../src/step-view';
import type { BaseObj, Obj } from '../src/types';

// APP-ISSUES 3: after Go to, a template's title (loose text above the step's frame) sat under the board-name tray. The camera goes to
// the frame together with the heading just above it.

const frame = { id: 'f', type: 'frame', x: 100, y: 500, w: 400, h: 300, rotation: 0, z: 'a0' } as BaseObj;
const text = (id: string, x: number, bottom: number, extra: Partial<BaseObj> = {}) =>
  ({ id, type: 'text', x, y: bottom - 40, w: 200, h: 40, rotation: 0, z: 'a1', ...extra }) as BaseObj;

describe('what the camera takes in when it goes to a step', () => {
  it('is the frame alone when nothing is above it', () => {
    expect(stepViewBounds(frame, [frame])).toEqual({ x: 100, y: 500, w: 400, h: 300 });
  });

  it('takes in the loose text just above the frame that overlaps it sideways', () => {
    const b = stepViewBounds(frame, [frame, text('t', 100, 450)]);
    expect(b).toMatchObject({ x: 100, y: 410, h: 390 });
  });

  it('leaves out text that is too far above, beside, inside another frame, or not text', () => {
    const far = text('far', 100, 500 - HEADING_REACH - 1);
    const beside = text('beside', 600, 450);
    const child = text('child', 100, 450, { parent: 'other' });
    const note = { ...text('note', 100, 450), type: 'sticky' } as Obj;
    expect(stepViewBounds(frame, [frame, far, beside, child, note])).toEqual({ x: 100, y: 500, w: 400, h: 300 });
  });

  it('reaches the real templates\' title above their outer frame', () => {
    const host = { user: { id: 'u1' }, store: { getMeta: () => ({ bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' }) } };
    const def = TEMPLATES.find((t) => t.id === 'start-stop-continue') ?? TEMPLATES.find((t) => /Start/.test(t.name))!;
    const b = new Builder(host, 0, 0);
    def.build(b);
    const objs = b.objs as BaseObj[];
    const title = objs.find((o) => o.type === 'text' && (o as { text?: string }).text === 'Start / Stop / Continue')!;
    const outer = objs.find((o) => o.id === b.steps[0].frameId)!;
    const view = stepViewBounds(outer, objs);
    expect(view.y).toBeLessThanOrEqual(title.y);
    expect(view.y + view.h).toBe(outer.y + outer.h);
  });
});
