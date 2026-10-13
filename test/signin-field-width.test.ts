import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sign-in page field', () => {
  it('fills the form like the button below it (the page does not load the app stylesheet that sets .input to 100%)', () => {
    const css = readFileSync('src/ui/signin.css', 'utf8');
    const rule = /\.signin \.input \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width: 100%');
    expect(rule).toContain('box-sizing: border-box');
  });
});
