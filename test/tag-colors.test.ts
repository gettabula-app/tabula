import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

const TAGS = ['yellow', 'blue', 'green', 'red'] as const;

describe('status tag colours', () => {
  it('keeps text at 4.5:1 or higher on every tag background in every theme', () => {
    for (const theme of THEMES) {
      for (const tag of TAGS) {
        expect(
          contrast(theme.vars[`--on-tag-${tag}`], theme.vars[`--tag-${tag}`]),
          `${theme.id} ${tag}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses the approved warm pastel pairs in the default theme', () => {
    const theme = THEMES.find(({ id }) => id === 'default');
    expect(theme).toBeDefined();
    expect(TAGS.map((tag) => theme!.vars[`--tag-${tag}`])).toEqual(['#FBF3DB', '#E1F3FE', '#EDF3EC', '#FDEBEC']);
    expect(TAGS.map((tag) => theme!.vars[`--on-tag-${tag}`])).toEqual(['#956400', '#1F6C9F', '#346538', '#9F2F2D']);
  });

  it('keeps the template label on its tag pair, not the page label grey', () => {
    const css = readFileSync(new URL('../src/ui/home.css', import.meta.url), 'utf8');
    for (const tag of TAGS) {
      expect(css).toContain(`.tpl-label.tag-${tag} { background: var(--tag-${tag}); color: var(--on-tag-${tag}); }`);
    }
  });
});
