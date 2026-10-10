import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('emoji picker styling', () => {
  it('uses theme tokens instead of hard-coded colours in its new CSS', () => {
    const css = [
      readFileSync(new URL('../src/ui/edit-bar.css', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/ui/emoji-picker.css', import.meta.url), 'utf8'),
    ].join('\n');
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(|\b(?:black|white|red|green|blue|gray|grey|silver|maroon|navy|olive|purple|fuchsia|teal|aqua|lime|yellow|orange|pink)\b/i);
  });
});
