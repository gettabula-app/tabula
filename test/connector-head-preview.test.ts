import { describe, expect, it } from 'vitest';
import { connectorHeadPreviewSvg, headMarkup, HEADS } from '../src/shapes';

const PREVIEW_COLOR = 'var(--tray-text, #E9EDF2)';
const PREVIEW_WIDTH = 40;
const PREVIEW_EDGE = 4;
const PREVIEW_Y = 8;
const PREVIEW_STROKE = 1.5;

describe('connector head previews', () => {
  it('builds every HEADS preview, including none, from the renderer head geometry', () => {
    expect(HEADS.map(({ head }) => head)).toEqual([
      'none', 'arrow', 'open', 'triangle', 'diamond', 'diamond-open', 'circle', 'bar', 'crow-many', 'crow-one',
    ]);

    for (const { head } of HEADS) {
      for (const end of ['start', 'end'] as const) {
        const start = end === 'start';
        const tip = { x: start ? PREVIEW_EDGE : PREVIEW_WIDTH - PREVIEW_EDGE, y: PREVIEW_Y };
        const dir = { x: start ? -1 : 1, y: 0 };
        const rendered = headMarkup(head, tip, dir, PREVIEW_COLOR, PREVIEW_STROKE);
        const preview = connectorHeadPreviewSvg(head, end);
        const sharedGeometry = rendered.svg
          .replaceAll(PREVIEW_COLOR, 'currentColor')
          .replaceAll('var(--paper, #FFFFFF)', 'var(--tray, #18212B)');
        const lineStart = start ? tip.x + rendered.inset : PREVIEW_EDGE;
        const lineEnd = start ? PREVIEW_WIDTH - PREVIEW_EDGE : tip.x - rendered.inset;

        expect(preview, `${head} ${end}`).toContain('aria-hidden="true"');
        expect(preview, `${head} ${end} line`).toContain(`d="M${lineStart} ${PREVIEW_Y}H${lineEnd}"`);
        expect(rendered.svg.length > 0, `${head} renderer geometry`).toBe(head !== 'none');
        expect(preview, `${head} ${end} shared geometry`).toContain(sharedGeometry);
      }
    }
  });
});
