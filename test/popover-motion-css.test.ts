import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// Popovers ease in from the button that opened them (popover-in in styles.css). The motion is CSS, which a unit test cannot run,
// so this pins the rules it is made of: the keyframe, the animation and origin on .popover, and a reduced-motion block without a scale.

const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** The declarations of the first top-level rule that starts with `selector {` on its own line. */
const declarations = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('popover motion (src/styles.css)', () => {
  it('defines the popover-in keyframe from a faded, slightly smaller panel', () => {
    const line = css.slice(css.indexOf('@keyframes popover-in'), css.indexOf('\n', css.indexOf('@keyframes popover-in')));
    expect(line).toContain('from { opacity: 0; transform: scale(0.97); }');
    expect(line).toContain('to { opacity: 1; transform: none; }');
    expect(line).not.toMatch(/scale\(0\)/);
  });

  it('animates .popover with the ease-out token and grows it from the anchor origin', () => {
    const rule = declarations('.popover');
    expect(rule).toMatch(/animation: popover-in 160ms var\(--ease-out\)/);
    expect(rule).toContain('transform-origin: var(--pop-origin');
  });

  it('keeps only a short opacity fade under reduced motion, with no scale', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce) { .popover {');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toContain('animation: popover-fade 120ms var(--ease-out) both');
    expect(block).not.toContain('scale');
    expect(css).toContain('@keyframes popover-fade { from { opacity: 0; } to { opacity: 1; } }');
  });
});
