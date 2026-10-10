import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS } from '../src/emoji-data';
import { searchEmoji } from '../src/ui/emoji-logic';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('emoji picker on a touch screen', () => {
  it('cancels pointerdown only for a mouse (WebKit drops the tap click otherwise) and holds the blur for every pointer', () => {
    const bar = read('../src/ui/edit-bar.ts');
    expect(bar).toMatch(/pointerType === 'mouse'\) event\.preventDefault\(\)/);
    expect(bar).toMatch(/addEventListener\('pointerdown'[\s\S]*holdBlur\(true\)/);
  });

  it('places popovers inside the visual viewport, which the soft keyboard shrinks', () => {
    const common = read('../src/ui/common.ts');
    expect(common).toMatch(/visualViewport\.offsetTop \+ window\.visualViewport\.height/);
    expect(common).toMatch(/height: visibleHeight\(\)/);
    expect(read('../src/ui/edit-bar.ts')).toMatch(/vv\.offsetTop \+ vv\.height/);
  });
});

describe('the catalogue has families', () => {
  const all = EMOJI_GROUPS.flatMap((g) => g.items);
  it('finds family emoji by the word family, each a ZWJ sequence', () => {
    const found = searchEmoji(all, 'family');
    expect(found.map((i) => i.e)).toContain('👨‍👩‍👧');
    expect(found.every((i) => i.e.includes('‍'))).toBe(true);
  });
});
