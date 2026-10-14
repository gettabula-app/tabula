import { describe, expect, it } from 'vitest';
import { thumbnailSvg } from '../src/template-thumb';
import { validateContent } from '../src/custom-templates';
import type { ConnectorObj, Obj } from '../src/types';

// A line is a connector with free ends and `line: true`: a template thumbnail draws it, and a saved template keeps the flag.
const line = (over: Partial<ConnectorObj> = {}): ConnectorObj => ({
  id: 'ln', type: 'connector', z: 'a0', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 300, y: 120 },
  route: 'straight', startHead: 'none', endHead: 'none', strokeWidth: 2, line: true, ...over,
});

describe('a line in a thumbnail and a template', () => {
  it('is drawn in a template thumbnail as a stroked path with no arrowhead', () => {
    const svg = thumbnailSvg([line() as Obj]);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('marker-end');
  });

  it('keeps line:true through the client template check', () => {
    const content = validateContent({ objects: [line()], steps: [], bounds: { x: 0, y: 0, w: 300, h: 120 }, labels: [] }) as { objects: ConnectorObj[] };
    expect(content.objects[0].line).toBe(true);
  });
});
