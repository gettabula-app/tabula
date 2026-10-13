import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { elementColumns } from '../src/tracker/ui/shell';

// The look of the tracker element on a board: the rules sit between element-look markers in tracker.css, use tokens only, and
// have a forced-colors edge. The column rule is the density the spec sets by element width.

const css = readFileSync(join(process.cwd(), 'src/tracker/ui/tracker.css'), 'utf8');
const block = css.slice(css.indexOf('/* element-look:start'), css.indexOf('/* element-look:end */'));

describe('tracker element look: CSS', () => {
  it('has the marked element block', () => {
    expect(block.length).toBeGreaterThan(1000);
    expect(block).toContain('.trk.trk-element .trk-element-header');
  });

  it('uses no colour literals (hex, rgb, hsl), only the CSS variables the tracker already uses', () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab)\s*\(/i);
    expect(block).not.toMatch(/:\s*(?:white|black|red|blue|green|gray|grey|silver|navy|teal)\s*[;}]/i);
  });

  it('draws the card edge in forced colours with CanvasText', () => {
    expect(block).toMatch(/@media \(forced-colors: active\) \{\s*\.trk\.trk-element\.trk-shell \{ border: 1px solid CanvasText;/);
  });

  it('uses the spec palette for the card and the header rule', () => {
    expect(block).toContain('border-radius: 12px');
    expect(block).toContain('color-mix(in srgb, var(--ink) 22%, var(--paper))');
    expect(block).toContain('border-bottom: 1px solid var(--tray-line)');
    expect(block).toContain('font: 400 16px/1.2 var(--font-serif)');
  });

  it('no longer carries the old full-screen text button in the frame', () => {
    expect(css).not.toContain('.trk-frame-expand');
  });
});

describe('tracker element look: columns by element width', () => {
  it('keeps key and priority from 560px, drops them under 560px, and drops the avatar under 420px', () => {
    expect(elementColumns(720)).toEqual(['state', 'key', 'title', 'assignee', 'priority']);
    expect(elementColumns(560)).toEqual(['state', 'key', 'title', 'assignee', 'priority']);
    expect(elementColumns(559)).toEqual(['state', 'title', 'assignee']);
    expect(elementColumns(480)).toEqual(['state', 'title', 'assignee']);
    expect(elementColumns(420)).toEqual(['state', 'title', 'assignee']);
    expect(elementColumns(419)).toEqual(['state', 'title']);
    expect(elementColumns(360)).toEqual(['state', 'title']);
  });
});
